import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/app/assets/js/chat.js', import.meta.url), 'utf8');
const begin = source.indexOf('let navigationPending =');
const code = source.slice(begin, source.indexOf("frame.addEventListener('error'", begin));
assert.ok(begin > 0 && code.includes('handleRetainedConversationNavigation'));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture({ busy = true, stopCompletes = true } = {}) {
  const listeners = new Map(), decisions = [], stops = [], switches = [], launches = [], toasts = [];
  let owner = 'synthetic-owner', clock = 0;
  const scope = vm.createContext({ URL, Date: { now: () => clock },
    location: { href: 'https://synthetic.invalid/app/chat.html?app_id=a&conversation_id=ca', origin: 'https://synthetic.invalid' },
    runtimeBindingOwner: () => owner, runtimeAccountEpoch: 1, runtimeAccountBlocked: false,
    activeAppId: 'a', activeConversationId: 'ca', launchRequestId: 1, runtimeEngineToken: 'engine-a',
    runtimeState: { generating: busy }, pendingDraft: '', pendingAdminCard: '', adminBindPending: false,
    runtimeReady: true, requestedPresentation: null,
    window: { addEventListener: (name, fn) => listeners.set(name, fn),
      setTimeout(fn) { clock += 5000; queueMicrotask(fn); return 1; } },
    confirmAction(message, options) { const decision = deferred(); decisions.push({ ...decision, message, options }); return decision.promise; },
    showToast: (...args) => toasts.push(args),
    stopDraft() { stops.push(scope.activeConversationId); if (stopCompletes) { scope.runtimeState.generating = false; scope.pendingDraft = ''; } },
    clearVisibleGameRequest: () => false, postRuntimeCommand() {}, openAdminPreview() {}, updateVisibleConversationUrl() {},
    switchConversation(app, conversation) { switches.push([app, conversation]); scope.activeAppId = app; scope.activeConversationId = conversation; },
    resolveLaunchTarget(id, url, options) { const launch = deferred(); launches.push({ ...launch, id, url, options }); return launch.promise; },
  });
  vm.runInContext(code, scope);
  const url = (app = 'b', conversation = 'cb') => `https://synthetic.invalid/app/chat.html?app_id=${app}${conversation ? '&conversation_id=' + conversation : ''}`;
  function navigate(target = url()) { let handled = false; listeners.get('homer:navigate-conversation')({ detail: { url: target }, preventDefault() { handled = true; } }); return handled; }
  async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  return { scope, decisions, stops, switches, launches, toasts, url, navigate, settle, owner: value => { owner = value; } };
}

test('actual retained busy navigation cancels without stop, creation, URL mutation or fallback', async () => {
  const h = fixture(); assert.equal(h.navigate(), true); assert.equal(h.decisions.length, 1);
  assert.equal(h.decisions[0].options.confirmText, '停止并切换');
  h.decisions[0].resolve(false); await h.settle();
  assert.equal(h.scope.activeConversationId, 'ca'); assert.equal(h.stops.length, 0);
  assert.equal(h.switches.length, 0); assert.equal(h.launches.length, 0);
});
test('actual confirmed stop switches the selected canonical target once without replaying generation', async () => {
  const h = fixture(); h.navigate(); h.decisions[0].resolve(true); await h.settle();
  assert.deepEqual(h.stops, ['ca']); assert.deepEqual(h.switches, [['b', 'cb']]); assert.equal(h.launches.length, 0);
});
test('duplicate taps while the decision is open do not stack, create or stop twice', async () => {
  const h = fixture(); h.navigate(); h.navigate(h.url('c', 'cc'));
  assert.equal(h.decisions.length, 1); assert.ok(h.toasts.some(([text]) => text.includes('切换确认')));
  h.decisions[0].resolve(true); await h.settle();
  assert.deepEqual(h.switches, [['b', 'cb']]); assert.equal(h.stops.length, 1);
});
for (const change of ['owner', 'same-owner-relogin', 'conversation', 'engine', 'launch', 'logout']) {
  test(`late stop confirmation is fenced after ${change}`, async () => {
    const h = fixture(); h.navigate();
    if (change === 'owner') h.owner('synthetic-other');
    if (change === 'same-owner-relogin') h.scope.runtimeAccountEpoch++;
    if (change === 'conversation') h.scope.activeConversationId = 'cc';
    if (change === 'engine') h.scope.runtimeEngineToken = 'engine-new';
    if (change === 'launch') h.scope.launchRequestId++;
    if (change === 'logout') h.scope.runtimeAccountBlocked = true;
    h.decisions[0].resolve(true); await h.settle();
    assert.equal(h.stops.length, 0); assert.equal(h.switches.length, 0); assert.equal(h.launches.length, 0);
  });
}
test('actual stop timeout stays in current archive with explicit feedback and no target creation', async () => {
  const h = fixture({ stopCompletes: false }); h.navigate(); h.decisions[0].resolve(true); await h.settle();
  assert.equal(h.scope.activeConversationId, 'ca'); assert.equal(h.switches.length, 0); assert.equal(h.launches.length, 0);
  assert.ok(h.toasts.some(([text]) => text.includes('停止尚未完成')));
});
test('actual new-card navigation resolves without activating the old frame, then switches exactly once', async () => {
  const h = fixture({ busy: false }); h.navigate(h.url('new', ''));
  assert.equal(h.launches.length, 1); assert.equal(h.launches[0].options.activate, false);
  assert.equal(h.scope.activeConversationId, 'ca'); h.navigate(h.url('new', ''));
  assert.equal(h.launches.length, 1);
  h.launches[0].resolve(new URL('https://synthetic.invalid/module/dialogue/?homer_app_id=new&homer_conversation_id=cnew'));
  await h.settle(); assert.deepEqual(h.switches, [['new', 'cnew']]);
});
test('generation starting during target resolution reuses the resolved ID through real confirmation, not a second create', async () => {
  const h = fixture({ busy: false }); h.navigate(h.url('new', ''));
  h.scope.runtimeState.generating = true;
  h.launches[0].resolve(new URL('https://synthetic.invalid/module/dialogue/?homer_app_id=new&homer_conversation_id=cnew'));
  await h.settle(); assert.equal(h.decisions.length, 1); assert.equal(h.scope.activeConversationId, 'ca');
  h.decisions[0].resolve(true); await h.settle(); assert.deepEqual(h.switches, [['new', 'cnew']]); assert.equal(h.launches.length, 1);
});
test('late resolved new-card target cannot route after account epoch changed', async () => {
  const h = fixture({ busy: false }); h.navigate(h.url('new', '')); h.scope.runtimeAccountEpoch++;
  h.launches[0].resolve(new URL('https://synthetic.invalid/module/dialogue/?homer_app_id=new&homer_conversation_id=cnew'));
  await h.settle(); assert.equal(h.switches.length, 0); assert.equal(h.scope.activeConversationId, 'ca');
});
test('preparation refusal remains explicit and does not send an ordinary create request', () => {
  const h = fixture({ busy: false }); h.scope.pendingAdminCard = 'admin-card'; assert.equal(h.navigate(), true);
  assert.equal(h.launches.length, 0); assert.equal(h.switches.length, 0); assert.equal(h.toasts.length, 1);
});
