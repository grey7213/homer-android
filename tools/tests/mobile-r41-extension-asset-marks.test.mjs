import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const path = new URL('../../sillytavern-runtime/public/scripts/extension-asset-loader.js', import.meta.url);
const source = await readFile(path, 'utf8');

function fixture({ throwMark = false, existing = null } = {}) {
    const marks = [];
    const appended = [];
    const elements = new Map();
    function element(tag) {
        const listeners = new Map();
        return {
            tag, id: '', dataset: {}, sheet: null,
            addEventListener(name, handler) {
                const queue = listeners.get(name) || [];
                queue.push(handler);
                listeners.set(name, queue);
            },
            fire(name) {
                const queue = listeners.get(name) || [];
                listeners.delete(name);
                queue.forEach(handler => handler());
            },
            remove() { elements.delete(this.id); },
        };
    }
    const append = node => { appended.push(node); elements.set(node.id, node); };
    const document = {
        getElementById: id => elements.get(id),
        createElement: element,
        head: { appendChild: append }, body: { appendChild: append },
    };
    if (existing) {
        const node = Object.assign(element('link'), existing);
        elements.set(node.id, node);
    }
    const context = vm.createContext({
        document, performance: { mark(name) {
            if (throwMark) throw new Error('performance unavailable');
            marks.push(name);
        } },
    });
    vm.runInContext(source.replace('export function loadExtensionAsset', 'function loadExtensionAsset')
        + '\nglobalThis.loader = loadExtensionAsset;', context);
    return { document, load: context.loader, marks, appended, elements };
}

test('script marks append then actual load without treating append as readiness', async () => {
    const f = fixture();
    const operation = f.load({ document: f.document, kind: 'script', id: 'third-party-memory-js',
        url: '/scripts/entry.js?revision=example' });
    const node = f.appended[0];
    assert.equal(node.type, 'module');
    assert.equal(node.async, true);
    assert.equal(node.dataset.extensionLoad, 'loading');
    assert.deepEqual(f.marks, ['homer-extension-asset-append:script:third-party-memory-js']);
    let settled = false;
    operation.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    node.fire('load');
    await operation;
    assert.equal(node.dataset.extensionLoad, 'ready');
    assert.deepEqual(f.marks, ['homer-extension-asset-append:script:third-party-memory-js',
        'homer-extension-asset-load:script:third-party-memory-js']);
    assert.equal(f.marks.some(name => name.includes('?') || name.includes('revision')), false);
});

test('style marks and single-flight join preserve one append and one load', async () => {
    const f = fixture();
    const options = { document: f.document, kind: 'style', id: 'memory-css', url: '/style.css?test=1' };
    const first = f.load(options);
    assert.strictEqual(f.load(options), first);
    assert.equal(f.appended.length, 1);
    assert.equal(f.appended[0].rel, 'stylesheet');
    f.appended[0].fire('load');
    await first;
    await f.load(options);
    assert.deepEqual(f.marks, ['homer-extension-asset-append:style:memory-css',
        'homer-extension-asset-load:style:memory-css']);
});

test('failure records error and retains replacement retry semantics', async () => {
    const f = fixture();
    const options = { document: f.document, kind: 'script', id: 'retry-js', url: '/retry.js' };
    const first = f.load(options);
    const rejected = assert.rejects(first, /Extension script failed to load/);
    f.appended[0].fire('error');
    await rejected;
    assert.equal(f.appended[0].dataset.extensionLoad, 'error');
    const second = f.load(options);
    assert.notStrictEqual(second, first);
    assert.equal(f.appended.length, 2);
    f.appended[1].fire('load');
    await second;
    assert.deepEqual(f.marks, ['homer-extension-asset-append:script:retry-js',
        'homer-extension-asset-error:script:retry-js',
        'homer-extension-asset-append:script:retry-js',
        'homer-extension-asset-load:script:retry-js']);
});

test('already available style is distinguished from an observed load event', async () => {
    const f = fixture({ existing: { id: 'existing-css', sheet: {} } });
    await f.load({ document: f.document, kind: 'style', id: 'existing-css', url: '/existing.css' });
    assert.equal(f.appended.length, 0);
    assert.deepEqual(f.marks, ['homer-extension-asset-available:style:existing-css']);
});

test('invalid diagnostic IDs never leak query-like or account-like identifiers', async () => {
    const f = fixture();
    const operation = f.load({ document: f.document, kind: 'script', id: 'entry?private=value',
        url: 'https://example.invalid/entry.js?private=value' });
    f.appended[0].fire('load');
    await operation;
    assert.deepEqual(f.marks, ['homer-extension-asset-append:script:unknown',
        'homer-extension-asset-load:script:unknown']);
});

test('diagnostic failure cannot reject or wedge the asset load', async () => {
    const f = fixture({ throwMark: true });
    const operation = f.load({ document: f.document, kind: 'script', id: 'normal-js', url: '/normal.js' });
    f.appended[0].fire('load');
    await operation;
    assert.equal(f.appended[0].dataset.extensionLoad, 'ready');
});
