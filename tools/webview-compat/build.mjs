import {build, transform} from 'esbuild';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {resolve, relative, join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {target: 'chrome89', tool: {}, files: {}};
for (const name of ['build.mjs', 'compat-entry.js', 'package-lock.json']) {
    manifest.tool[name] = hash(await readFile(join(here, name)));
}
const tag = '<script src="/assets/homer-webview-compat.js"></script>';
async function lower(code, module = false, sourcefile = '') {
    return (await transform(code, {target: 'chrome89', ...(module ? {format: 'esm'} : {}),
        sourcefile, legalComments: 'inline', charset: 'utf8'})).code;
}
async function walk(dir) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const path = join(dir, entry.name);
        // This shipped editor reference is declaration-like documentation, not
        // executable JavaScript (e.g. function setvar(...);). Preserve its bytes.
        if (/^runtime\/scripts\/extensions\/third-party\/ST-Prompt-Template\/include\/reference(_cn)?\.js$/.test(relative(root, path).replaceAll('\\', '/'))) continue;
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!/\.(js|mjs|html?)$/i.test(entry.name)) continue;
        const before = await readFile(path);
        let output = before.toString('utf8');
        if (/\.(js|mjs)$/i.test(entry.name)) output = await lower(output, false, path);
        else if (/<head(?:\s[^>]*)?>/i.test(output)) {
            const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
            let rewritten = '', start = 0;
            for (const match of output.matchAll(pattern)) {
                const attrs = match[1];
                const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || '';
                if (/\bsrc\s*=/i.test(attrs) || !['', 'module', 'text/javascript', 'application/javascript'].includes(type)) continue;
                rewritten += output.slice(start, match.index) + '<script' + attrs + '>'
                    + await lower(match[2], type === 'module', path) + '</script>';
                start = match.index + match[0].length;
            }
            output = (rewritten + output.slice(start)).replace(/<head(?:\s[^>]*)?>/i, head => head + tag);
        }
        const bytes = Buffer.from(output);
        if (!bytes.equals(before)) {
            manifest.files[relative(root, path).replaceAll('\\', '/')] = {input: hash(before), output: hash(bytes)};
            await writeFile(path, bytes);
        }
    }
}
await walk(root);
const dest = join(root, 'web/assets/homer-webview-compat.js');
await mkdir(dirname(dest), {recursive: true});
await build({entryPoints: [join(here, 'compat-entry.js')], outfile: dest,
    bundle: true, format: 'iife', target: 'chrome89', minify: true, legalComments: 'eof'});
manifest.files['web/assets/homer-webview-compat.js'] = {output: hash(await readFile(dest))};
const licensePath = join(root, 'web/assets/homer-webview-compat-licenses.txt');
const licenses = [];
for (const dependency of ['core-js-bundle', 'dialog-polyfill']) {
    licenses.push(dependency + '\n' + await readFile(join(here, 'node_modules', dependency, 'LICENSE'), 'utf8'));
}
await writeFile(licensePath, licenses.join('\n\n'));
manifest.files['web/assets/homer-webview-compat-licenses.txt'] = {output: hash(await readFile(licensePath))};
await writeFile(join(root, 'webview-compat-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`WebView compatibility: ${Object.keys(manifest.files).length} packaged assets, chrome89`);
