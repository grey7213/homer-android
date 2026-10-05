import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const host = readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const render = host.slice(host.indexOf('function renderConversation('), host.indexOf('\nfunction renderHistory(', host.indexOf('function renderConversation(')));
const helperBegin = host.indexOf('function setPreviewAvatarSource(');
const helper = helperBegin < 0 ? '' : host.slice(helperBegin, host.indexOf('\nfunction renderConversation(', helperBegin));
const base = 'https://fixture.invalid/app/chat.html';

class ImageFixture extends EventTarget {
    constructor(source) { super(); this.source = source; this.writes = []; this.complete = false; }
    getAttribute(name) { return name === 'src' ? this.source : null; }
    get src() { return new URL(this.source, base).href; }
    set src(value) { this.source = String(value); this.writes.push(this.source); this.complete = false; }
}

function harness() {
    const image = new ImageFixture('/assets/img/apk/avatar.webp');
    const settingsImage = new ImageFixture('/assets/img/apk/avatar.webp');
    const settingTitle = { textContent: '' };
    const scope = {
        URL, location: { href: base }, previewAvatar: image, previewTitle: { textContent: '' },
        activeConversationId: 'fixture-conversation', activeAppId: 'fixture-card',
        runtimeReady: true, switchShellScope: '', scopedKey: key => `${key}:owner:fixture-owner`,
        appearance: { refresh() {} }, pendingDraft: '', history: [],
        renderMessages() {}, writeCachedConversation() {}, setDocumentTitle() {}, renderHistory() {},
        document: { querySelector(selector) {
            return selector === '#preview-settings-avatar' ? settingsImage : settingTitle;
        } },
    };
    vm.createContext(scope);
    vm.runInContext(helper + '\n' + render, scope);
    const mainFallbackBegin = host.indexOf("previewAvatar.addEventListener('error',");
    const mainFallback = host.slice(mainFallbackBegin, host.indexOf('\nmenuButton.addEventListener(', mainFallbackBegin));
    const settingsFallbackBegin = host.indexOf("document.querySelector('#preview-settings-avatar').addEventListener('error',");
    const settingsFallback = host.slice(settingsFallbackBegin, host.indexOf('\nconst appearance =', settingsFallbackBegin));
    vm.runInContext(mainFallback + '\n' + settingsFallback, scope);
    const renderAvatar = avatar => scope.renderConversation({
        conversation_id: 'fixture-conversation', app_id: 'fixture-card', title: 'Fixture', avatar, messages: [],
    }, { save: false });
    return { scope, image, settingsImage, renderAvatar };
}

test('repeated actual host snapshot paints do not reset either pending same-cover image request', () => {
    const h = harness();
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    const before = [h.image.writes.length, h.settingsImage.writes.length];
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    assert.deepEqual([h.image.writes.length, h.settingsImage.writes.length], before);
    assert.equal(h.image.complete, false);
});

test('relative and absolute forms of one cover URL remain one request', () => {
    const h = harness();
    h.renderAvatar('/media-cache/cover/fixture-a.png?revision=one');
    const before = [h.image.writes.length, h.settingsImage.writes.length];
    h.renderAvatar('https://fixture.invalid/media-cache/cover/fixture-a.png?revision=one');
    assert.deepEqual([h.image.writes.length, h.settingsImage.writes.length], before);
});

test('real card changes and revised cover query update both image sources', () => {
    const h = harness();
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    h.renderAvatar('/media-cache/cover/fixture-b.png');
    h.renderAvatar('/media-cache/cover/fixture-b.png?revision=two');
    for (const image of [h.image, h.settingsImage]) {
        assert.equal(image.writes.length, 3);
        assert.equal(image.src, 'https://fixture.invalid/media-cache/cover/fixture-b.png?revision=two');
    }
});

test('actual error fallback still permits a later snapshot to retry the intended cover', () => {
    const h = harness();
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    for (const image of [h.image, h.settingsImage]) image.dispatchEvent(new Event('error'));
    assert.equal(new URL(h.image.src).pathname, '/assets/img/apk/avatar.webp');
    assert.equal(new URL(h.settingsImage.src).pathname, '/assets/img/apk/avatar.webp');
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    for (const image of [h.image, h.settingsImage]) {
        assert.equal(image.writes.length, 3);
        assert.equal(new URL(image.src).pathname, '/media-cache/cover/fixture-a.png');
    }
});

test('missing snapshot avatar keeps existing header behavior and avoids repeating settings fallback src', () => {
    const h = harness();
    h.renderAvatar('/media-cache/cover/fixture-a.png');
    h.renderAvatar('');
    const before = [h.image.writes.length, h.settingsImage.writes.length];
    h.renderAvatar('');
    assert.deepEqual([h.image.writes.length, h.settingsImage.writes.length], before);
    assert.equal(new URL(h.image.src).pathname, '/media-cache/cover/fixture-a.png');
    assert.equal(new URL(h.settingsImage.src).pathname, '/assets/img/apk/avatar.webp');
});

test('actual shared source setter only skips normalized same URL, without suppressing new cover assignment', () => {
    const h = harness();
    assert.equal(typeof h.scope.setPreviewAvatarSource, 'function');
    h.scope.setPreviewAvatarSource(h.image, '/media-cache/cover/fixture-a.png#portrait');
    h.scope.setPreviewAvatarSource(h.image, 'https://fixture.invalid/media-cache/cover/fixture-a.png#portrait');
    assert.equal(h.image.writes.length, 1);
    h.scope.setPreviewAvatarSource(h.image, '/media-cache/cover/fixture-b.png');
    assert.equal(h.image.writes.length, 2);
});
