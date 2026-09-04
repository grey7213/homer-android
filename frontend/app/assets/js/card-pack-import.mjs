const PACK_EXTENSIONS = Object.freeze(['.zip', '.tgp', '.tpg']);
const MAX_PACK_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 512;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 768 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS = 200;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BGM_BYTES = 30 * 1024 * 1024;

const MIME_BY_EXT = Object.freeze({
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  zip: 'application/zip',
});

const KIND_ALIASES = Object.freeze({
  bgm: 'bgm', audio: 'bgm', music: 'bgm', soundtrack: 'bgm', 音乐: 'bgm',
  portrait: 'portrait', character: 'portrait', sprite: 'portrait', standing: 'portrait', 立绘: 'portrait',
  background: 'background', bg: 'background', scene: 'background', backdrop: 'background', 背景: 'background', 场景: 'background',
  spine: 'spine', skeleton: 'spine', 骨骼: 'spine', 动画立绘: 'spine',
});

const GENERIC_HINTS = new Set([
  'asset', 'assets', 'media', 'bgm', 'audio', 'music', 'soundtrack', 'portrait', 'portraits',
  'character', 'characters', 'sprite', 'sprites', 'background', 'backgrounds', 'bg', 'scene',
  'scenes', 'image', 'images', 'img', 'default', 'main', 'theme', 'track', '立绘', '背景', '音乐', '场景',
]);

const EMOTION_HINTS = new Set([
  'neutral', 'normal', 'default', 'happy', 'smile', 'sad', 'angry', 'surprise', 'shy', 'cry',
  'calm', 'serious', 'sleep', 'love', '开心', '微笑', '悲伤', '生气', '惊讶', '害羞', '哭泣', '平静', '严肃', '默认', '常态',
]);

export function isCardPackFilename(name) {
  const lower = String(name || '').trim().toLowerCase();
  return PACK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export async function parseCardPack(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('没有读取到资源包文件');
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error('资源包是空文件');
  if (file.size > (options.maxPackBytes || MAX_PACK_BYTES)) throw new Error('资源包超过 512MB，建议拆分素材后重试');
  const zipLibrary = options.zipLibrary || globalThis.JSZip;
  if (!zipLibrary?.loadAsync) throw new Error('卡片包解压组件未加载，请联系站点技术人员检查 JSZip');

  let zip;
  try {
    zip = await zipLibrary.loadAsync(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(`文件不是有效的 ZIP/TGP/TPG 资源包：${error?.message || error}`);
  }

  const files = listFiles(zip);
  validateArchiveEntries(files, options);
  const manifestEntry = findPreferredFile(files, ['manifest.json', 'tgp.json', 'plugin.json', 'package.json'], () => false, false);
  const manifest = manifestEntry ? await readJson(manifestEntry.entry, manifestEntry.path) : {};

  const cardPath = firstString(
    manifest.card,
    manifest.character_card,
    manifest.character,
    manifest.files?.card,
  );
  const cardEntry = cardPath
    ? findFile(files, cardPath)
    : findPreferredFile(files, ['card.json', 'character.json', '角色卡.json'], isAuxiliaryJson);
  if (!cardEntry) throw new Error('资源包内未找到角色卡 JSON（建议命名为 card.json，或在 manifest.card 中指定）');
  const card = await readJson(cardEntry.entry, cardEntry.path);

  const worldbookEntry = findOptionalJson(files, manifest, ['worldbook', 'lorebook', 'character_book'], ['worldbook.json', 'lorebook.json', '世界书.json']);
  if (worldbookEntry) mergeWorldbook(card, await readJson(worldbookEntry.entry, worldbookEntry.path));
  const regexEntry = findOptionalJson(files, manifest, ['regex', 'regex_scripts', 'scripts'], ['regex.json', 'regex_scripts.json', '正则.json']);
  if (regexEntry) mergeRegexScripts(card, await readJson(regexEntry.entry, regexEntry.path));

  const declaredAssets = arrayValue(manifest.assets, manifest.media, manifest.resources);
  const assets = declaredAssets.length
    ? await readDeclaredAssets(files, declaredAssets)
    : await inferAssets(files, new Set([cardEntry.path, manifestEntry?.path, worldbookEntry?.path, regexEntry?.path].filter(Boolean)));
  if (assets.length > MAX_ASSETS) throw new Error(`资源数量 ${assets.length} 超过单卡上限 ${MAX_ASSETS}`);

  return {
    manifest,
    card,
    assets: assets.map((asset, index) => ({ ...asset, pack_index: index })),
    filename: String(file.name || ''),
    card_name: cardName(card),
    worldbook_source: worldbookEntry?.path || '',
    regex_source: regexEntry?.path || '',
  };
}

export function buildCardPackMediaUpdate({ importedApp, uploadedAssets, sourceAssets, mediaDraftId, idFactory }) {
  if (!importedApp || typeof importedApp !== 'object' || !String(importedApp.id || '').trim()) {
    throw new Error('基础角色卡导入结果缺少卡片 ID');
  }
  const createId = typeof idFactory === 'function'
    ? idFactory
    : (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const uploaded = Array.isArray(uploadedAssets) ? uploadedAssets : [];
  const sources = Array.isArray(sourceAssets) ? sourceAssets : [];
  const sourceFor = (asset) => sources.find((source) => source.pack_index === asset.pack_index)
    || sources.find((source) => source.file?.name === asset.filename)
    || {};
  const uploadedForSource = (source) => uploaded.find((asset) => asset.pack_index === source.pack_index)
    || uploaded.find((asset) => asset.filename === source.file?.name);
  const remappedAssetIds = new Map();
  for (const source of sources) {
    const previousId = String(source.source_asset_id || '').trim();
    const uploadedAsset = uploadedForSource(source);
    if (previousId && uploadedAsset?.id) remappedAssetIds.set(previousId, String(uploadedAsset.id));
  }
  const remapAssetId = (value) => remappedAssetIds.get(String(value || '').trim()) || String(value || '').trim();
  const remapAssetMap = (value) => Object.fromEntries(
    Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .map(([key, assetId]) => [key, remapAssetId(assetId)])
      .filter(([, assetId]) => !!assetId),
  );

  const mediaAssets = uploaded.map((asset) => {
    const source = sourceFor(asset);
    const metadata = { ...(asset.metadata && typeof asset.metadata === 'object' ? asset.metadata : {}) };
    if (source.emotion) metadata.emotion = String(source.emotion).slice(0, 40);
    if (source.speaker) metadata.speaker = String(source.speaker).slice(0, 80);
    if (source.scene) metadata.scene = String(source.scene).slice(0, 80);
    return {
      id: String(asset.id || ''),
      kind: String(asset.kind || source.kind || ''),
      name: String(asset.name || source.name || asset.filename || '').slice(0, 120),
      url: String(asset.url || asset.public_url || ''),
      mime_type: String(asset.mime_type || source.file?.type || ''),
      size_bytes: Number(asset.size_bytes || source.file?.size || 0),
      sha256: String(asset.sha256 || ''),
      status: 'ready',
      metadata,
    };
  });

  const preferred = (kind) => uploaded.find((asset) => asset.kind === kind && sourceFor(asset).default)
    || uploaded.find((asset) => asset.kind === kind);
  const defaultBgm = preferred('bgm');
  const defaultPortrait = preferred('portrait') || preferred('spine');
  const defaultBackground = preferred('background');

  const experience = clone(importedApp.card_experience && typeof importedApp.card_experience === 'object'
    ? importedApp.card_experience : {});
  experience.version = 2;
  experience.stage = {
    ...(experience.stage && typeof experience.stage === 'object' ? experience.stage : {}),
    background_asset_id: remapAssetId(experience.stage?.background_asset_id),
    portrait_asset_id: remapAssetId(experience.stage?.portrait_asset_id),
  };
  experience.bgm = {
    enabled: !!defaultBgm || !!experience.bgm?.enabled,
    default_asset_id: defaultBgm?.id || remapAssetId(experience.bgm?.default_asset_id),
    autoplay: 'after-interaction',
    volume: finiteNumber(experience.bgm?.volume, 0.45),
    loop: experience.bgm?.loop !== false,
    show_floating_player: experience.bgm?.show_floating_player !== false,
  };
  experience.ui_rules = Array.isArray(experience.ui_rules) ? experience.ui_rules : [];
  experience.sidebars = Array.isArray(experience.sidebars) ? experience.sidebars : [];
  experience.galgame = {
    ...(experience.galgame && typeof experience.galgame === 'object' ? experience.galgame : {}),
    enabled: !!(defaultPortrait || defaultBackground) || !!experience.galgame?.enabled,
    theme: experience.galgame?.theme === 'archive' ? 'archive' : 'standard',
    dialogue_position: experience.galgame?.dialogue_position === 'top' ? 'top' : 'bottom',
    portrait_layout: ['center', 'left', 'right', 'dual'].includes(experience.galgame?.portrait_layout)
      ? experience.galgame.portrait_layout : 'center',
    default_portrait_id: defaultPortrait?.id || remapAssetId(experience.galgame?.default_portrait_id),
    default_background_id: defaultBackground?.id || remapAssetId(experience.galgame?.default_background_id),
    portrait_directive: experience.galgame?.portrait_directive || '\\[(?:立绘|portrait|图)[:：]\\s*([^\\]]+)\\]',
    background_directive: experience.galgame?.background_directive || '\\[(?:背景|bg|scene)[:：]\\s*([^\\]]+)\\]',
    speaker_directive: experience.galgame?.speaker_directive || '\\[(?:说话者|speaker|角色)[:：]\\s*([^\\]]+)\\]',
    affiliation_directive: experience.galgame?.affiliation_directive || '\\[(?:身份|affiliation|组织)[:：]\\s*([^\\]]+)\\]',
    mood_directive: experience.galgame?.mood_directive || '\\[(?:气氛|mood|情绪)[:：]\\s*([^\\]]+)\\]',
    scene_bgm_map: remapAssetMap(experience.galgame?.scene_bgm_map),
    mood_bgm_map: remapAssetMap(experience.galgame?.mood_bgm_map),
    show_stage_actions: experience.galgame?.show_stage_actions !== false,
    hide_bubble_avatar: experience.galgame?.hide_bubble_avatar !== false,
    typewriter: experience.galgame?.typewriter !== false,
  };

  const worldInfo = clone(Array.isArray(importedApp.world_info) ? importedApp.world_info : []);
  for (const entry of worldInfo) {
    if (!Array.isArray(entry?.media_bindings)) continue;
    entry.media_bindings = entry.media_bindings.map((binding) => ({
      ...binding,
      asset_id: remapAssetId(binding?.asset_id),
    }));
  }
  const unmatched = [];
  const touchedEntries = new Map();
  for (const asset of uploaded) {
    const source = sourceFor(asset);
    const hint = String(source.bind_world || '').trim();
    if (!hint) continue;
    const index = findWorldEntry(worldInfo, hint);
    if (index < 0) {
      unmatched.push({ file: source.path || asset.filename || asset.name, bind_world: hint });
      continue;
    }
    const entry = worldInfo[index];
    entry.media_bindings = Array.isArray(entry.media_bindings) ? entry.media_bindings : [];
    const sameKind = entry.media_bindings.findIndex((binding) => binding?.kind === asset.kind);
    const binding = {
      id: createId('binding'),
      kind: asset.kind,
      asset_id: asset.id,
      label: asset.name || source.name || asset.filename || '',
      activation: 'entry',
    };
    if (sameKind < 0) entry.media_bindings.push(binding);
    else if (source.default) entry.media_bindings.splice(sameKind, 1, binding);
    touchedEntries.set(index, source.scene_pattern || touchedEntries.get(index) || '');
  }

  let generatedSceneRules = 0;
  for (const [index, explicitPattern] of touchedEntries.entries()) {
    const entry = worldInfo[index];
    const entryId = String(entry.id || `world-${index + 1}`);
    entry.id = entryId;
    const entryName = String(entry.name || entry.keys?.[0] || `场景 ${index + 1}`).trim();
    const marker = `[场景:${entryName}]`;
    const instructionTag = `[Homer资源包场景指令:${entryId}]`;
    if (!String(entry.content || '').includes(instructionTag)) {
      entry.content = `${String(entry.content || '').trim()}\n\n${instructionTag} 当本条目对应的角色或场景实际出现在回复中时，请在回复末尾输出 ${marker}。`.trim();
    }
    if (!experience.ui_rules.some((rule) => rule?.action === 'set_scene' && rule?.target_id === entryId)) {
      experience.ui_rules.push({
        id: createId('ui-rule'),
        name: `${entryName} · 自动切换素材`,
        enabled: true,
        pattern: explicitPattern || `\\[(?:场景|scene)[:：]\\s*${escapeRegex(entryName)}\\s*\\]`,
        flags: 'i',
        action: 'set_scene',
        target_id: entryId,
        template_html: '',
        scoped_css: '',
        duration_ms: 0,
        order: 500 + index,
        remove_match: true,
      });
      generatedSceneRules++;
    }
  }

  return {
    payload: {
      media_assets: mediaAssets,
      media_draft_id: String(mediaDraftId || ''),
      world_info: worldInfo,
      card_experience: experience,
    },
    report: {
      asset_count: mediaAssets.length,
      world_binding_count: worldInfo.reduce((sum, entry) => sum + (Array.isArray(entry.media_bindings) ? entry.media_bindings.length : 0), 0),
      generated_scene_rules: generatedSceneRules,
      unmatched,
    },
  };
}

function listFiles(zip) {
  const output = [];
  zip.forEach((path, entry) => {
    const originalPath = String(entry.unsafeOriginalName || path || '');
    // Some Windows-authored archives store directory records with backslashes
    // but omit the ZIP directory attribute, so JSZip reports entry.dir=false.
    if (!entry.dir && !/[\\/]$/.test(originalPath)) {
      output.push({ path: normalizePath(path), originalPath, entry });
    }
  });
  return output;
}

function validateArchiveEntries(files, options = {}) {
  const maxFiles = Number(options.maxArchiveFiles || MAX_ARCHIVE_FILES);
  const maxTotal = Number(options.maxTotalUncompressedBytes || MAX_TOTAL_UNCOMPRESSED_BYTES);
  if (files.length > maxFiles) throw new Error(`资源包文件数 ${files.length} 超过上限 ${maxFiles}`);
  let total = 0;
  for (const file of files) {
    const raw = String(file.originalPath || file.path || '');
    const parts = raw.replace(/\\/g, '/').split('/');
    if (!raw || raw.includes('\0') || /^[a-z]:/i.test(raw) || raw.startsWith('/') || parts.some((part) => part === '..' || part === '')) {
      throw new Error(`资源包包含不安全路径：${raw || '(empty)'}`);
    }
    const size = entryUncompressedSize(file.entry);
    if (size > 0) {
      total += size;
      if (total > maxTotal) throw new Error('资源包解压后体积超过 768MB，已拒绝处理');
    }
  }
}

function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function findFile(files, path) {
  const wanted = normalizePath(path).toLowerCase();
  return files.find((file) => file.path.toLowerCase() === wanted)
    || files.find((file) => file.path.toLowerCase().endsWith(`/${wanted}`));
}

function findPreferredFile(files, names, exclude = () => false, fallbackAnyJson = true) {
  for (const name of names) {
    const exact = files.find((file) => file.path.toLowerCase() === name.toLowerCase() && !exclude(file.path));
    if (exact) return exact;
  }
  for (const name of names) {
    const nested = files.find((file) => file.path.toLowerCase().endsWith(`/${name.toLowerCase()}`) && !exclude(file.path));
    if (nested) return nested;
  }
  return fallbackAnyJson
    ? files.find((file) => file.path.toLowerCase().endsWith('.json') && !exclude(file.path))
    : null;
}

function isAuxiliaryJson(path) {
  return /(^|\/)(manifest|tgp|plugin|package|worldbook|lorebook|regex|regex_scripts)\.json$/i.test(path);
}

function findOptionalJson(files, manifest, keys, fallbackNames) {
  for (const key of keys) {
    const raw = manifest?.[key];
    const path = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? raw.file || raw.path : '');
    if (path) return findFile(files, path);
  }
  for (const name of fallbackNames) {
    const found = findPreferredFile(files.filter((file) => file.path.toLowerCase().endsWith(name.toLowerCase())), [name]);
    if (found) return found;
  }
  return null;
}

async function readJson(entry, path) {
  try {
    const knownSize = entryUncompressedSize(entry);
    if (knownSize > MAX_JSON_BYTES) throw new Error('JSON 文件超过 8MB');
    const text = await entry.async('string');
    if (new Blob([text]).size > MAX_JSON_BYTES) throw new Error('JSON 文件超过 8MB');
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是有效 JSON：${error?.message || error}`);
  }
}

async function readDeclaredAssets(files, declared) {
  const output = [];
  for (const raw of declared.slice(0, MAX_ASSETS + 1)) {
    const descriptor = typeof raw === 'string' ? { file: raw } : (raw || {});
    const path = firstString(descriptor.file, descriptor.path, descriptor.src);
    if (!path) continue;
    const found = findFile(files, path);
    if (!found) throw new Error(`manifest 声明的素材不存在：${path}`);
    const kind = normalizeKind(descriptor.kind || descriptor.type) || inferKind(found.path);
    if (!kind) continue;
    output.push(await materializeAsset(found, {
      kind,
      source_asset_id: descriptor.id || descriptor.asset_id,
      name: descriptor.name || descriptor.label,
      default: descriptor.default === true || descriptor.is_default === true,
      emotion: descriptor.emotion || descriptor.tag || descriptor.pose,
      speaker: descriptor.speaker || descriptor.character,
      scene: descriptor.scene || descriptor.location,
      bind_world: descriptor.bind_world || descriptor.world_entry || descriptor.target || descriptor.character || descriptor.location,
      scene_pattern: descriptor.scene_pattern || descriptor.pattern || descriptor.trigger,
    }));
  }
  return output;
}

async function inferAssets(files, excluded) {
  const output = [];
  for (const found of files) {
    if (excluded.has(found.path)) continue;
    const kind = inferKind(found.path);
    if (!kind) continue;
    output.push(await materializeAsset(found, { kind }));
    if (output.length > MAX_ASSETS) break;
  }
  return output;
}

async function materializeAsset(found, descriptor) {
  const filename = found.path.split('/').pop() || 'asset';
  const mime = mimeFor(filename);
  const kind = descriptor.kind;
  const limit = kind === 'bgm' ? MAX_BGM_BYTES : kind === 'spine' ? 60 * 1024 * 1024 : MAX_IMAGE_BYTES;
  const limitLabel = kind === 'bgm' ? '30MB' : kind === 'spine' ? '60MB' : '20MB';
  const knownSize = entryUncompressedSize(found.entry);
  if (knownSize > limit) {
    throw new Error(`${filename} 超过${limitLabel}单素材限制`);
  }
  const blob = await found.entry.async('blob');
  if (blob.size <= 0 || blob.size > limit) {
    throw new Error(`${filename} 是空文件或超过${limitLabel}单素材限制`);
  }
  const file = new File([blob], filename, { type: mime });
  return {
    file,
    path: found.path,
    kind,
    name: String(descriptor.name || stem(filename)).slice(0, 120),
    default: descriptor.default === true,
    emotion: String(descriptor.emotion || inferEmotion(found.path, kind)).slice(0, 40),
    speaker: String(descriptor.speaker || '').slice(0, 80),
    scene: String(descriptor.scene || '').slice(0, 80),
    bind_world: String(descriptor.bind_world || inferWorldHint(found.path, kind)).slice(0, 120),
    scene_pattern: String(descriptor.scene_pattern || '').slice(0, 500),
    source_asset_id: String(descriptor.source_asset_id || '').slice(0, 120),
  };
}

function normalizeKind(value) {
  return KIND_ALIASES[String(value || '').trim().toLowerCase()] || '';
}

function inferKind(path) {
  const lower = normalizePath(path).toLowerCase();
  if (/\.spine\.zip$/i.test(lower)) return 'spine';
  const segments = lower.split('/');
  for (const segment of segments) {
    const kind = normalizeKind(segment.replace(/s$/, ''));
    if (kind) return kind;
  }
  if (/\.mp3$/i.test(lower)) return 'bgm';
  if (!/\.(png|jpe?g|webp|gif)$/i.test(lower)) return '';
  if (/(^|\/)(backgrounds?|bg|scenes?|背景|场景)(\/|$)/i.test(lower)) return 'background';
  return 'portrait';
}

function inferWorldHint(path, kind) {
  const segments = normalizePath(path).split('/');
  const filename = segments.pop() || '';
  const kindIndex = segments.findIndex((segment) => normalizeKind(segment.replace(/s$/i, '')) === kind);
  if (kindIndex >= 0 && segments[kindIndex + 1] && !GENERIC_HINTS.has(segments[kindIndex + 1].toLowerCase())) {
    return segments[kindIndex + 1];
  }
  const parts = stem(filename).split(/[_\-—·]+/).filter(Boolean);
  const first = parts.find((part) => !GENERIC_HINTS.has(part.toLowerCase()) && !EMOTION_HINTS.has(part.toLowerCase()));
  return first || '';
}

function inferEmotion(path, kind) {
  if (kind === 'bgm') return '';
  const value = stem(normalizePath(path).split('/').pop() || '');
  const parts = value.split(/[_\-—·]+/).filter(Boolean);
  if (kind === 'portrait') {
    const known = parts.find((part) => EMOTION_HINTS.has(part.toLowerCase()));
    if (known) return known;
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }
  return value;
}

function mergeWorldbook(card, worldbook) {
  const incoming = worldbookEntries(worldbook);
  if (!incoming.length) return;
  if (!card.data && Array.isArray(card.world_info)) {
    card.world_info = mergeEntries(card.world_info, incoming);
    return;
  }
  const data = card.data && typeof card.data === 'object' ? card.data : card;
  const existingBook = data.character_book && typeof data.character_book === 'object' ? data.character_book : {};
  data.character_book = {
    ...existingBook,
    name: existingBook.name || worldbook?.name || `${cardName(card)} 世界书`,
    entries: mergeEntries(worldbookEntries(existingBook), incoming),
  };
}

function worldbookEntries(value) {
  if (Array.isArray(value)) return value.filter(isObject);
  if (!isObject(value)) return [];
  const data = isObject(value.data) ? value.data : value;
  const book = isObject(data.character_book) ? data.character_book : data;
  const entries = book.entries ?? data.world_info;
  if (Array.isArray(entries)) return entries.filter(isObject);
  if (isObject(entries)) return Object.entries(entries).map(([key, entry]) => ({ id: entry?.id || entry?.uid || key, ...(entry || {}) })).filter(isObject);
  return [];
}

function mergeEntries(existing, incoming) {
  const output = Array.isArray(existing) ? clone(existing) : [];
  const seen = new Set(output.map(entryKey));
  for (const entry of incoming) {
    const key = entryKey(entry);
    if (!seen.has(key)) {
      output.push(clone(entry));
      seen.add(key);
    }
  }
  return output.slice(0, 200);
}

function entryKey(entry) {
  return String(entry?.id || entry?.uid || entry?.name || entry?.comment || JSON.stringify(entry?.keys || entry?.key || [])).trim().toLowerCase();
}

function mergeRegexScripts(card, regexFile) {
  const incoming = regexItems(regexFile);
  if (!incoming.length) return;
  const data = card.data && typeof card.data === 'object' ? card.data : card;
  const existing = Array.isArray(data.regex_scripts) ? data.regex_scripts : [];
  const output = [];
  const seen = new Set();
  for (const item of [...existing, ...incoming]) {
    if (!isObject(item)) continue;
    const find = String(item.find || item.regex || item.pattern || '').trim();
    if (!find) continue;
    const key = `${find}\u0000${String(item.flags || item.regexFlags || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  data.regex_scripts = output.slice(0, 40);
}

function regexItems(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const candidate of [
    value.regex_scripts,
    value.TavernHelper_scripts,
    value.extensions?.regex_scripts,
    value.data?.regex_scripts,
    value.data?.extensions?.regex_scripts,
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function findWorldEntry(entries, needle) {
  const target = String(needle || '').trim().toLowerCase();
  if (!target) return -1;
  const values = (entry) => [entry?.name, entry?.comment, entry?.title]
    .concat(Array.isArray(entry?.keys) ? entry.keys : [])
    .concat(Array.isArray(entry?.secondary_keys) ? entry.secondary_keys : [])
    .filter(Boolean).map((value) => String(value).trim().toLowerCase());
  let index = entries.findIndex((entry) => values(entry).some((value) => value === target));
  if (index >= 0) return index;
  index = entries.findIndex((entry) => values(entry).some((value) => value.includes(target) || target.includes(value)));
  return index;
}

function cardName(card) {
  return String(card?.data?.name || card?.name || card?.title || '未命名角色');
}

function stem(filename) {
  return String(filename || '').replace(/\.[^.]+$/, '');
}

function mimeFor(filename) {
  const extension = String(filename || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[extension] || 'application/octet-stream';
}

function entryUncompressedSize(entry) {
  const size = Number(entry?._data?.uncompressedSize ?? entry?._data?.uncompressedSize64 ?? 0);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

function arrayValue(...values) {
  return values.find(Array.isArray) || [];
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
