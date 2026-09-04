/* Platform-owned Spine 4.2 portrait renderer.
 *
 * User bundles provide data only (skeleton/atlas/textures).  Executable code is
 * the pinned same-origin official runtime in assets/vendor/spine-webgl.js.
 */

// The handoff assets identify themselves as Spine 4.2.0/4.2.33, but their
// binary layout includes referenceScale, which the early npm runtime 4.2.33
// does not read.  The pinned official 4.2.119 runtime is backward-compatible
// with those 4.2 exports and is verified against the real handoff bundle.
const RUNTIME_VERSION = '4.2.119';
const RUNTIME_URL = `/app/assets/vendor/spine-webgl.js?v=${RUNTIME_VERSION}`;
let runtimePromise = null;

function runtimeReady() {
  return !!(window.spine?.SpineCanvas && window.spine?.Skeleton && window.spine?.SkeletonBinary);
}

function loadSpineRuntime() {
  if (runtimeReady()) return Promise.resolve(window.spine);
  if (runtimePromise) return runtimePromise;
  runtimePromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-homer-spine-runtime="${RUNTIME_VERSION}"]`);
    const finish = () => runtimeReady()
      ? resolve(window.spine)
      : reject(new Error('Spine 4.2.119 runtime API is unavailable'));
    if (existing) {
      if (existing.dataset.loaded === '1') finish();
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', () => reject(new Error('Spine runtime failed to load')), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = RUNTIME_URL;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    script.dataset.homerSpineRuntime = RUNTIME_VERSION;
    script.addEventListener('load', () => { script.dataset.loaded = '1'; finish(); }, { once: true });
    script.addEventListener('error', () => reject(new Error('Spine runtime failed to load')), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

function sameOriginAssetUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.href);
    if (url.origin !== window.location.origin) return '';
    if (!url.pathname.startsWith('/media-cache/card-assets/ready/')) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function spineManifestOf(asset) {
  const metadata = asset && typeof asset === 'object' && asset.metadata && typeof asset.metadata === 'object'
    ? asset.metadata : {};
  const source = metadata.spine && typeof metadata.spine === 'object' ? metadata.spine : null;
  if (!source) return null;
  const manifestUrl = sameOriginAssetUrl(source.manifest_url);
  const skeletonUrl = sameOriginAssetUrl(source.skeleton_url);
  const atlasUrl = sameOriginAssetUrl(source.atlas_url);
  const textures = (Array.isArray(source.textures) ? source.textures : [])
    .map(sameOriginAssetUrl).filter(Boolean).slice(0, 96);
  const previewTexture = sameOriginAssetUrl(source.preview_texture) || textures[0] || '';
  const runtimeVersion = String(source.runtime_major_minor || '');
  if (runtimeVersion && runtimeVersion !== '4.2') return null;
  if (!manifestUrl && !(skeletonUrl && atlasUrl)) return null;
  return {
    manifest_url: manifestUrl,
    skeleton_url: skeletonUrl,
    atlas_url: atlasUrl,
    textures,
    preview_texture: previewTexture,
    binary: source.binary !== false,
    spine_version: String(source.spine_version || ''),
    runtime_major_minor: runtimeVersion || '4.2',
  };
}

function pickIdleAnimation(skeletonData) {
  const names = (skeletonData?.animations || []).map((item) => item?.name).filter(Boolean);
  const preferred = ['idle', 'idle_01', 'wait', 'stand', 'loop', 'start_idle'];
  for (const wanted of preferred) {
    const match = names.find((name) => String(name).toLowerCase() === wanted);
    if (match) return match;
  }
  return names.find((name) => /idle|wait|stand|loop/i.test(name)) || names[0] || '';
}

function errorText(value) {
  if (value instanceof Error) return value.message;
  try { return JSON.stringify(value); } catch { return String(value || 'unknown error'); }
}

export class SpinePortraitLayer {
  constructor(stageElement) {
    this.stage = stageElement || null;
    this.canvas = null;
    this.spineCanvas = null;
    this.renderState = null;
    this.currentAsset = null;
    this.currentSkeletonUrl = '';
    this.fetchController = null;
    this.epoch = 0;
    this.disposed = false;
    this.hidden = false;
    this.contextLost = false;
    this.rendererContextInvalid = false;
    this.skipGpuDispose = false;
    this.resizeObserver = null;
    this.onVisibilityChange = () => this._syncOpacity();
    this.onContextLost = (event) => this._handleContextLost(event);
    this.onContextRestored = () => this._handleContextRestored();
    document.addEventListener('visibilitychange', this.onVisibilityChange, { passive: true });
  }

  _ensureCanvas() {
    if (this.canvas || !this.stage || this.disposed) return this.canvas;
    const canvas = document.createElement('canvas');
    canvas.className = 'ce-portrait-spine';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = [
      'position:absolute', 'inset:0', 'width:100%', 'height:100%',
      'z-index:1', 'pointer-events:none', 'opacity:0',
      'transition:opacity .35s ease',
    ].join(';');
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);
    this.stage.appendChild(canvas);
    this.canvas = canvas;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this._resizeRenderer());
      this.resizeObserver.observe(this.stage);
    }
    return canvas;
  }

  async _resolveManifest(manifest, signal) {
    if (manifest.skeleton_url && manifest.atlas_url) return manifest;
    if (!manifest.manifest_url) throw new Error('Spine manifest is incomplete');
    const response = await fetch(manifest.manifest_url, {
      credentials: 'same-origin', cache: 'force-cache', signal,
    });
    if (!response.ok) throw new Error(`Spine manifest fetch failed (${response.status})`);
    const payload = await response.json();
    const normalized = spineManifestOf({ metadata: { spine: payload } });
    if (!normalized?.skeleton_url || !normalized?.atlas_url) throw new Error('Spine manifest URLs are invalid');
    return normalized;
  }

  async show(asset) {
    const manifest = spineManifestOf(asset);
    this.currentAsset = asset || null;
    const token = ++this.epoch;
    this.fetchController?.abort();
    this.fetchController = new AbortController();
    if (!manifest || this.disposed || !this.stage) {
      this._disposeRenderer();
      this.currentSkeletonUrl = '';
      this._fallback(asset);
      return false;
    }
    try {
      const resolved = await this._resolveManifest(manifest, this.fetchController.signal);
      if (!this._isCurrent(token)) return false;
      if (resolved.skeleton_url === this.currentSkeletonUrl && this.spineCanvas && !this.contextLost) {
        this._hideFallback();
        this._syncOpacity();
        return true;
      }
      const spine = await loadSpineRuntime();
      if (!this._isCurrent(token)) return false;
      this._startRenderer(spine, resolved, asset, token);
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || !this._isCurrent(token)) return false;
      console.warn('[spine-portrait] falling back to a static texture:', errorText(error));
      this._failAsset(asset, token);
      return false;
    }
  }

  _isCurrent(token) {
    return !this.disposed && token === this.epoch;
  }

  _startRenderer(spine, manifest, asset, token) {
    const canvas = this._ensureCanvas();
    if (!canvas) throw new Error('Spine canvas host is unavailable');
    this._disposeRenderer();
    this.contextLost = false;
    const atlasFile = manifest.atlas_url;
    const skeletonFile = manifest.skeleton_url;
    const binary = manifest.binary !== false && !/\.json(?:$|\?)/i.test(skeletonFile);
    const owner = this;
    const app = {
      loadAssets(canvasApp) {
        canvasApp.assetManager.loadTextureAtlas(atlasFile);
        if (binary) canvasApp.assetManager.loadBinary(skeletonFile);
        else canvasApp.assetManager.loadJson(skeletonFile);
      },
      initialize(canvasApp) {
        if (!owner._isCurrent(token)) return;
        try {
          const atlas = canvasApp.assetManager.require(atlasFile);
          const attachmentLoader = new spine.AtlasAttachmentLoader(atlas);
          const skeletonLoader = binary
            ? new spine.SkeletonBinary(attachmentLoader)
            : new spine.SkeletonJson(attachmentLoader);
          const skeletonData = skeletonLoader.readSkeletonData(canvasApp.assetManager.require(skeletonFile));
          const skeleton = new spine.Skeleton(skeletonData);
          const stateData = new spine.AnimationStateData(skeletonData);
          stateData.defaultMix = 0.2;
          const state = new spine.AnimationState(stateData);
          const animation = pickIdleAnimation(skeletonData);
          if (animation) state.setAnimation(0, animation, true);
          owner.renderState = {
            skeleton, state,
            offset: new spine.Vector2(),
            size: new spine.Vector2(),
          };
          owner.currentSkeletonUrl = skeletonFile;
          owner._hideFallback();
          owner._resizeRenderer();
          owner._syncOpacity();
        } catch (error) {
          console.warn('[spine-portrait] skeleton initialization failed:', errorText(error));
          owner._failAsset(asset, token);
        }
      },
      update(canvasApp, delta) {
        if (!owner._isCurrent(token) || owner.hidden || owner.contextLost || document.hidden) return;
        const current = owner.renderState;
        if (!current) return;
        current.state.update(Math.min(Math.max(Number(delta) || 0, 0), 0.1));
        current.state.apply(current.skeleton);
        try {
          current.skeleton.updateWorldTransform(spine.Physics?.update);
        } catch {
          current.skeleton.updateWorldTransform();
        }
      },
      render(canvasApp) {
        if (!owner._isCurrent(token) || owner.hidden || owner.contextLost || document.hidden) return;
        const current = owner.renderState;
        if (!current) return;
        try {
          const renderer = canvasApp.renderer;
          renderer.resize(spine.ResizeMode.Expand);
          current.skeleton.getBounds(current.offset, current.size, []);
          const camera = renderer.camera;
          if (camera && current.size.x > 0 && current.size.y > 0) {
            camera.position.x = current.offset.x + current.size.x / 2;
            camera.position.y = current.offset.y + current.size.y / 2;
            const height = Math.max(1, camera.viewportHeight || canvas.clientHeight || 1);
            const width = Math.max(1, camera.viewportWidth || canvas.clientWidth || 1);
            camera.zoom = Math.max((current.size.y * 1.12) / height, (current.size.x * 1.12) / width);
            camera.update();
          }
          canvasApp.clear(0, 0, 0, 0);
          renderer.begin();
          renderer.drawSkeleton(current.skeleton, false);
          renderer.end();
        } catch (error) {
          console.warn('[spine-portrait] draw failed:', errorText(error));
        }
      },
      error(canvasApp, error) {
        if (!owner._isCurrent(token)) return;
        console.warn('[spine-portrait] asset loading failed:', errorText(error));
        owner._failAsset(asset, token);
      },
      dispose(canvasApp) {
        if (owner.skipGpuDispose) return;
        try { canvasApp.assetManager?.dispose?.(); } catch { /* ignore */ }
        try { canvasApp.renderer?.dispose?.(); } catch { /* ignore */ }
      },
    };
    this.spineCanvas = new spine.SpineCanvas(canvas, {
      app, pathPrefix: '', webglConfig: { alpha: true, premultipliedAlpha: false, antialias: true },
    });
  }

  _resizeRenderer() {
    try {
      if (this.spineCanvas && window.spine?.ResizeMode) {
        this.spineCanvas.renderer.resize(window.spine.ResizeMode.Expand);
      }
    } catch { /* resize will retry on the next render frame */ }
  }

  _fallback(asset) {
    const manifest = spineManifestOf(asset) || {};
    const rawSpine = asset?.metadata?.spine && typeof asset.metadata.spine === 'object'
      ? asset.metadata.spine : {};
    const rawTexture = sameOriginAssetUrl(rawSpine.preview_texture)
      || (Array.isArray(rawSpine.textures) ? rawSpine.textures.map(sameOriginAssetUrl).find(Boolean) : '');
    const texture = manifest.preview_texture || manifest.textures?.[0] || rawTexture || '';
    const image = this.stage?.querySelector('.ce-portrait');
    if (image && texture) {
      image.src = texture;
      image.alt = asset?.name || '';
      image.classList.add('is-visible');
    }
    if (this.canvas) this.canvas.style.opacity = '0';
  }

  _hideFallback() {
    this.stage?.querySelector('.ce-portrait')?.classList.remove('is-visible');
  }

  _failAsset(asset, token) {
    if (!this._isCurrent(token)) return;
    this._disposeRenderer();
    this.currentSkeletonUrl = '';
    this._fallback(asset);
  }

  _syncOpacity() {
    if (!this.canvas) return;
    const visible = !!this.renderState && !this.hidden && !this.contextLost && !document.hidden;
    this.canvas.style.opacity = visible ? '1' : '0';
  }

  _handleContextLost(event) {
    event.preventDefault();
    this.contextLost = true;
    this.rendererContextInvalid = true;
    this._fallback(this.currentAsset);
  }

  _handleContextRestored() {
    if (this.disposed || !this.currentAsset) return;
    this.contextLost = false;
    this.currentSkeletonUrl = '';
    void this.show(this.currentAsset);
  }

  hide() {
    this.epoch += 1;
    this.fetchController?.abort();
    this.fetchController = null;
    this._disposeRenderer();
    this.currentAsset = null;
    this.currentSkeletonUrl = '';
    if (this.canvas) this.canvas.style.opacity = '0';
  }

  setVisible(visible) {
    this.hidden = !visible;
    this._syncOpacity();
  }

  toggleVisible() {
    this.setVisible(this.hidden);
    return !this.hidden;
  }

  get visible() {
    return !this.hidden;
  }

  _disposeRenderer() {
    if (this.spineCanvas) {
      this.skipGpuDispose = this.rendererContextInvalid;
      try { this.spineCanvas.dispose(); } catch { /* ignore */ }
      this.skipGpuDispose = false;
    }
    this.spineCanvas = null;
    this.renderState = null;
    this.rendererContextInvalid = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.fetchController?.abort();
    this.fetchController = null;
    this._disposeRenderer();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
      this.canvas.remove();
    }
    this.canvas = null;
    this.stage = null;
    this.currentAsset = null;
    this.currentSkeletonUrl = '';
  }
}
