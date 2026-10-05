import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../.web-cache/tree/frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const start = source.indexOf('function acceptsRuntimeTransition(');
const end = source.indexOf('function modelData(', start);
assert.ok(start >= 0 && end > start);

function fixture() {
  const calls = [];
  const frame = { contentWindow: {} };
  const context = vm.createContext({
    frame, location: { origin: 'http://fixture.invalid' }, HOST_CHANNEL: 'homer:dialogue-host:v1',
    activeAppId: 'owned-card', activeConversationId: 'owned-conversation', adminPreview: false,
    coreReady: false, bridgeAvailable: false, prewarming: false, runtimeBound: false,
    runtimeLaunchEpoch: 0, runtimeLaunchSequence: 0, runtimeLaunchOwner: '', runtimeEngineToken: '', runtimePriorDocument: null,
    runtimeAccountBlocked: false, runtimeAccountEpoch: 0, runtimeColdPending: false, runtimeColdFailed: false, runtimeColdFlight: null,
    runtimeBindingPrefix: 'fixture-host-document',
    switchShellScope: '', pendingCommands: [], performance: { mark() {} },
    updateVisibleConversationUrl(app, conv) { context.activeAppId = app; context.activeConversationId = conv; },
    showConversationSwitchShell(message) { context.updateVisibleConversationUrl(message.app_id, message.conversation_id); },
    markReady(name, options) { calls.push({ name, stateScheduled: options?.stateScheduled }); },
    showToast() {},
  });
  vm.runInContext(source.slice(source.indexOf('function runtimeBindingOwner('), source.indexOf('function openRuntimeTool('))
    + '\n' + source.slice(start, end), context);
  return { calls, context, send(payload = {}, event = {}) {
    context.handleRuntimeMessage({ origin: context.location.origin, source: frame.contentWindow,
      data: { channel: context.HOST_CHANNEL, version: 1, type: 'ready', admin_preview: false,
        app_id: 'owned-card', conversation_id: 'owned-conversation', role_name: 'Owned card', ...payload }, ...event });
  } };
}

test('actual host ready explicitly acknowledges only a boolean scheduled state', () => {
  for (const value of [true, false, undefined, 'true', 1]) {
    const h = fixture(); h.send({ state_scheduled: value });
    assert.deepEqual(h.calls, [{ name: 'Owned card', stateScheduled: value === true }]);
    assert.equal(h.context.runtimeBound, true);
  }
});

test('scheduled-state capability never bypasses ready origin/source/scope gates', () => {
  const cases = [
    [{ app_id: 'old-card' }, {}], [{ conversation_id: 'old-conversation' }, {}],
    [{ admin_preview: true }, {}], [{ version: 2 }, {}], [{ channel: 'wrong' }, {}],
    [{}, { origin: 'https://untrusted.invalid' }], [{}, { source: {} }],
  ];
  for (const [payload, event] of cases) {
    const h = fixture(); h.send({ state_scheduled: true, ...payload }, event);
    assert.equal(h.calls.length, 0);
    assert.equal(h.context.runtimeBound, false);
  }
});

test('accepted switch recovery uses scheduled state; wrong failed scope remains rejected', () => {
  for (const valid of [true, false]) {
    const h = fixture(); h.send({ type: 'conversation-switch-failed', state_scheduled: true,
      failed_app_id: valid ? 'owned-card' : 'other-card', failed_conversation_id: 'owned-conversation',
      app_id: 'restored-card', conversation_id: 'restored-conversation', role_name: 'Restored' });
    assert.deepEqual(h.calls, valid ? [{ name: 'Restored', stateScheduled: true }] : []);
  }
});
