import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../sillytavern-runtime/public/scripts/extensions/homer-preset-ball');
const css = new Map();
const result = await build({ absWorkingDir: here, entryPoints: [path.join(root, 'src/entry.ts')], outfile: path.join(root, 'index.build.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020', minify: true, sourcemap: true, sourcesContent: true,
  nodePaths: [path.join(here, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [{ name: 'original-vue-sources', setup(plugin) {
    plugin.onLoad({ filter: /\.vue$/ }, async args => {
      const text = fs.readFileSync(args.path, 'utf8'); const { descriptor, errors } = parse(text, { filename: args.path });
      if (errors.length) throw errors[0];
      const id = 'data-v-' + crypto.createHash('sha256').update(path.basename(args.path)).digest('hex').slice(0, 8);
      const script = compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '__component',
        templateOptions: { compilerOptions: { scopeId: id } } });
      for (const style of descriptor.styles) {
        const generated = compileStyle({ source: style.content, filename: args.path, id, scoped: style.scoped });
        if (generated.errors.length) throw generated.errors[0]; css.set(args.path, generated.code);
      }
      const sourceMap = script.map ? '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(script.map)).toString('base64') : '';
      return { contents: script.content + `\n__component.__scopeId=${JSON.stringify(id)};\nexport default __component;` + sourceMap,
        loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }], metafile: true });
const adaptedCss = `
.homer-preset-ball-status{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;color:var(--cx-text-dim);font-size:12px;border-bottom:1px solid var(--cx-border-soft)}
.homer-preset-ball-status button{color:var(--cx-primary);background:transparent;border:1px solid var(--cx-border);border-radius:8px;min-height:44px;padding:4px 12px}
.chaoxi-root .chaoxi-btn-icon{min-width:44px;min-height:44px}
.chaoxi-root .chaoxi-item-row{min-height:48px}
.chaoxi-root .chaoxi-toggle{min-width:44px;min-height:28px;margin-block:8px}
.chaoxi-root .chaoxi-mobile-close-bar{padding-bottom:max(8px,env(safe-area-inset-bottom))}
.chaoxi-root .chaoxi-panel{max-width:100vw;box-sizing:border-box}
.chaoxi-root .chaoxi-item-name{color:var(--cx-text);font-size:calc(14px + var(--cx-font-step,0px))}
.chaoxi-root button:focus-visible,.chaoxi-root input:focus-visible{outline:2px solid var(--cx-primary);outline-offset:2px}
.chaoxi-root .chaoxi-batch-btn{min-height:44px}
.chaoxi-root.theme-light .chaoxi-toggle{background:#e3e9e5;border-color:#7b8c82}
.chaoxi-root.theme-light .chaoxi-toggle.on{background:#d1e3db;border-color:#517b69}
.chaoxi-root.theme-light .chaoxi-toggle-knob{background:#687b70}
.chaoxi-root.theme-light .chaoxi-toggle.on .chaoxi-toggle-knob{background:#386b53}
.chaoxi-root.theme-light .chaoxi-btn-icon{color:#4b5e53}
.chaoxi-root.theme-light .chaoxi-control-chip{color:#455d50}
.chaoxi-root.theme-light .chaoxi-control-label,.chaoxi-root.theme-light .chaoxi-panel-preset{color:#52625a}
.chaoxi-root.theme-light .chaoxi-theme-toggle{color:#405b4b}
.chaoxi-root:not(.theme-light) .chaoxi-panel-preset,.chaoxi-root:not(.theme-light) .homer-preset-ball-status,.chaoxi-root:not(.theme-light) .chaoxi-batch-total{color:#a6b4ab}
@media(prefers-reduced-motion:reduce){.chaoxi-root *{transition:none!important}}
`;
const style = await transform([...css].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value).join('\n')
  + adaptedCss.replaceAll('.chaoxi-root', '#homer-preset-ball-root .chaoxi-root'), { loader: 'css', minify: true });
fs.writeFileSync(path.join(root, 'style.build.css'), style.code);
const mapFile = path.join(root, 'index.build.js.map');
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
map.sources = map.sources.map(source => {
  const normalized = source.replaceAll('\\', '/');
  const local = normalized.lastIndexOf('/homer-preset-ball/');
  if (local >= 0) return normalized.slice(local + '/homer-preset-ball/'.length);
  const vendor = normalized.lastIndexOf('/node_modules/');
  return vendor >= 0 ? 'vendor/' + normalized.slice(vendor + '/node_modules/'.length) : normalized;
});
fs.writeFileSync(mapFile, JSON.stringify(map));
fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({
  upstreamModuleSha256: 'fc14319990d4aeff66942f434129f9457e8febc4ed04390a20709432fdbe6b54',
  source: 'Authorized recovered Vue sources; Homer data/permission adapter',
  inputs: Object.keys(result.metafile.inputs).filter(s => !s.includes('node_modules')).map(name => ({ name: path.relative(root, path.resolve(here, name)).replaceAll('\\', '/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(here, name))).digest('hex') })),
  outputs: ['index.build.js', 'index.build.js.map', 'style.build.css'].map(name => ({ name,
    bytes: fs.statSync(path.join(root, name)).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') })),
}, null, 2));
console.log(JSON.stringify({ build: 'passed', css: fs.statSync(path.join(root, 'style.build.css')).size, js: fs.statSync(path.join(root, 'index.build.js')).size }));
