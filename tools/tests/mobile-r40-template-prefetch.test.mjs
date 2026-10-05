import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Shipping template helper, with synthetic XHR/compiler/locale peripherals.
// This tests cache and rendering invariants, not Android latency.
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/templates.js', import.meta.url), 'utf8');
const startup = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const requests = [], compiled = [], rendered = [], sanitized = [], localized = [], errors = [];
    const syncBodies = new Map();
    let locale = 'one', active = 0, peak = 0;
    class XHR {
        open(method, path, async) { this.method = method; this.path = path; this.async = async; }
        send() {
            requests.push(this);
            if (!this.async) {
                this.status = 200; this.responseText = syncBodies.get(this.path) || 'SYNC {{name}}';
                return;
            }
            ++active; peak = Math.max(peak, active);
        }
        reply(status = 200, text = 'TEXT {{name}}') {
            assert.equal(this.done, undefined); this.done = true; --active;
            this.status = status; this.statusText = `Fixture ${status}`; this.responseText = text;
            this.onload();
        }
        fail() {
            assert.equal(this.done, undefined); this.done = true; --active;
            this.status = 0; this.statusText = 'Fixture transport failure'; this.onerror();
        }
    }
    const scope = {
        XMLHttpRequest: XHR,
        Handlebars: { compile(body) {
            compiled.push(body);
            return data => {
                rendered.push({ body, data: { ...data } });
                return body.replace(/\{\{(\w+)\}\}/g, (_match, key) => String(data[key] ?? ''));
            };
        } },
        DOMPurify: { sanitize(value) {
            sanitized.push(value);
            return value.replace(/<script>[\s\S]*?<\/script>/g, '');
        } },
        applyLocale(value) { localized.push({ value, locale }); return value.replaceAll('TEXT', locale); },
        console: { debug() {}, error() {} }, toastr: { error(message) { errors.push(message); } },
    };
    vm.createContext(scope);
    vm.runInContext(source.replace(/^import .+;\r?$/gm, '').replace(/^export /gm, '')
        + '\nglobalThis.shipping = {renderTemplateAsync, renderTemplate, prefetchStartupTemplates};', scope);
    return { ...scope.shipping, requests, compiled, rendered, sanitized, localized, errors, syncBodies,
        setLocale(value) { locale = value; }, peak: () => peak };
}

test('concurrent renders single-flight one XHR and render distinct data', async () => {
    const h = harness();
    const first = h.renderTemplateAsync('unit', { name: 'first' });
    const second = h.renderTemplateAsync('unit', { name: 'second' });
    assert.equal(h.requests.length, 1);
    h.requests[0].reply();
    assert.deepEqual(await Promise.all([first, second]), ['one first', 'one second']);
    assert.equal(h.compiled.length, 1);
    assert.equal(h.rendered.length, 2);
    assert.equal(h.sanitized.length, 2);
    assert.equal(h.localized.length, 2);
    assert.equal(await h.renderTemplateAsync('unit', { name: 'third' }), 'one third');
    assert.equal(h.requests.length, 1, 'completed template is retained in this runtime');
});

test('HTTP and transport failures leave no poisoned pending cache', async () => {
    for (const failure of ['http', 'transport']) {
        const h = harness();
        const first = h.renderTemplateAsync('retry');
        const second = h.renderTemplateAsync('retry');
        if (failure === 'http') h.requests[0].reply(500); else h.requests[0].fail();
        assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
        const retry = h.renderTemplateAsync('retry', { name: 'recovered' });
        assert.equal(h.requests.length, 2);
        h.requests[1].reply();
        assert.equal(await retry, 'one recovered');
        assert.equal(h.compiled.length, 1);
    }
});

test('rendered HTML, locale and sanitation flags are never cached', async () => {
    const h = harness();
    const first = h.renderTemplateAsync('dynamic', { name: 'one' });
    h.requests[0].reply(200, 'TEXT {{name}}<script>fixture</script>');
    assert.equal(await first, 'one one');
    h.setLocale('two');
    assert.equal(await h.renderTemplateAsync('dynamic', { name: 'two' }), 'two two');
    assert.equal(await h.renderTemplateAsync('dynamic', { name: 'raw' }, false, false), 'TEXT raw<script>fixture</script>');
    assert.equal(h.requests.length, 1);
    assert.equal(h.sanitized.length, 2);
    assert.equal(h.localized.length, 2);
});

test('prefetch shares pending with actual render, has at most three reads, never renders', async () => {
    const h = harness();
    const prefetch = h.prefetchStartupTemplates();
    assert.equal(h.requests.length, 3);
    assert.equal(h.rendered.length, 0);
    const actual = h.renderTemplateAsync('wandButton', { name: 'actual' });
    assert.equal(h.requests.length, 3, 'same original render path joins prefetch');
    h.requests[0].reply();
    assert.equal(await actual, 'one actual');
    for (let turn = 0; turn < 20; ++turn) {
        await tick();
        for (const request of h.requests.filter(item => !item.done)) request.reply();
    }
    await prefetch;
    assert.equal(h.requests.length, 16);
    assert.ok(h.peak() <= 3, 'static prefetch workers bound outstanding transfer');
    assert.equal(h.rendered.length, 1, 'prefetch must not run template helpers or render data');
    assert.equal(h.sanitized.length, 1);
    assert.equal(h.localized.length, 1);
    assert.equal(h.errors.length, 0);
    const reads = h.requests.length;
    await h.prefetchStartupTemplates();
    assert.equal(h.requests.length, reads, 'static prefetch reuses completed factories');
    assert.ok(h.requests.every(item => item.method === 'GET' && item.path.endsWith('.html')));
    assert.ok(h.requests.every(item => !/api\/|character|world|third-party|conversation/.test(item.path)));
});

test('a failed prefetch is silent and ordinary rendering retries', async () => {
    const h = harness();
    const prefetch = h.prefetchStartupTemplates();
    h.requests[0].reply(503);
    for (let turn = 0; turn < 20; ++turn) {
        await tick();
        for (const request of h.requests.filter(item => !item.done)) request.reply();
    }
    await prefetch;
    assert.equal(h.errors.length, 0);
    assert.equal(h.rendered.length, 0);
    const retried = h.renderTemplateAsync('wandButton', { name: 'retry' });
    h.requests.at(-1).reply();
    assert.equal(await retried, 'one retry');
    assert.equal(h.requests.filter(item => item.path === '/scripts/templates/wandButton.html').length, 2);
});

test('sync rendering uses shared completed cache without another read', async () => {
    const h = harness();
    const pending = h.renderTemplateAsync('sync-cache', { name: 'async' });
    h.requests[0].reply();
    assert.equal(await pending, 'one async');
    assert.equal(h.renderTemplate('sync-cache', { name: 'sync' }), 'one sync');
    assert.equal(h.requests.length, 1);
    assert.equal(h.compiled.length, 1);
});

test('synchronous first read keeps its result if async read was already pending', async () => {
    const h = harness();
    h.syncBodies.set('/scripts/templates/race.html', 'SYNC {{name}}');
    const pending = h.renderTemplateAsync('race', { name: 'later' });
    assert.equal(h.renderTemplate('race', { name: 'now' }, false, false), 'SYNC now');
    h.requests[0].reply(200, 'STALE {{name}}');
    assert.equal(await pending, 'SYNC later');
    assert.equal(h.renderTemplate('race', { name: 'still' }, false, false), 'SYNC still');
    assert.equal(h.compiled.length, 1, 'late async response does not overwrite synchronous cache');
    assert.equal(h.requests.length, 2, 'sync API remains immediately usable');
});

test('extension full paths preserve mount semantics and do not alias a template basename', async () => {
    const h = harness();
    const extension = h.renderTemplateAsync('scripts/extensions/tts/settings.html', {}, true, true, true);
    const standard = h.renderTemplateAsync('settings');
    assert.deepEqual(h.requests.map(item => item.path), ['scripts/extensions/tts/settings.html', '/scripts/templates/settings.html']);
    h.requests[0].reply(200, 'extension'); h.requests[1].reply(200, 'standard');
    assert.deepEqual(await Promise.all([extension, standard]), ['extension', 'standard']);
});

test('startup warms only embedded runtime after CSRF, without awaiting before lifecycle', () => {
    const begin = startup.indexOf('async function firstLoadInit()');
    const end = startup.indexOf('async function fixViewport()', begin);
    const init = startup.slice(begin, end);
    const csrf = init.indexOf('token = tokenData.token');
    const prefetch = init.indexOf('void prefetchStartupTemplates()');
    const settings = init.indexOf('await getSettings(');
    const ready = init.indexOf("new CustomEvent('homer:runtime-core-ready')");
    assert.ok(csrf >= 0 && prefetch > csrf && settings > prefetch && ready > settings);
    assert.match(init, /if \(isHomerEmbedded\) \{\s*prefetchExtensionDiscovery\(\);[\s\S]*?void prefetchStartupTemplates\(\);\s*\}/);
    assert.doesNotMatch(init, /await prefetchStartupTemplates\(/);
    assert.match(init, /await getSettings\(initLoaderHandle, startupSettings\)/);
    assert.match(init, /if \(!isHomerEmbedded\) await getCharacters\(\)/);
});
