import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetBallController, publicPresetCatalog } from '../../sillytavern-runtime/public/scripts/extensions/homer-preset-ball/controller.mjs';
const catalog = (id = 'official') => ({ conversation_id: 'a', preset: { current_prompt: { preset_id: id, kind: 'global_prompt', name: 'Official', enabled: true,
  entries: [{ id: 'scene', name: '场景描写', enabled: true, inherited_enabled: true, toggleable: true, user_toggleable: true,
    content: 'MUST_NOT_REACH_COMPONENT', private: { prompt: 'PRIVATE' } },
    { id: 'secret', name: 'PRIVATE_NAME', enabled: true, toggleable: true, user_toggleable: false },
    { id: 'locked', name: 'PRIVATE_LOCKED', enabled: true, toggleable: false, locked: true }] } } });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  const rows = new Map(); let owner = 'user-a', epoch = 1, conversationId = 'a', failSave = false;
  const writes = [], applied = []; let wire = async (scope, body) => ({ conversation_id: scope.conversationId,
    preset_kind: body.preset_kind, preset_id: body.preset_id, items: body.items, runtime_config: catalog() });
  const storage = { getItem: key => rows.get(key) || null, setItem(key, value) { if (failSave) throw new Error('Full'); rows.set(key, value); } };
  const controller = createPresetBallController({ storage,
    current: s => s.owner === owner && s.epoch === epoch && s.conversationId === conversationId,
    request: async (s, b) => { writes.push([s, structuredClone(b)]); return wire(s, b); },
    onApplied: (...args) => applied.push(args) });
  const bind = (id = conversationId, config = catalog()) => { conversationId = id; controller.bind({ owner, epoch, appId: 'card-' + id, conversationId: id }, config); };
  bind(); return { controller, bind, rows, writes, applied, setWire(fn) { wire = fn; },
    switchAccount(next) { owner = next; epoch++; bind(); }, failLocal() { failSave = true; } };
}
test('public catalog never forwards source/private fields, private names or locked entries', () => {
  const c = publicPresetCatalog(catalog()); assert.equal(c.entries.length, 1); assert.equal(c.entries[0].id, 'scene');
  assert.doesNotMatch(JSON.stringify(c), /PRIVATE|"content"|"prompt"|"private"/);
});
test('explicit bound creator preset wins over official; absent binding uses official', () => {
  const c = catalog(); c.preset.card_prompt = { ...c.preset.current_prompt, preset_id: 'creator', kind: 'card_prompt' };
  assert.equal(publicPresetCatalog(c).id, 'creator'); delete c.preset.card_prompt;
  assert.equal(publicPresetCatalog(c).id, 'official');
});
test('local transaction precedes request and confirmed settings affect only this conversation', async () => {
  const f = fixture(); await f.controller.set([{ id: 'scene', enabled: false }]); await tick();
  assert.equal(f.controller.snapshot().entries[0].enabled, false); assert.equal(f.controller.snapshot().pending, false);
  assert.equal(f.writes[0][0].conversationId, 'a'); assert.deepEqual(f.writes[0][1].items, [{ entry_id: 'scene', enabled: false }]);
  assert.equal(f.rows.size, 1); f.bind('b'); assert.equal(f.controller.snapshot().entries[0].enabled, true);
  f.bind('a'); assert.equal(f.controller.snapshot().entries[0].enabled, false);
});
test('offline toggle is durable, visibly pending, blocks generation, and can explicitly retry', async () => {
  const f = fixture(); f.setWire(async () => { throw new Error('Offline'); });
  await f.controller.set([{ id: 'scene', enabled: false }]); await tick();
  assert.equal(f.controller.snapshot().pending, true); assert.match(f.controller.snapshot().status, /本机/);
  assert.throws(f.controller.captureGenerationGuard(), /HM-P001/);
  f.bind('b'); f.bind('a'); assert.equal(f.controller.snapshot().entries[0].enabled, false);
  f.setWire(async (s, b) => ({ conversation_id: s.conversationId, preset_kind: b.preset_kind, preset_id: b.preset_id, items: b.items }));
  assert.equal(await f.controller.retry(), true); f.controller.captureGenerationGuard()();
});
test('late ACK after A/B/A cannot acknowledge or apply runtime into new scope', async () => {
  const f = fixture(), d = defer(); f.setWire(() => d.promise);
  await f.controller.set([{ id: 'scene', enabled: false }]); f.bind('b'); f.bind('a');
  d.resolve({ conversation_id: 'a', preset_kind: 'global_prompt', preset_id: 'official', items: [] }); await tick();
  assert.equal(f.applied.length, 0); assert.equal(f.controller.snapshot().pending, true);
});
test('same owner relogin restores durable choice without accepting old epoch request', async () => {
  const f = fixture(), d = defer(); f.setWire(() => d.promise); await f.controller.set([{ id: 'scene', enabled: false }]);
  f.switchAccount('user-a'); assert.equal(f.controller.snapshot().entries[0].enabled, false);
  d.resolve({ conversation_id: 'a', preset_kind: 'global_prompt', preset_id: 'official', items: [] }); await tick();
  assert.equal(f.applied.length, 0); f.switchAccount('user-b'); assert.equal(f.controller.snapshot().entries[0].enabled, true);
});
test('HTTP-200 errors and cross-preset ACK never become successful settings', async () => {
  const f = fixture(); f.setWire(async () => ({ error: 'denied' })); await f.controller.set([{ id: 'scene', enabled: false }]); await tick();
  assert.equal(f.controller.snapshot().pending, true); assert.match(f.controller.snapshot().status, /HM-P002/);
});
test('local failure causes no optimistic change or network write', async () => {
  const f = fixture(); f.failLocal(); await assert.rejects(f.controller.set([{ id: 'scene', enabled: false }]), /HM-P005/);
  assert.equal(f.controller.snapshot().entries[0].enabled, true); assert.equal(f.writes.length, 0);
});
test('concurrent changes serialize, retain last choice, and do not ACK a later version', async () => {
  const f = fixture(), d = defer(); let calls = 0;
  f.setWire(async (s, b) => { if (++calls === 1) await d.promise; return { conversation_id: s.conversationId, preset_kind: b.preset_kind, preset_id: b.preset_id, items: b.items }; });
  await f.controller.set([{ id: 'scene', enabled: false }]); await f.controller.set([{ id: 'scene', enabled: true }]);
  d.resolve(); await tick(); assert.equal(calls, 2); assert.equal(f.controller.snapshot().pending, false); assert.equal(f.controller.snapshot().entries[0].enabled, true);
});
test('repeated bind and idle retry do not poison later synchronization or generation', async () => {
  const f = fixture(); assert.equal(await f.controller.retry(), true); const guard = f.controller.captureGenerationGuard(); f.bind(); guard();
  await f.controller.set([{ id: 'scene', enabled: false }]); await tick(); assert.equal(f.writes.length, 1); assert.equal(f.controller.snapshot().pending, false);
});
test('generation scope is frozen before extensions; subsequent changed settings reject old request', async () => {
  const f = fixture(), guard = f.controller.captureGenerationGuard(); await f.controller.set([{ id: 'scene', enabled: false }]); await tick();
  assert.throws(guard, /HM-P006/); f.controller.captureGenerationGuard()(); f.bind('b'); assert.throws(guard, /HM-P003/);
});
test('disabled parent preset never presents apparently effective switches', () => {
  const c = catalog(); c.global_preset_enabled = false; assert.equal(publicPresetCatalog(c).entries.length, 0);
});
test('author binding changed during ACK stays pending and cannot generate stale configuration', async () => {
  const f = fixture(); f.setWire(async (s, b) => ({ conversation_id: s.conversationId, preset_kind: b.preset_kind,
    preset_id: b.preset_id, items: b.items, runtime_config: catalog('changed-preset') }));
  await f.controller.set([{ id: 'scene', enabled: false }]); await tick();
  assert.equal(f.applied.length, 0); assert.equal(f.controller.snapshot().pending, true); assert.match(f.controller.snapshot().status, /HM-P007/);
});
test('prototype-looking allowed identifiers remain ordinary own data keys', async () => {
  const f = fixture(), c = catalog(); c.preset.current_prompt.entries[0].id = '__proto__'; f.bind('a', c);
  f.setWire(async (s,b) => ({conversation_id:s.conversationId,preset_kind:b.preset_kind,preset_id:b.preset_id,items:b.items}));
  await f.controller.set([{id:'__proto__',enabled:false}]); await tick();
  assert.equal(f.controller.snapshot().entries[0].enabled,false); assert.equal(f.writes.length,1); assert.equal(f.controller.snapshot().pending,false);
});
test('corrupt durable settings remain visibly blocked and never reset or silently generate', async () => {
  const f = fixture(); await f.controller.set([{id:'scene',enabled:false}]); await tick();
  const key=[...f.rows.keys()][0], old=f.rows.get(key); f.rows.set(key,'broken-json'); f.bind('b'); f.bind('a');
  assert.equal(f.controller.snapshot().bound,true); assert.equal(f.controller.snapshot().pending,true);
  assert.match(f.controller.snapshot().status,/读取失败/); assert.throws(f.controller.captureGenerationGuard(),/HM-P005/);
  await assert.rejects(f.controller.set([{id:'scene',enabled:true}]),/HM-P005/);
  assert.equal(f.rows.get(key),'broken-json'); f.rows.set(key,old); assert.equal(await f.controller.retry(),true);
  assert.equal(f.controller.snapshot().entries[0].enabled,false);
});
test('stale cloud metadata cannot silently change confirmed phone choice or generation', async () => {
  const f=fixture();await f.controller.set([{id:'scene',enabled:false}]);await tick();
  const d=defer();f.setWire(()=>d.promise);f.bind('b');f.bind('a');
  assert.equal(f.controller.snapshot().entries[0].enabled,false);assert.equal(f.controller.snapshot().pending,true);
  assert.throws(f.controller.captureGenerationGuard(),/HM-P001/);
  d.resolve({conversation_id:'a',preset_kind:'global_prompt',preset_id:'official',items:[{entry_id:'scene',enabled:false}]});await tick();
  assert.equal(f.controller.snapshot().pending,false);assert.equal(f.writes.at(-1)[1].items[0].enabled,false);
});
