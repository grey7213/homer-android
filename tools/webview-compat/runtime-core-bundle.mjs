import { build, version as esbuildVersion } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Bootstrap already installs webpack's locked parser. Do not introduce a second,
// unpinned JavaScript grammar just for APK packaging.
const runtimeRequire = createRequire(new URL('../../sillytavern-runtime/package.json', import.meta.url));
const { parse, version: parserVersion } = runtimeRequire('acorn');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const AMBIGUOUS = Symbol('ambiguous export');
// aapt excludes underscore-prefixed asset directories even when our generated
// index lists them. Use a normal directory and verify actual APK inclusion.
const GENERATED_DIRECTORY = 'scripts/homer-core';
const BUNDLE_PREFIX = 'runtime-core-';
const QUICK_REPLY_DIRECTORY = 'scripts/extensions/quick-reply/';

export function coreBundleEnabled({ argv = [], env = process.env } = {}) {
    if (argv.includes('--no-runtime-core-bundle')) return false;
    if (argv.includes('--runtime-core-bundle')) return true;
    return env.HOMER_RUNTIME_CORE_BUNDLE !== '0';
}

export function quickReplyBundleEnabled({ argv = [], env = process.env } = {}) {
    if (argv.includes('--no-quick-reply-bundle')) return false;
    if (argv.includes('--quick-reply-bundle')) return true;
    return env.HOMER_QUICK_REPLY_BUNDLE !== '0';
}

function visit(node, visitor, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') visitor(node, ancestors);
    const next = typeof node.type === 'string' ? [...ancestors, node] : ancestors;
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => visit(child, visitor, next));
        else if (value && typeof value === 'object') visit(value, visitor, next);
    }
}

function bindingNames(pattern) {
    if (!pattern) return [];
    if (pattern.type === 'Identifier') return [pattern.name];
    if (pattern.type === 'RestElement') return bindingNames(pattern.argument);
    if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left);
    if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(bindingNames);
    if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(property =>
        bindingNames(property.type === 'RestElement' ? property.argument : property.value));
    throw new Error(`Unsupported exported binding: ${pattern.type}`);
}

const exportName = node => node.name ?? node.value;
const moduleName = value => /^[A-Za-z_$][\w$]*$/.test(value) ? value : JSON.stringify(value);
const isLibrary = path => path === 'lib.js' || path.startsWith('lib/');

function resolveSpecifier(specifier, importer, prefix) {
    if (/^(?:https?:|data:|blob:)/.test(specifier)) return { external: true, url: specifier };
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        throw new Error(`Bare runtime import is not packable: ${importer} -> ${specifier}`);
    }
    // Root runtime aliases and the mounted path must resolve to one module-map
    // URL. Relative paths in the generated common bundle cannot be used here.
    const rooted = specifier.startsWith('/') && !specifier.startsWith(prefix)
        ? prefix + specifier.slice(1) : specifier;
    const url = new URL(rooted, `https://homer-bundle.invalid${prefix}${importer}`);
    if (!url.pathname.startsWith(prefix)) {
        throw new Error(`Runtime import escapes its asset mount: ${importer} -> ${specifier}`);
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    return { path, url: url.pathname + url.search + url.hash, query: url.search || url.hash };
}

function checkAbsoluteExtensionHook(info, node, ancestors) {
    if (info.path !== 'scripts/extensions.js' || node.source.type !== 'Identifier' || node.source.name !== 'url') return false;
    const owner = ancestors.findLast(parent => parent.type === 'FunctionDeclaration');
    if (owner?.id?.name !== 'callExtensionHook') return false;
    let urlIsAbsolute = false;
    visit(owner.body, candidate => {
        if (candidate.type === 'VariableDeclarator' && candidate.id.type === 'Identifier'
            && candidate.id.name === 'url' && candidate.init?.type === 'CallExpression'
            && candidate.init.callee.type === 'Identifier' && candidate.init.callee.name === 'extensionAssetUrl') {
            urlIsAbsolute = true;
        }
    });
    const helper = info.ast.body.find(candidate => candidate.type === 'FunctionDeclaration' && candidate.id?.name === 'extensionAssetUrl');
    const expression = helper?.body.body.length === 1 && helper.body.body[0].type === 'ReturnStatement'
        ? helper.body.body[0].argument : null;
    return urlIsAbsolute && expression?.type === 'MemberExpression' && expression.property.name === 'href'
        && expression.object.type === 'NewExpression' && expression.object.callee.name === 'URL'
        && expression.object.arguments[1]?.type === 'MemberExpression'
        && expression.object.arguments[1].object.name === 'document'
        && expression.object.arguments[1].property.name === 'baseURI';
}

function parseModule(path, source, prefix) {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const info = { path, source, ast, imports: new Map(), direct: new Map(), stars: [], dependencies: [], dynamic: [] };
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
            const target = resolveSpecifier(node.source.value, path, prefix);
            info.dependencies.push(target);
            for (const item of node.specifiers) {
                const imported = item.type === 'ImportDefaultSpecifier' ? 'default'
                    : item.type === 'ImportNamespaceSpecifier' ? '*' : exportName(item.imported);
                info.imports.set(item.local.name, { target, imported });
            }
        } else if (node.type === 'ExportDefaultDeclaration') {
            const declaration = node.declaration;
            const local = ['FunctionDeclaration', 'ClassDeclaration'].includes(declaration.type)
                ? declaration.id?.name : null;
            info.direct.set('default', { local: local || '*default*' });
        } else if (node.type === 'ExportNamedDeclaration') {
            const target = node.source ? resolveSpecifier(node.source.value, path, prefix) : null;
            if (target) info.dependencies.push(target);
            if (node.declaration) {
                const declaration = node.declaration;
                const names = declaration.type === 'VariableDeclaration'
                    ? declaration.declarations.flatMap(item => bindingNames(item.id)) : [declaration.id.name];
                names.forEach(name => info.direct.set(name, { local: name }));
            }
            for (const item of node.specifiers) info.direct.set(exportName(item.exported), target
                ? { target, imported: exportName(item.local) } : { local: exportName(item.local) });
        } else if (node.type === 'ExportAllDeclaration') {
            const target = resolveSpecifier(node.source.value, path, prefix);
            info.dependencies.push(target);
            if (node.exported) info.direct.set(exportName(node.exported), { target, imported: '*' });
            else info.stars.push(target);
        }
    }
    visit(ast, (node, ancestors) => {
        if (node.type === 'MetaProperty' && node.meta.name === 'import') {
            throw new Error(`Core import.meta relocation is unsupported: ${path}:${node.loc.start.line}`);
        }
        if (node.type !== 'ImportExpression') return;
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
            info.dynamic.push({ specifier: node.source.value, ...resolveSpecifier(node.source.value, path, prefix) });
        } else if (checkAbsoluteExtensionHook(info, node, ancestors)) {
            info.dynamic.push({ absolute_expression: 'extensionAssetUrl(...).href', line: node.loc.start.line });
        } else {
            throw new Error(`Unverified computed dynamic import: ${path}:${node.loc.start.line}`);
        }
    });
    return info;
}

async function moduleGraph(runtimeRoot, entry, prefix, { shouldBundle = path => !isLibrary(path), validateTarget = () => {}, inspectForeignExports = true } = {}) {
    const realRoot = await realpath(runtimeRoot);
    const infos = new Map();
    async function load(path) {
        if (infos.has(path)) return infos.get(path);
        const absolute = resolve(runtimeRoot, path);
        const actual = await realpath(absolute);
        if (actual !== realRoot && !actual.startsWith(realRoot + sep)) throw new Error(`Asset symlink escapes runtime: ${path}`);
        const source = await readFile(absolute, 'utf8');
        const info = parseModule(path, source, prefix);
        infos.set(path, info);
        for (const target of [...info.dependencies, ...info.dynamic.filter(target => target.url)]) await validateTarget(target, path);
        for (const target of info.dependencies) {
            if (target.external) continue;
            if (target.query && shouldBundle(target.path)) throw new Error(`Core query import has distinct identity: ${path} -> ${target.url}`);
            if (shouldBundle(target.path)) await load(target.path);
        }
        // Export-star resolution needs the original library export table, not a
        // renamed or bundled copy of the library singleton.
        for (const target of [...info.stars, ...[...info.direct.values()].filter(item => item.target).map(item => item.target)]) {
            if (!target.external && !shouldBundle(target.path) && inspectForeignExports) await load(target.path);
        }
        if (!inspectForeignExports && info.stars.some(target => target.external || !shouldBundle(target.path))) {
            throw new Error(`Export-star crosses the extension bundle boundary: ${path}`);
        }
        return info;
    }
    await load(entry);
    return { infos, load };
}

function exportedNames(info, infos, visited = new Set()) {
    if (visited.has(info.path)) return new Set();
    const next = new Set([...visited, info.path]);
    const names = new Set(info.direct.keys());
    for (const target of info.stars) {
        if (target.external) throw new Error(`Cannot inspect external export-star in ${info.path}`);
        for (const name of exportedNames(infos.get(target.path), infos, next)) if (name !== 'default') names.add(name);
    }
    return names;
}

function resolveExport(info, name, infos, visited = new Set()) {
    const pair = `${info.path}\0${name}`;
    if (visited.has(pair)) return null;
    const next = new Set([...visited, pair]);
    const resolveTarget = (target, imported) => {
        if (imported === '*') return `${target.url}#*namespace*`;
        if (target.external || !infos.has(target.path)) return `${target.url}#${imported}`;
        return resolveExport(infos.get(target.path), imported, infos, next);
    };
    const direct = info.direct.get(name);
    if (direct) {
        if (direct.target) return resolveTarget(direct.target, direct.imported);
        const imported = info.imports.get(direct.local);
        return imported ? resolveTarget(imported.target, imported.imported) : `${info.path}#${direct.local}`;
    }
    if (name === 'default') return null;
    let resolution = null;
    for (const target of info.stars) {
        const candidate = resolveTarget(target, name);
        if (candidate === AMBIGUOUS || candidate && resolution && candidate !== resolution) return AMBIGUOUS;
        if (candidate) resolution = candidate;
    }
    return resolution;
}

function exportsFor(info, infos) {
    return [...exportedNames(info, infos)].filter(name => {
        const origin = resolveExport(info, name, infos);
        return origin && origin !== AMBIGUOUS;
    }).sort();
}

/**
 * Compile ONLY a generated APK runtime directory. The input public/ tree is not
 * changed. Original URLs become live re-export façades into one canonical ESM.
 * Compile/audit everything before writing any façade; failure cannot produce a
 * silently half-bundled successful package.
 */
async function bundleRuntimeModules({ runtimeRoot, manifest = { files: {} }, prefix = '/module/dialogue/', entry = 'script.js', writeAssets = true,
    kind = 'core', shouldBundle = path => !isLibrary(path), validateTarget = () => {}, inspectForeignExports = true }) {
    if (!prefix.startsWith('/') || !prefix.endsWith('/') || prefix.includes('..')) throw new Error('Expected a canonical runtime mount');
    // esbuild canonicalizes junctions when resolving. Normalize the root too so
    // its real importers still produce the original browser-relative paths.
    runtimeRoot = await realpath(runtimeRoot);
    const graph = await moduleGraph(runtimeRoot, entry, prefix, { shouldBundle, validateTarget, inspectForeignExports });
    const core = [...graph.infos.values()].filter(info => shouldBundle(info.path));
    const order = [entry, ...core.map(info => info.path).filter(path => path !== entry).sort()];
    const modules = order.map((path, index) => {
        const info = graph.infos.get(path);
        const exports = exportsFor(info, graph.infos);
        const aliases = Object.fromEntries(exports.map((name, item) => [name, `h${index}_${item}`]));
        return { path, info, exports, aliases };
    });
    const aggregator = modules.map(module => module.exports.length
        ? `export { ${module.exports.map(name => `${moduleName(name)} as ${module.aliases[name]}`).join(', ')} } from ${JSON.stringify('./' + module.path)};`
        : `import ${JSON.stringify('./' + module.path)};`).join('\n');
    const external = new Set();
    const entrySourceName = `homer-${kind}-entry.mjs`;
    const result = await build({
        stdin: { contents: aggregator, resolveDir: runtimeRoot, sourcefile: entrySourceName, loader: 'js' },
        outfile: join(runtimeRoot, GENERATED_DIRECTORY, 'core.mjs'), write: false,
        bundle: true, format: 'esm', platform: 'browser', target: 'chrome89',
        treeShaking: false, keepNames: true, minify: true, charset: 'utf8',
        legalComments: 'eof', sourcemap: false, metafile: true, logLevel: 'silent',
        plugins: [{ name: 'homer-canonical-runtime-imports', setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => {
                if (!args.importer || args.importer.endsWith(entrySourceName)) return null;
                const importer = slash(relative(runtimeRoot, args.importer));
                const target = resolveSpecifier(args.path, importer, prefix);
                // Every dynamic dependency retains its original URL and lazy
                // execution. If already core, that URL is a singleton façade.
                if (target.external || !shouldBundle(target.path) || args.kind === 'dynamic-import') {
                    external.add(target.url);
                    return { path: target.url, external: true };
                }
                return null;
            });
        } }],
    });
    if (result.warnings.length) throw new Error(`Core bundle warnings: ${result.warnings.map(warning =>
        `${warning.location?.file || ''}:${warning.location?.line || ''}:${warning.location?.column || ''} ${warning.text}`).join('; ')}`);
    if (result.outputFiles.length !== 1) throw new Error('Expected one core ESM and no implicit chunks/maps');
    const bundle = result.outputFiles[0].contents;
    const digest = sha256(bundle);
    const bundleFilePrefix = kind === 'core' ? BUNDLE_PREFIX : 'quick-reply-';
    const bundlePath = `${GENERATED_DIRECTORY}/${bundleFilePrefix}${digest.slice(0, 20)}.mjs`;
    const bundleUrl = prefix + bundlePath;
    const expectedExports = modules.flatMap(module => Object.values(module.aliases)).sort();
    const actualExports = Object.values(result.metafile.outputs)[0].exports.slice().sort();
    if (JSON.stringify(expectedExports) !== JSON.stringify(actualExports)) throw new Error('Core bundle export table mismatch');
    // Ensure esbuild did not accidentally inline an external library or eagerly
    // absorb a lazy-only module into the startup graph.
    const inputs = Object.keys(result.metafile.inputs).filter(path => !path.endsWith(entrySourceName));
    const expectedInputs = new Set(modules.map(module => resolve(runtimeRoot, module.path)));
    for (const path of inputs) if (!expectedInputs.has(resolve(path))) throw new Error(`Unexpected bundled input: ${path}`);

    if (writeAssets) {
        await mkdir(join(runtimeRoot, GENERATED_DIRECTORY), { recursive: true });
        await writeFile(join(runtimeRoot, bundlePath), bundle);
    }
    manifest.files ??= {};
    const records = {};
    for (const module of modules) {
        const facade = '// APK generated singleton facade; edit the source module, not this asset.\n'
            + (module.exports.length
                ? `export { ${module.exports.map(name => `${module.aliases[name]} as ${moduleName(name)}`).join(', ')} } from ${JSON.stringify(bundleUrl)};\n`
                : `import ${JSON.stringify(bundleUrl)};\n`);
        const key = `runtime/${module.path}`;
        const inputDigest = sha256(module.info.source);
        const previous = manifest.files[key];
        const output = sha256(facade);
        if (writeAssets) await writeFile(join(runtimeRoot, module.path), facade);
        const flag = kind === 'core' ? 'core_facade' : 'quick_reply_facade';
        manifest.files[key] = { input: previous?.input || inputDigest, output, [flag]: true };
        records[module.path] = { input: previous?.input || inputDigest, lowered_input: inputDigest, output,
            exports: module.exports, aliases: module.aliases, dynamic_imports: module.info.dynamic };
    }
    manifest.files[`runtime/${bundlePath}`] = { output: digest };
    const metadata = { enabled: true, version: 1, entry, mount: prefix, asset: bundlePath,
        sha256: digest, bytes: bundle.length, module_count: modules.length, export_count: expectedExports.length,
        external: [...external].sort(), sourcemap: false, keep_names: true,
        esbuild: esbuildVersion, parser: parserVersion, modules: records };
    if (kind === 'core') manifest.core_bundle = metadata;
    else {
        manifest.extension_bundles ??= {};
        manifest.extension_bundles.quick_reply = metadata;
    }
    return metadata;
}

export async function bundleRuntimeCore(options) {
    return bundleRuntimeModules(options);
}

/**
 * Quick Reply is activated by the existing extension manifest, never by the
 * core bundle. Only its own static graph is merged. Existing core façades and
 * libraries remain canonical external imports, including live re-exports.
 */
export async function bundleQuickReply({ runtimeRoot, manifest, prefix = '/module/dialogue/', writeAssets = true }) {
    if (!manifest?.core_bundle?.enabled || !manifest.core_bundle.modules) {
        throw new Error('Quick Reply bundling requires the verified core export manifest');
    }
    runtimeRoot = await realpath(runtimeRoot);
    const validated = new Set();
    const shouldBundle = path => path.startsWith(QUICK_REPLY_DIRECTORY);
    async function validateTarget(target, importer) {
        if (validated.has(target.url)) return;
        if (target.external || (!shouldBundle(target.path) && !isLibrary(target.path)
            && !Object.hasOwn(manifest.core_bundle.modules, target.path))) {
            throw new Error(`Unknown Quick Reply dependency outside its bundle: ${importer} -> ${target.url}`);
        }
        if (target.query && !isLibrary(target.path)) {
            throw new Error(`Quick Reply dependency has distinct query identity: ${importer} -> ${target.url}`);
        }
        const actual = await realpath(resolve(runtimeRoot, target.path));
        if (!actual.startsWith(runtimeRoot + sep)) throw new Error(`Quick Reply asset escapes runtime: ${target.path}`);
        validated.add(target.url);
    }
    return bundleRuntimeModules({ runtimeRoot, manifest, prefix, writeAssets,
        entry: QUICK_REPLY_DIRECTORY + 'index.js', kind: 'quick-reply', shouldBundle,
        validateTarget, inspectForeignExports: false });
}
