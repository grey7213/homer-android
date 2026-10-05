import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const ready = source.slice(source.indexOf('function markReady('), source.indexOf('function visiblePreviewText('));

function harness({ pending = null, draftDirty = false } = {}) {
  const commands = [], timers = [], classes = new Set(['has-preview', 'shell-right-open']);
  const dialog = { open: true, value: '0.73', close() { this.open = false; } };
  const context = {
    document: { body: { classList: {
      add(...values) { values.forEach(value => classes.add(value)); },
      remove(...values) { values.forEach(value => classes.delete(value)); },
    } } },
    window: { clearTimeout() {}, setTimeout(callback) { timers.push(callback); } },
    clearReadyTimer() {}, adminPreview: false, adminBindPending: true, frame: { inert: true },
    runtimeReady: false, runtimeOverlayActive: false, setRuntimeOverlay() {},
    insetsSignature: 'old', syncHostInsets() {}, composerDraftDirty: draftDirty,
    previewInput: { value: 'unsent draft' }, previewRequestId: 0, readyHandoffTimer: 0,
    activeConversationId: 'chat-a', pendingTool: pending,
    setDocumentTitle() {}, flushRuntimeCommands() {},
    postRuntimeCommand(type, payload, options) { commands.push({ type, ...payload, ...options }); },
    launcherVisual: {}, launcher: { setAttribute() {} }, composerUi: { refresh() {} }, announcer: {},
    modelDialog: dialog, closeDrawers() { classes.delete('shell-right-open'); },
  };
  vm.createContext(context); vm.runInContext(ready, context);
  return { context, commands, timers, classes, dialog };
}

test('real ready handoff retains the host, open drawer and unsaved model values', () => {
  const h = harness(); h.context.markReady('same card');
  // The old 80ms callback closed the model page. Execute any scheduled work,
  // so reintroducing that timer fails rather than merely checking initial paint.
  h.timers.forEach(callback => callback());
  assert.equal(h.context.runtimeReady, true);
  assert.equal(h.context.frame.inert, false);
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.value, '0.73');
  assert.ok(h.classes.has('has-preview'));
  assert.ok(h.classes.has('shell-right-open'));
  assert.ok(h.classes.has('is-ready'));
});

test('repeated ready notifications cannot dismiss an interactive model page', () => {
  const h = harness(); h.context.markReady(); h.context.markReady();
  h.timers.forEach(callback => callback());
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.value, '0.73');
  assert.equal(h.timers.length, 0);
});

test('an explicit scheduled-state ready avoids only the duplicate state request', () => {
  const h = harness({ draftDirty: true });
  h.context.markReady('same card', { stateScheduled: true });
  assert.equal(h.commands.filter(command => command.type === 'request-state').length, 0);
  assert.equal(h.commands.filter(command => command.type === 'composer-text').length, 1);
  assert.equal(h.context.runtimeReady, true);
  assert.ok(h.classes.has('is-ready'));
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.value, '0.73');
});

test('missing, false or non-boolean scheduled-state still requests current state', () => {
  for (const option of [undefined, {}, { stateScheduled: false }, { stateScheduled: 'true' }, { stateScheduled: 1 }]) {
    const h = harness(); h.context.markReady('same card', option);
    assert.equal(h.commands.filter(command => command.type === 'request-state').length, 1);
    assert.equal(h.context.runtimeReady, true);
    assert.equal(h.dialog.open, true);
  }
});

test('ready syncs the current draft without replacing model edits', () => {
  const h = harness({ draftDirty: true }); h.context.markReady();
  assert.deepEqual(h.commands.filter(command => command.type === 'composer-text'),
    [{ type: 'composer-text', content: 'unsent draft', queue: false }]);
  assert.equal(h.dialog.open, true);
  assert.equal(h.context.composerDraftDirty, false);
});

test('a deliberately queued runtime tool transfers only for its own conversation', () => {
  for (const conversation of ['chat-a', 'old-chat']) {
    let closed = 0;
    const h = harness({ pending: { section: 'memory', conversation, dialog: { close() { closed++; } } } });
    h.context.markReady();
    assert.equal(closed, 1);
    assert.equal(h.context.pendingTool, null);
    assert.equal(h.commands.filter(command => command.type === 'open-settings').length, conversation === 'chat-a' ? 1 : 0);
    assert.equal(h.dialog.open, true, 'the user-owned model page is not the temporary pending-tool dialog');
  }
});
