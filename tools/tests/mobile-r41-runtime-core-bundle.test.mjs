import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { bundleRuntimeCore, bundleQuickReply, coreBundleEnabled, quickReplyBundleEnabled } from '../webview-compat/runtime-core-bundle.mjs';

const { SourceTextModule, createContext } = vm;
const runtimeRequire = createRequire(new URL('../../sillytavern-runtime/package.json', import.meta.url));
const { parse } = runtimeRequire('acorn');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, files) {
    const root = await mkdtemp(join(tmpdir(), 'homer-core-build-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [path, source] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), source);
    }
    return root;
}

function moduleHost(root) {
    const context = createContext({ globalThis: {}, console });
    const modules = new Map();
    function getModule(specifier, reference = 'https://core-test.invalid/module/dialogue/script.js') {
        const url = new URL(specifier, reference).href;
        if (modules.has(url)) return modules.get(url);
        const path = new URL(url).pathname.replace(/^\/module\/dialogue\//, '').replace(/^\//, '');
        const source = readFileSync(join(root, path), 'utf8');
        const module = new SourceTextModule(source, { context, identifier: url,
            importModuleDynamically: async (requested, referring) => {
                const target = getModule(requested, referring.identifier);
                if (target.status === 'unlinked') await target.link(linker);
                if (target.status === 'linked') await target.evaluate();
                return target;
            } });
        modules.set(url, module);
        return module;
    }
    const linker = (specifier, referring) => getModule(specifier, referring.identifier);
    return { context, modules, async load(path) {
        const module = getModule(path);
        if (module.status === 'unlinked') await module.link(linker);
        if (module.status === 'linked') await module.evaluate();
        return module.namespace;
    } };
}

if (typeof SourceTextModule !== 'function') {
    test('core bundle ESM suites run in an isolated VM host without requiring caller flags', () => {
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', '--test-reporter=spec', fileURLToPath(import.meta.url)],
            { encoding: 'utf8', timeout: 60_000, env });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /root\/mounted\/core\/extension imports share live state/);
        assert.match(result.stdout, /actual source-layout lease and core scroll share one WeakMap/);
        assert.match(result.stdout, /full compatibility pipeline integrates bundle provenance/);
    });
} else {

test('build switch is enabled by default and provides explicit rollback', () => {
    assert.equal(coreBundleEnabled({ env: {} }), true);
    assert.equal(coreBundleEnabled({ env: { HOMER_RUNTIME_CORE_BUNDLE: '0' } }), false);
    assert.equal(coreBundleEnabled({ argv: ['--no-runtime-core-bundle'], env: {} }), false);
    assert.equal(coreBundleEnabled({ argv: ['--runtime-core-bundle'], env: { HOMER_RUNTIME_CORE_BUNDLE: '0' } }), true);
    assert.equal(quickReplyBundleEnabled({ env: {} }), true);
    assert.equal(quickReplyBundleEnabled({ env: { HOMER_QUICK_REPLY_BUNDLE: '0' } }), false);
    assert.equal(quickReplyBundleEnabled({ argv: ['--no-quick-reply-bundle'], env: {} }), false);
});

test('root/mounted/core/extension imports share live state and execute initialization once', async t => {
    const root = await fixture(t, {
        'script.js': `import { state, count, setCount } from './scripts/state.js';
            import { eventSource } from './scripts/events.js';
            globalThis.coreStarts=(globalThis.coreStarts||0)+1;
            export { state, count, setCount, eventSource };
            export async function lazy(){return import('./scripts/lazy.js')}`,
        'scripts/state.js': `import { library } from '../lib.js';
            export const state={library}; export let count=0;
            export function setCount(value){count=value}`,
        'scripts/events.js': 'export const eventSource={};',
        'scripts/lazy.js': `import {state} from '../script.js';
            globalThis.lazyStarts=(globalThis.lazyStarts||0)+1; export {state};`,
        'scripts/extensions/example.js': `import {state,eventSource,count} from '../../script.js';
            import {state as otherState} from '../state.js';export {state,eventSource,count,otherState};`,
        'lib.js': `globalThis.libraryStarts=(globalThis.libraryStarts||0)+1;export const library={};`,
    });
    const libraryBefore = await readFile(join(root, 'lib.js'));
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    assert.equal(result.module_count, 3);
    assert.ok(result.external.includes('/module/dialogue/scripts/lazy.js'));
    const host = moduleHost(root);
    const core = await host.load('/module/dialogue/script.js');
    const rootAlias = await host.load('/script.js');
    const state = await host.load('/module/dialogue/scripts/state.js');
    const extension = await host.load('/module/dialogue/scripts/extensions/example.js');
    assert.equal(host.context.globalThis.coreStarts, 1);
    assert.equal(host.context.globalThis.libraryStarts, 1);
    assert.equal(host.context.globalThis.lazyStarts, undefined);
    assert.strictEqual(core.state, rootAlias.state);
    assert.strictEqual(core.state, extension.state);
    assert.strictEqual(core.state, extension.otherState);
    assert.strictEqual(core.eventSource, extension.eventSource);
    core.setCount(9);
    assert.equal(core.count, 9);
    assert.equal(rootAlias.count, 9);
    assert.equal(state.count, 9);
    assert.equal(extension.count, 9);
    const lazy = await core.lazy();
    assert.strictEqual(lazy.state, core.state);
    assert.equal(host.context.globalThis.lazyStarts, 1);
    assert.deepEqual(await readFile(join(root, 'lib.js')), libraryBefore);
});

test('actual source-layout lease and core scroll share one WeakMap through generated facade imports', async t => {
    const scriptSource = await readFile(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
    const layoutSource = await readFile(new URL('../../sillytavern-runtime/public/scripts/homer-source-layout.mjs', import.meta.url), 'utf8');
    const bridgeSource = await readFile(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
    const layoutImport = scriptSource.match(/^import \{ deferScrollUntilSourceLayoutRelease \} from '\.\/scripts\/homer-source-layout\.mjs';$/m)?.[0];
    assert.ok(layoutImport, 'shipping core must statically import the real lease helper');
    assert.match(bridgeSource, /import \{ holdLargeSourceLayout \} from '\.\.\/\.\.\/homer-source-layout\.mjs';/);
    const start = scriptSource.indexOf('let requestId = null;');
    const end = scriptSource.indexOf('export function substituteParamsExtended(', start);
    assert.ok(start >= 0 && end > start);
    const root = await fixture(t, {
        'script.js': `${layoutImport}\nexport let chatElement;
            export const power_user={auto_scroll_chat_to_bottom:true,waifuMode:false};
            export function setChatElement(element){chatElement=element}
            ${scriptSource.slice(start, end)}`,
        'scripts/homer-source-layout.mjs': layoutSource,
        'scripts/extensions/homer-bridge/index.js': `import {holdLargeSourceLayout,deferScrollUntilSourceLayoutRelease} from '../../homer-source-layout.mjs';
            import {scrollChatToBottom} from '../../../script.js';
            export {holdLargeSourceLayout,deferScrollUntilSourceLayoutRelease,scrollChatToBottom};`,
    });
    const manifest = { files: {} };
    const bundle = await bundleRuntimeCore({ runtimeRoot: root, manifest });
    assert.equal(bundle.module_count, 2);
    assert.equal(bundle.modules['scripts/homer-source-layout.mjs'].lowered_input, hash(layoutSource));
    assert.equal(manifest.files['runtime/scripts/homer-source-layout.mjs'].core_facade, true);
    assert.ok(!Object.hasOwn(bundle.modules, 'scripts/extensions/homer-bridge/index.js'), 'bridge activation remains external');
    assert.match(await readFile(join(root, 'scripts/homer-source-layout.mjs'), 'utf8'), /APK generated singleton facade/);
    const host = moduleHost(root), frames = new Map(), writes = [];
    let nextFrame = 0, heightReads = 0;
    host.context.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
    host.context.cancelAnimationFrame = id => frames.delete(id);
    const runtime = await host.load('/module/dialogue/script.js');
    const runtimeAlias = await host.load('/script.js');
    const bridge = await host.load('/module/dialogue/scripts/extensions/homer-bridge/index.js');
    const layout = await host.load('/module/dialogue/scripts/homer-source-layout.mjs');
    const layoutAlias = await host.load('/scripts/homer-source-layout.mjs');
    assert.strictEqual(runtime.scrollChatToBottom, runtimeAlias.scrollChatToBottom);
    assert.strictEqual(runtime.scrollChatToBottom, bridge.scrollChatToBottom);
    assert.strictEqual(bridge.holdLargeSourceLayout, layout.holdLargeSourceLayout);
    assert.strictEqual(layout.holdLargeSourceLayout, layoutAlias.holdLargeSourceLayout);
    assert.strictEqual(bridge.deferScrollUntilSourceLayoutRelease, layoutAlias.deferScrollUntilSourceLayoutRelease);
    const classes = new Set();
    const chat = { isConnected: true, classList: {
        contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
    } };
    Object.defineProperty(chat, 'scrollHeight', { get() { heightReads++; return 900; } });
    runtime.setChatElement({ 0: chat, scrollTop: value => writes.push(value) });
    const releaseBridge = bridge.holdLargeSourceLayout(chat);
    runtime.scrollChatToBottom({ waitForFrame: true });
    runtimeAlias.scrollChatToBottom({ waitForFrame: true });
    assert.equal(heightReads, 0, 'core must observe the bridge-owned WeakMap lease');
    assert.equal(frames.size, 0, 'same class alone is not sufficient: the shared lease must defer scheduling');
    releaseBridge();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(frames.size, 1);
    const [firstFrame, firstCallback] = frames.entries().next().value;
    frames.delete(firstFrame); firstCallback();
    assert.equal(heightReads, 1);
    assert.deepEqual(writes, [900]);

    const releaseAlias = layoutAlias.holdLargeSourceLayout(chat);
    const releaseCanonical = layout.holdLargeSourceLayout(chat);
    bridge.scrollChatToBottom({ waitForFrame: true });
    releaseAlias(); await Promise.resolve(); await Promise.resolve();
    assert.equal(frames.size, 0, 'alias/canonical nesting must share the actual lease count');
    releaseCanonical(); await Promise.resolve(); await Promise.resolve();
    assert.equal(frames.size, 1);
    const [secondFrame, secondCallback] = frames.entries().next().value;
    frames.delete(secondFrame); secondCallback();
    assert.equal(heightReads, 2);
    assert.deepEqual(writes, [900, 900]);
    assert.equal(classes.size, 0);
});

test('anonymous default, namespace, destructuring and star exports keep the exact public table', async t => {
    const root = await fixture(t, {
        'script.js': `export {default as anonymous} from './scripts/default.js';
            export * as names from './scripts/values.js';export * from './scripts/values.js';`,
        'scripts/default.js': 'export default function(){return 7}',
        'scripts/values.js': 'export const {x,y:renamed,...rest}={x:1,y:2,z:3};export const [first,,...tail]=[4,5,6];',
    });
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    assert.deepEqual(result.modules['script.js'].exports, ['anonymous', 'first', 'names', 'renamed', 'rest', 'tail', 'x']);
    assert.deepEqual(result.modules['scripts/default.js'].exports, ['default']);
    const host = moduleHost(root);
    const core = await host.load('/script.js');
    assert.equal(core.anonymous(), 7);
    assert.equal(core.x, 1);
    assert.equal(core.names.renamed, 2);
    assert.deepEqual(Array.from(core.tail), [6]);
});

test('export-star omits ambiguity, retains same-origin exports and terminates cycles', async t => {
    const root = await fixture(t, {
        'script.js': `export * from './scripts/a.js';export * from './scripts/b.js';export * from './scripts/cycle-a.js';`,
        'scripts/a.js': `export {shared} from './common.js';export const conflict=1;`,
        'scripts/b.js': `export {shared} from './common.js';export const conflict=2;`,
        'scripts/common.js': 'export const shared={};',
        'scripts/cycle-a.js': `export * from './cycle-b.js';export function alpha(){return 'alpha'}`,
        'scripts/cycle-b.js': `export * from './cycle-a.js';export function beta(){return 'beta'}`,
    });
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    assert.deepEqual(result.modules['script.js'].exports, ['alpha', 'beta', 'shared']);
    const host = moduleHost(root);
    const core = await host.load('/script.js');
    assert.equal('conflict' in core, false);
    assert.equal(core.alpha(), 'alpha');
    assert.equal(core.beta(), 'beta');
    assert.strictEqual(core.shared, (await host.load('/scripts/a.js')).shared);
});

test('safe cyclic functions, initialization ordering and named class/function identity are preserved', async t => {
    const root = await fixture(t, {
        'script.js': `import {answer} from './scripts/a.js';export {answer};globalThis.order.push('root');`,
        'scripts/a.js': `import {getB} from './b.js';export function getA(){return 'A'};
            globalThis.order=['a'];export const answer=getB();export class NamedThing{}`,
        'scripts/b.js': `import {getA} from './a.js';export function getB(){return getA()+'B'}`,
    });
    await bundleRuntimeCore({ runtimeRoot: root });
    const host = moduleHost(root);
    const core = await host.load('/script.js');
    const module = await host.load('/scripts/a.js');
    assert.equal(core.answer, 'AB');
    assert.deepEqual(Array.from(host.context.globalThis.order), ['a', 'root']);
    assert.equal(module.getA.name, 'getA');
    assert.equal(module.NamedThing.name, 'NamedThing');
});

test('library files stay external and dynamic worker paths stay under the original canonical lib URL', async t => {
    const root = await fixture(t, {
        'script.js': `import {library} from './lib/event.js';export {library};
            export function pdf(){return import('./lib/pdf.min.mjs')}`,
        'lib/event.js': 'export const library={};',
        'lib/pdf.min.mjs': `export const workerUrl=new URL('./pdf.worker.mjs',import.meta.url).href;`,
        'lib/pdf.worker.mjs': 'export const worker=true;',
    });
    const before = await readFile(join(root, 'lib/pdf.min.mjs'));
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    assert.equal(result.module_count, 1);
    assert.ok(result.external.includes('/module/dialogue/lib/event.js'));
    assert.ok(result.external.includes('/module/dialogue/lib/pdf.min.mjs'));
    assert.deepEqual(await readFile(join(root, 'lib/pdf.min.mjs')), before);
});

test('manifest retains original source input hash and verifies every facade and generated output', async t => {
    const root = await fixture(t, { 'script.js': 'export const value = 1;' });
    const originalHash = hash('export const value = 1; // unlowered source');
    const manifest = { files: { 'runtime/script.js': { input: originalHash, output: 'previous compiled hash' } } };
    const result = await bundleRuntimeCore({ runtimeRoot: root, manifest });
    assert.equal(manifest.files['runtime/script.js'].input, originalHash);
    assert.equal(result.modules['script.js'].input, originalHash);
    assert.equal(result.modules['script.js'].lowered_input, hash('export const value = 1;'));
    assert.equal(result.asset.split('/').some(segment => /^[_.]/.test(segment)), false,
        'aapt must not exclude any generated asset directory');
    assert.equal(manifest.files['runtime/script.js'].output, hash(await readFile(join(root, 'script.js'))));
    assert.equal(manifest.files['runtime/' + result.asset].output, hash(await readFile(join(root, result.asset))));
    assert.equal(result.sourcemap, false);
    assert.equal((await readFile(join(root, result.asset), 'utf8')).includes('sourceMappingURL'), false);
});

test('generated bundle parses as ECMAScript 2021 and keeps deterministic content-addressed output', async t => {
    const source = { 'script.js': `export const object={};export function name(){return object?.missing??'fallback'}` };
    const root = await fixture(t, source);
    const other = await fixture(t, source);
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    const second = await bundleRuntimeCore({ runtimeRoot: other });
    assert.equal(result.sha256, second.sha256);
    assert.equal(result.asset, second.asset);
    parse(await readFile(join(root, result.asset), 'utf8'), { ecmaVersion: 2021, sourceType: 'module' });
    parse(await readFile(join(root, 'script.js'), 'utf8'), { ecmaVersion: 2021, sourceType: 'module' });
});

test('full compatibility pipeline integrates bundle provenance and supports a clean disabled build', async t => {
    const source = { 'runtime/script.js': 'export const value=globalThis.answer?.value??42;',
        'runtime/scripts/extensions/quick-reply/index.js': 'import {value} from "../../../script.js";export const quickReplyValue=value;',
        'web/index.html': '<html><head></head><body></body></html>' };
    const root = await fixture(t, source);
    const disabled = await fixture(t, source);
    const disabledQuickReply = await fixture(t, source);
    const builder = fileURLToPath(new URL('../webview-compat/build.mjs', import.meta.url));
    for (const [target, args, expected, expectedQuickReply] of [[root, [], true, true], [disabled, ['--no-runtime-core-bundle'], false, false],
        [disabledQuickReply, ['--no-quick-reply-bundle'], true, false]]) {
        const run = spawnSync(process.execPath, [builder, target, ...args], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        const manifest = JSON.parse(await readFile(join(target, 'webview-compat-manifest.json'), 'utf8'));
        assert.equal(manifest.core_bundle.enabled, expected);
        assert.equal(!!manifest.extension_bundles?.quick_reply?.enabled, expectedQuickReply);
        assert.equal(manifest.tool['runtime-core-bundle.mjs'], hash(await readFile(fileURLToPath(new URL('../webview-compat/runtime-core-bundle.mjs', import.meta.url)))));
        assert.equal(manifest.files['runtime/script.js'].input, hash(source['runtime/script.js']));
        for (const [path, entry] of Object.entries(manifest.files)) assert.equal(entry.output, hash(await readFile(join(target, path))), path);
        assert.equal((await readFile(join(target, 'runtime/script.js'), 'utf8')).includes('APK generated singleton facade'), expected);
        assert.match(await readFile(join(target, 'web/index.html'), 'utf8'), /homer-webview-compat.js/);
    }
});

test('Quick Reply is separately activated and shares core bindings plus its own class/API identity', async t => {
    const root = await fixture(t, {
        'script.js': `import {library} from './lib.js';export let chat=[];
            export const eventSource={handlers:[]};export const extension_settings={};
            export function setChat(value){chat=value};export {library};
            globalThis.sequence=['core'];`,
        'lib.js': `globalThis.libraryStarts=(globalThis.libraryStarts||0)+1;export const library={};`,
        'scripts/extensions/quick-reply/index.js': `import {chat,eventSource,extension_settings} from '../../../script.js';
            import {QuickReplySet} from './src/QuickReplySet.js';
            globalThis.sequence.push('qr:entry');globalThis.quickReplyStarts=(globalThis.quickReplyStarts||0)+1;
            eventSource.handlers.push('quick-reply');export {chat,eventSource,extension_settings,QuickReplySet};
            export let quickReplyApi;
            export async function init(){globalThis.sequence.push('qr:activate');quickReplyApi={chat,QuickReplySet};
                QuickReplySet.list.push('configured');globalThis.sequence.push('qr:autoexec')}
            export function lazy(){return import('./src/lazy.js')}`,
        'scripts/extensions/quick-reply/src/QuickReplySet.js': `import {library} from '../../../../lib.js';
            globalThis.sequence.push('qr:class');export class QuickReplySet{static list=[];static library=library}`,
        'scripts/extensions/quick-reply/api/consumer.js': `import {quickReplyApi} from '../index.js';
            import {QuickReplySet} from '../src/QuickReplySet.js';export {quickReplyApi,QuickReplySet};`,
        'scripts/extensions/quick-reply/src/lazy.js': `import {QuickReplySet} from './QuickReplySet.js';
            globalThis.lazyQuickReplyStarts=(globalThis.lazyQuickReplyStarts||0)+1;export {QuickReplySet};`,
    });
    const manifest = { files: {} };
    const core = await bundleRuntimeCore({ runtimeRoot: root, manifest });
    const coreBefore = await readFile(join(root, 'script.js'));
    const libraryBefore = await readFile(join(root, 'lib.js'));
    const quickReply = await bundleQuickReply({ runtimeRoot: root, manifest });
    assert.equal(quickReply.module_count, 2);
    assert.ok(Object.keys(quickReply.modules).every(path => path.startsWith('scripts/extensions/quick-reply/')));
    assert.ok(quickReply.external.includes('/module/dialogue/script.js'));
    assert.ok(quickReply.external.includes('/module/dialogue/lib.js'));
    assert.ok(quickReply.external.includes('/module/dialogue/scripts/extensions/quick-reply/src/lazy.js'));
    assert.deepEqual(await readFile(join(root, 'script.js')), coreBefore);
    assert.deepEqual(await readFile(join(root, 'lib.js')), libraryBefore);
    assert.strictEqual(manifest.core_bundle, core);
    const host = moduleHost(root);
    const runtime = await host.load('/module/dialogue/script.js');
    assert.equal(host.context.globalThis.quickReplyStarts, undefined, 'core must not eagerly activate Quick Reply');
    runtime.setChat([{ id: 1 }]);
    const entry = await host.load('/module/dialogue/scripts/extensions/quick-reply/index.js');
    const rootAlias = await host.load('/scripts/extensions/quick-reply/index.js');
    const consumer = await host.load('/module/dialogue/scripts/extensions/quick-reply/api/consumer.js');
    const classModule = await host.load('/module/dialogue/scripts/extensions/quick-reply/src/QuickReplySet.js');
    assert.equal(host.context.globalThis.quickReplyStarts, 1);
    assert.equal(host.context.globalThis.libraryStarts, 1);
    assert.equal(entry.quickReplyApi, undefined, 'activation hook still controls init');
    assert.strictEqual(entry.chat, runtime.chat);
    assert.strictEqual(entry.eventSource, runtime.eventSource);
    assert.strictEqual(entry.extension_settings, runtime.extension_settings);
    assert.strictEqual(entry.QuickReplySet, classModule.QuickReplySet);
    assert.strictEqual(entry.QuickReplySet, consumer.QuickReplySet);
    assert.strictEqual(entry.QuickReplySet.library, runtime.library);
    await entry.init();
    assert.strictEqual(entry.quickReplyApi, consumer.quickReplyApi);
    assert.strictEqual(entry.quickReplyApi, rootAlias.quickReplyApi);
    assert.strictEqual(entry.quickReplyApi.chat, runtime.chat);
    runtime.setChat([{ id: 2 }]);
    assert.strictEqual(entry.chat, runtime.chat);
    assert.strictEqual(rootAlias.chat, runtime.chat);
    assert.equal(host.context.globalThis.lazyQuickReplyStarts, undefined);
    assert.strictEqual((await entry.lazy()).QuickReplySet, entry.QuickReplySet);
    assert.equal(host.context.globalThis.lazyQuickReplyStarts, 1);
    assert.deepEqual(Array.from(host.context.globalThis.sequence), ['core', 'qr:class', 'qr:entry', 'qr:activate', 'qr:autoexec']);
    for (const [path, record] of Object.entries(manifest.files)) assert.equal(record.output, hash(await readFile(join(root, path.replace(/^runtime\//, '')))), path);
});

test('Quick Reply unknown cross-extension dependencies fail closed without source replacement', async t => {
    const root = await fixture(t, {
        'script.js': 'export const core={};',
        'scripts/extensions/quick-reply/index.js': 'import {other} from "../other/index.js";export {other};',
        'scripts/extensions/other/index.js': 'export const other={};',
    });
    const manifest = { files: {} };
    await bundleRuntimeCore({ runtimeRoot: root, manifest });
    const before = await readFile(join(root, 'scripts/extensions/quick-reply/index.js'));
    await assert.rejects(bundleQuickReply({ runtimeRoot: root, manifest }), /Unknown Quick Reply dependency/);
    assert.deepEqual(await readFile(join(root, 'scripts/extensions/quick-reply/index.js')), before);
    assert.equal(manifest.extension_bundles, undefined);
});

test('Quick Reply cannot be bundled without a verified core boundary manifest', async t => {
    const root = await fixture(t, { 'scripts/extensions/quick-reply/index.js': 'export const value=1;' });
    await assert.rejects(bundleQuickReply({ runtimeRoot: root, manifest: { files: {} } }), /verified core export manifest/);
});

test('dry audit/compile never mutates the source inputs', async t => {
    const root = await fixture(t, { 'script.js': 'export const original = 1;' });
    const before = await readFile(join(root, 'script.js'));
    const result = await bundleRuntimeCore({ runtimeRoot: root, writeAssets: false });
    assert.equal(result.module_count, 1);
    assert.deepEqual(await readFile(join(root, 'script.js')), before);
    assert.deepEqual(await readdir(root), ['script.js']);
});

for (const [description, files, error] of [
    ['core import.meta URLs', { 'script.js': 'export const url=import.meta.url;' }, /import.meta relocation/],
    ['computed relative imports', { 'script.js': 'export function load(name){return import(name)}' }, /Unverified computed dynamic/],
    ['bare imports', { 'script.js': 'import value from "unresolved-package";export {value};' }, /Bare runtime import/],
    ['core query identities', { 'script.js': 'import "./a.js?v=1";', 'a.js': 'export const value=1;' }, /distinct identity/],
    ['mount traversal', { 'script.js': 'import "../outside.js";' }, /escapes its asset mount/],
    ['missing modules', { 'script.js': 'import "./missing.js";' }, /ENOENT/],
]) test(`fail closed before writing for ${description}`, async t => {
    const root = await fixture(t, files);
    const before = await readFile(join(root, 'script.js'));
    await assert.rejects(bundleRuntimeCore({ runtimeRoot: root }), error);
    assert.deepEqual(await readFile(join(root, 'script.js')), before);
    assert.equal((await readdir(root)).includes('scripts'), false);
});

test('verified absolute extension manifest hook is preserved, but a changed helper is rejected', async t => {
    const good = `function extensionAssetUrl(path){return new URL('scripts/extensions/'+path,document.baseURI).href}
        export async function callExtensionHook(name){const url=extensionAssetUrl(name+'/index.js');return import(url)}`;
    const root = await fixture(t, { 'script.js': 'export * from "./scripts/extensions.js";', 'scripts/extensions.js': good });
    const result = await bundleRuntimeCore({ runtimeRoot: root });
    assert.equal(result.modules['scripts/extensions.js'].dynamic_imports[0].absolute_expression, 'extensionAssetUrl(...).href');
    const badRoot = await fixture(t, { 'script.js': 'export * from "./scripts/extensions.js";',
        'scripts/extensions.js': good.replace("new URL('scripts/extensions/'+path,document.baseURI).href", "'./'+path") });
    await assert.rejects(bundleRuntimeCore({ runtimeRoot: badRoot }), /Unverified computed dynamic/);
});

}
