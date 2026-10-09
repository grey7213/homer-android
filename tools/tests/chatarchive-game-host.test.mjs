import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createGame, applyGameCommand, buildGameContext } from '../../frontend/app/assets/js/visual-novel-game-store.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const bridge = read('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js');
const host = read('../../frontend/app/assets/js/chat.js');
const stage = read('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/card-stage.js');
const openai = read('../../sillytavern-runtime/public/scripts/openai.js');
const script = read('../../sillytavern-runtime/public/script.js');
const worldInfo = read('../../sillytavern-runtime/public/scripts/world-info.js');
const eventEmitter = read('../../sillytavern-runtime/public/lib/eventemitter.js');
const plain = value => JSON.parse(JSON.stringify(value));
function section(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `actual source: ${begin}`);
  return source.slice(start, finish);
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const clone = value => JSON.parse(JSON.stringify(value));

function generationFixture({ importGate, readGate, engineGate, recoveryGate, failEngine = false, failSave = false, noReply = false, realContext = false } = {}) {
  const calls = { imports: 0, reads: [], generate: [], prompts: [], promptWrites: [], stops: 0, saves: 0, drafts: [], builds: 0, listenerErrors: [] };
  const game = { owner: 'owner-a', id: 'game-a', revision: 2,
    characters: [{ id: 'actor-a', appId: 'app-a', conversationId: 'chat-a' }],
    active: { characterId: 'actor-a', channel: 'stage', eventId: '' },
    turns: [{ requestId: 'request-a', characterId: 'actor-a', channel: 'stage', eventId: '', userText: 'Player input', status: 'pending' }] };
  if (realContext) Object.assign(game, applyGameCommand(createGame({ id: 'game-a', owner: 'owner-a', title: 'Synthetic world',
    player: { name: 'Synthetic player' }, world: { scene: 'Game scene', summary: 'GAME-OWNED-CURRENT-BRANCH' },
    characters: [{ id: 'actor-a', appId: 'app-a', conversationId: 'chat-a', versionId: 'version-a', name: 'Synthetic actor', avatar: '' }] }, { now: 1 }),
  { type: 'begin-turn', requestId: 'request-a', characterId: 'actor-a', channel: 'stage', eventId: '', userText: 'Player input' }, { now: 2 }));
  const chat = [{ mes: 'FUTURE-CANONICAL-HISTORY', is_user: false, extra: { homer_sync_id: 'future-a' } }];
  const entries = [{ identifier: 'main', role: 'system', content: 'AUTHORIZED-PRESET' },
    { identifier: 'charDescription', role: 'system', content: 'AUTHORIZED-CHARACTER' },
    { identifier: 'worldInfoBefore', role: 'system', content: 'AUTHORIZED-WORLDBOOK' },
    { identifier: 'chatHistory', role: 'assistant', content: 'FUTURE-CANONICAL-HISTORY' },
    { identifier: 'summary', role: 'system', content: 'OLD-SUMMARY' },
    { identifier: 'authorsNote', role: 'system', content: 'OLD-AUTHORS-NOTE' }];
  const context = { chat, characterId: 0, characters: [{ name: 'Synthetic role', data: { extensions: { world: 'CardWorld' } } }],
    chatMetadata: { homer_bridge: { user_id: 'owner-a', app_id: 'app-a', conversation_id: 'chat-a' } },
    setExtensionPrompt(key, value, ...rest) { calls.promptWrites.push({ key, value, rest }); },
    stopGeneration() { calls.stops++; sandbox.interruptGameTurn(); },
    async generate(type, options) {
      calls.generate.push({ type, options: clone(options) });
      const requestGuard = sandbox.captureArchiveGameRequestGuard(type);
      const data = { chat: entries.map(item => ({ role: item.role, content: item.content })), dryRun: false };
      await sandbox.eventSource.emit('prompt', data);
      const parameters = { messages: [...data.chat, { role: 'assistant', content: 'LATE-ORDINARY-EXTENSION' }] };
      await sandbox.eventSource.emit('settings', parameters);
      requestGuard?.(parameters); calls.prompts.push(clone(parameters.messages));
      if (engineGate) await engineGate.promise;
      if (failEngine) throw new Error('synthetic partial transport failure');
      if (!noReply) chat.push({ mes: 'Canonical new reply', is_user: false, extra: { homer_sync_id: 'reply-a' } });
      return 'Canonical new reply';
    } };
  const noop = () => {};
  const sandbox = vm.createContext({ console: { ...console, debug: noop, trace: noop, error: cause => calls.listenerErrors.push(cause) }, Set, WeakMap,
    localStorage: { getItem: () => null },
    archivePresentationScopes: new WeakMap(), activeArchiveGameId: 'game-a', archiveGameEpoch: 1, activeGameTurn: null,
    archiveGameStorePromise: null, GAME_PROMPT_KEY: 'homer_game_turn',
    storageAccountEpoch: 1, session: { user: { id: 'owner-a' } }, owner: 'owner-a', canonical: true,
    launch: { app_id: 'app-a', conversation_id: 'chat-a', bridge_token: 'synthetic-ephemeral-marker' },
    generationBusy: false, rollbackBusy: false, loadingLaunch: false, conversationRecoveryBlocked: false,
    lastGenerationDiagnostic: null, generationRecoveryChain: recoveryGate?.promise || Promise.resolve(),
    getContext: () => context, isGenerating: () => false,
    reconcileStorageAccount: () => sandbox.owner, hasCanonicalConversationScope: () => sandbox.canonical,
    assertCanonicalConversationScope: () => assert.equal(sandbox.canonical, true),
    async refreshBridgeToken() {}, enforceStreamingConfiguration: noop,
    setComposerDraft: text => calls.drafts.push(text), scheduleHostStateNotify: noop, queueMessageMenuRender: noop,
    document: { body: { classList: { add: noop, toggle: noop } }, dispatchEvent: noop },
    extension_prompt_types: { IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0 },
    promptManager: { serviceSettings: { prompts: [{ identifier: 'main', content: 'AUTHORIZED-PRESET' }] },
      messages: { getCollection: () => entries } }, oai_settings: { squash_system_messages: false },
    event_types: { CHAT_COMPLETION_PROMPT_READY: 'prompt', CHAT_COMPLETION_SETTINGS_READY: 'settings', WORLDINFO_ENTRIES_LOADED: 'lore' },
    async loadGameStoreModule() {
      calls.imports++; if (importGate) await importGate.promise;
      return { createGameStore: () => ({ async get(owner, id) {
        calls.reads.push({ owner, id }); if (readGate) await readGate.promise; return clone(game);
      } }), buildGameContext(value, actorId, channel, eventId) {
        calls.builds++; assert.equal(value.owner, 'owner-a'); assert.equal(actorId, 'actor-a');
        return realContext ? buildGameContext(value, actorId, channel, eventId) : `GAME-OWNED-CURRENT-BRANCH:${channel}:${eventId}`;
      } };
    },
    stableHomerMessageId: message => message?.extra?.homer_sync_id || '',
    serializeChat: () => chat.map((message, index) => ({ ...message, extra: { homer_sync_id: `synthetic-${index}` } })),
    async syncCloudChat(options) { calls.saves++; assert.equal(options.localOnly, true); if (failSave) throw new Error('synthetic quota failure'); },
  });
  vm.runInContext(section(bridge, 'function captureArchivePresentationScope(', 'function sanitizeArchiveStoryData(')
    .replace(/import\('\/app\/assets\/js\/visual-novel-game-store\.mjs\?[^']+'\)/, 'loadGameStoreModule()'), sandbox);
  vm.runInContext(eventEmitter.replace('export { EventEmitter }', '') + '\neventSource = new EventEmitter();', sandbox);
  sandbox.eventSource.on('prompt', sandbox.isolateArchiveGamePrompt);
  sandbox.eventSource.on('settings', sandbox.verifyArchiveGameGeneration);
  sandbox.eventSource.on('lore', sandbox.isolateArchiveGameLore);
  const captured = sandbox.captureArchivePresentationScope();
  function generate(payload = {}) {
    return sandbox.receiveArchivePresentationAction({ action: 'game-turn', scope: captured.scope,
      presentationCurrent: captured.isCurrent, gameId: 'game-a', requestId: 'request-a', userText: 'Player input', channel: 'stage', eventId: '', ...payload });
  }
  return { sandbox, context, game, entries, calls, captured, generate,
    invalidateOwner() { sandbox.owner = 'owner-b'; sandbox.storageAccountEpoch++; sandbox.invalidateArchiveGame(); } };
}

test('game generation awaits actual engine, recovery and local canonical save before returning its new reply', async () => {
  const engineGate = deferred(), recoveryGate = deferred(), h = generationFixture({ engineGate, recoveryGate });
  let settled = false; const result = h.generate().then(value => { settled = true; return value; }); await flush();
  assert.equal(h.calls.generate.length, 1); assert.equal(settled, false);
  engineGate.resolve(); await flush(); assert.equal(settled, false); assert.equal(h.calls.saves, 0);
  recoveryGate.resolve(); assert.deepEqual(plain(await result), { text: 'Canonical new reply', messageId: 'reply-a',
    requestId: 'request-a', channel: 'stage', eventId: '' });
  assert.equal(h.calls.saves, 1); assert.equal(h.calls.promptWrites.at(-1).value, '');
  assert.equal(h.context.chat[0].mes, 'FUTURE-CANONICAL-HISTORY'); assert.equal(h.context.chat.length, 2);
  assert.equal(h.sandbox.generationBusy, false);
});

test('game prompt excludes canonical future/channel history and ordinary extensions while preserving authorized card and preset', async () => {
  const h = generationFixture(); await h.generate({ context: 'FORGED-DOM-CONTEXT' });
  const prompt = JSON.stringify(h.calls.prompts[0]);
  for (const text of ['FUTURE-CANONICAL-HISTORY', 'OLD-SUMMARY', 'OLD-AUTHORS-NOTE', 'FORGED-DOM-CONTEXT', 'LATE-ORDINARY-EXTENSION']) assert.ok(!prompt.includes(text));
  for (const text of ['AUTHORIZED-PRESET', 'AUTHORIZED-CHARACTER', 'AUTHORIZED-WORLDBOOK', 'GAME-OWNED-CURRENT-BRANCH', 'Player input']) assert.ok(prompt.includes(text));
  assert.equal(h.calls.builds, 1); assert.deepEqual(h.calls.drafts, []);
  assert.equal(h.calls.generate[0].options.depth, 1);
});

test('game slash input stays text and uses the native depth path rather than executing ordinary commands', async () => {
  const h = generationFixture(); h.game.turns[0].userText = '/delete 0'; await h.generate({ userText: '/delete 0' });
  assert.equal(h.calls.prompts[0].at(-1).content, '/delete 0'); assert.deepEqual(h.calls.drafts, []);
  assert.ok(script.includes("if (!(dryRun || depth || type == 'regenerate' || type == 'swipe' || type == 'quiet'))"));
  assert.ok(script.includes("await processCommands(String($('#send_textarea').val()))"));
});

test('shipping game schema and real context builder satisfy the guarded host turn contract', async () => {
  const h = generationFixture({ realContext: true }); const result = await h.generate();
  const prompt = JSON.stringify(h.calls.prompts[0]);
  assert.ok(prompt.includes('Synthetic world')); assert.ok(prompt.includes('GAME-OWNED-CURRENT-BRANCH'));
  assert.equal(result.requestId, 'request-a'); assert.equal(h.game.turns[0].status, 'pending');
});

test('ordinary chat prompt is a no-op before and after a game turn with no lazy store import on ordinary actions', async () => {
  const h = generationFixture(), data = { chat: [{ role: 'user', content: 'ordinary' }] };
  h.sandbox.isolateArchiveGamePrompt(data); assert.deepEqual(data.chat, [{ role: 'user', content: 'ordinary' }]);
  assert.equal(h.calls.imports, 0); await h.generate();
  const ordinary = { chat: [{ role: 'user', content: 'next ordinary' }] };
  h.sandbox.isolateArchiveGamePrompt(ordinary); assert.deepEqual(ordinary.chat, [{ role: 'user', content: 'next ordinary' }]);
  assert.equal(h.sandbox.activeGameTurn, null); assert.equal(h.calls.promptWrites.at(-1).value, '');
});

test('game turn rejects cloned capabilities and never imports storage for a forged scope', async () => {
  const h = generationFixture(); await assert.rejects(h.generate({ scope: { ...h.captured.scope } }), { code: 'VN_GAME_STALE', outcome: 'interrupted' });
  assert.equal(h.calls.imports, 0); assert.equal(h.calls.generate.length, 0);
});

test('game ID locator, pending request, character binding, owner, channel and player input are all validated against durable state', async () => {
  for (const mutate of [h => { h.game.owner = 'owner-b'; }, h => { h.game.characters[0].conversationId = 'other-chat'; },
    h => { h.game.characters[0].appId = 'other-app'; }, h => { h.game.active.characterId = 'other-actor'; },
    h => { h.game.turns[0].status = 'completed'; }, h => { h.game.turns[0].requestId = 'other-request'; },
    h => { h.game.turns[0].userText = 'different text'; }, h => { h.game.active.channel = 'talk'; }]) {
    const h = generationFixture(); mutate(h); await assert.rejects(h.generate(), { code: 'VN_GAME_BINDING' });
    assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.saves, 0);
  }
  const h = generationFixture(); await assert.rejects(h.generate({ gameId: 'other-game' }), { code: 'VN_GAME_REQUEST' });
  assert.equal(h.calls.imports, 0);
});

test('late game import and disk read cannot generate for a switched account even if app and conversation IDs are reused', async () => {
  for (const key of ['importGate', 'readGate']) {
    const gate = deferred(), h = generationFixture({ [key]: gate }); const generating = h.generate(); await flush();
    h.invalidateOwner(); gate.resolve(); await assert.rejects(generating, { outcome: 'interrupted' });
    assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.saves, 0);
  }
});

test('stop during disk preparation prevents the provider request and stop during streaming cannot return partial success', async () => {
  for (const key of ['readGate', 'engineGate']) {
    const gate = deferred(), h = generationFixture({ [key]: gate }); const generating = h.generate(); await flush();
    await h.sandbox.receiveArchivePresentationAction({ scope: h.captured.scope, action: 'stop' }); gate.resolve();
    await assert.rejects(generating, { outcome: 'interrupted' }); assert.equal(h.calls.stops, 1);
    assert.equal(h.calls.saves, 0); assert.equal(h.calls.promptWrites.at(-1).value, '');
    if (key === 'readGate') assert.equal(h.calls.generate.length, 0);
  }
});

test('engine error, empty reply and local quota failure remain uncertain rather than accepted replies and cleanup permits next turn', async () => {
  for (const options of [{ failEngine: true }, { noReply: true }, { failSave: true }]) {
    const h = generationFixture(options); await assert.rejects(h.generate(), { outcome: 'uncertain' });
    assert.equal(h.sandbox.activeGameTurn, null); assert.equal(h.sandbox.generationBusy, false);
    assert.equal(h.calls.promptWrites.at(-1).value, '');
  }
});

test('a second game call is rejected while the first engine promise is pending', async () => {
  const gate = deferred(), h = generationFixture({ engineGate: gate }), first = h.generate(); await flush();
  await assert.rejects(h.generate(), { code: 'VN_GAME_BUSY' }); assert.equal(h.calls.generate.length, 1);
  gate.resolve(); await first;
});

test('account invalidation during provider wait stops it, clears prompt immediately and never writes into the new scope', async () => {
  const gate = deferred(), h = generationFixture({ engineGate: gate }), result = h.generate(); await flush();
  h.invalidateOwner(); assert.equal(h.calls.stops, 1); assert.equal(h.calls.promptWrites.at(-1).value, '');
  gate.resolve(); await assert.rejects(result, { outcome: 'interrupted' }); assert.equal(h.calls.saves, 0);
});

test('only current card worldbook entries survive source filtering, including duplicate binding through global/chat sources', async () => {
  const gate = deferred(), h = generationFixture({ engineGate: gate }), result = h.generate(); await flush();
  const lore = { globalLore: [{ world: 'CardWorld', content: 'authorized global duplicate' }, { world: 'OtherWorld', content: 'other' }],
    characterLore: [{ world: 'CardWorld', content: 'authorized' }, { world: 'CardWorld', stmemorybooks: true, content: 'future summary' }],
    chatLore: [{ world: 'MemoryWorld', stmemorybooks: true, content: 'future' }], personaLore: [] };
  h.sandbox.isolateArchiveGameLore(lore);
  assert.equal(lore.globalLore.length, 1); assert.equal(lore.characterLore.length, 1); assert.equal(lore.chatLore.length, 0);
  gate.resolve(); await result;
  const ordinary = { globalLore: [{ world: 'OtherWorld' }], characterLore: [], chatLore: [], personaLore: [] };
  h.sandbox.isolateArchiveGameLore(ordinary); assert.equal(ordinary.globalLore.length, 1);
  assert.ok(worldInfo.includes('await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });'));
  assert.ok(worldInfo.includes('entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];'));
});

test('squashed prompt sources and canonical-history macros fail closed instead of leaking future plot', async () => {
  for (const change of [h => { h.sandbox.oai_settings.squash_system_messages = true; },
    h => { h.sandbox.promptManager.serviceSettings.prompts[0].content = '{{lastCharMessage}}'; }]) {
    const h = generationFixture(); change(h); await assert.rejects(h.generate());
    assert.equal(h.context.chat.length, 1); assert.equal(h.calls.saves, 0); assert.equal(h.calls.promptWrites.at(-1).value, '');
  }
});

test('shipping OpenAI prompt event really forwards the spliced array, not an ignored replacement property', async () => {
  const h = generationFixture();
  h.sandbox.activeGameTurn = { current: () => true, engineType: 'normal', context: 'GAME-CURRENT', userText: 'Player', interrupted: false };
  const original = [{ role: 'assistant', content: 'FUTURE-CANONICAL-HISTORY' }];
  h.sandbox.chatCompletion = { getChat: () => original };
  h.sandbox.event_types = { CHAT_COMPLETION_PROMPT_READY: 'prompt' }; h.sandbox.promptManager.tokenHandler = { counts: {} };
  h.sandbox.dryRun = false;
  const source = section(openai.replace(/\r\n/g, '\n'), '    const chat = chatCompletion.getChat();', '\n}\n');
  const result = await vm.runInContext(`(async () => { ${source} })()`, h.sandbox);
  assert.equal(result[0], original); assert.ok(!JSON.stringify(result[0]).includes('FUTURE-CANONICAL-HISTORY'));
  assert.ok(JSON.stringify(result[0]).includes('GAME-CURRENT'));
});

function installNativeSender(h, { parametersGate } = {}) {
  const requests = [], failures = [];
  Object.assign(h.sandbox, { AbortController,
    getChatCompletionModel: () => 'synthetic-configured-model', beginDiagnostic: () => ({ output_chars: 0 }), requireAvailableModel() {},
    async createGenerationParameters(_settings, model, type, messages) {
      if (parametersGate) await parametersGate.promise;
      return { generate_data: { model, messages, temperature: 0.8 }, stream: false };
    },
    async fetch(url, options) { requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Actual synthetic response' } }] }) }; },
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    observeDiagnostic: (diagnostic, _data, text) => { diagnostic.output_chars = text.length; },
    finishDiagnostic(_diagnostic, cause) { if (cause) failures.push(cause); },
    generationFailure: () => Object.assign(new Error('synthetic provider settings failure'), { code: 'SYNTHETIC_SETTINGS' }),
    checkQuotaError() {}, checkModerationError() {}, parseChatCompletionLogprobs() {},
    delay: async () => {}, saveLogprobsForActiveMessage() {},
  });
  vm.runInContext(section(openai, 'let homerGameGenerationGuardFactory =', 'export function getStreamingReply(')
    .replace('export function setHomerGameGenerationGuard', 'function setHomerGameGenerationGuard'), h.sandbox);
  h.sandbox.setHomerGameGenerationGuard(h.sandbox.captureArchiveGameRequestGuard);
  return { requests, failures };
}

function activateSyntheticTurn(h) {
  h.sandbox.activeGameTurn = { current: () => h.sandbox.owner === 'owner-a' && h.sandbox.storageAccountEpoch === 1,
    engineType: 'normal', context: 'GAME-CURRENT', userText: 'Player', interrupted: false };
  return h.sandbox.activeGameTurn;
}

test('shipping native OpenAI sender runs final settings guard and carries isolated game prompt into its actual POST body', async () => {
  const h = generationFixture(), { requests } = installNativeSender(h);
  activateSyntheticTurn(h);
  const prompt = { chat: [{ role: 'assistant', content: 'FUTURE-CANONICAL-HISTORY' }] };
  await h.sandbox.eventSource.emit('prompt', prompt);
  prompt.chat.push({ role: 'assistant', content: 'LATE-FUTURE-INJECTION' });
  const result = await h.sandbox.sendOpenAIRequest('normal', prompt.chat);
  assert.equal(result.choices[0].message.content, 'Actual synthetic response'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/backends/chat-completions/generate');
  assert.equal(requests[0].body.model, 'synthetic-configured-model'); assert.equal(requests[0].body.temperature, 0.8);
  assert.ok(JSON.stringify(requests[0].body).includes('GAME-CURRENT'));
  assert.ok(!JSON.stringify(requests[0].body).includes('LATE-FUTURE-INJECTION'));
});

test('real EventEmitter swallows preset, squash, context and lore errors but actual native sender rejects with zero POST', async () => {
  for (const [mutate, expectedCode] of [
    [h => { h.sandbox.oai_settings.squash_system_messages = true; }, 'VN_GAME_PROMPT'],
    [h => { h.sandbox.promptManager.serviceSettings.prompts[0].content = '{{lastCharMessage}}'; }, 'VN_GAME_PROMPT_MACRO'],
    [h => { h.sandbox.promptManager.messages.getCollection = () => { throw Object.assign(new Error('synthetic context failure'), { code: 'SYNTHETIC_CONTEXT' }); }; }, 'SYNTHETIC_CONTEXT'],
    [h => h.sandbox.eventSource.emit('lore', { globalLore: [], characterLore: [], chatLore: [], personaLore: null }), 'VN_GAME_LORE'],
  ]) {
    const h = generationFixture(), native = installNativeSender(h); activateSyntheticTurn(h); await mutate(h);
    const prompt = { chat: [{ role: 'assistant', content: 'OLD-CANONICAL-BRANCH' }] };
    await h.sandbox.eventSource.emit('prompt', prompt); // Actual emitter resolves despite listener errors.
    assert.ok(h.calls.listenerErrors.length > 0);
    await assert.rejects(h.sandbox.sendOpenAIRequest('normal', prompt.chat), { code: expectedCode });
    assert.equal(native.requests.length, 0); assert.equal(native.failures.at(-1).code, expectedCode);
  }
});

test('old history appended after SETTINGS_READY isolation is rejected before actual native POST', async () => {
  const h = generationFixture(), { requests } = installNativeSender(h); activateSyntheticTurn(h);
  const prompt = { chat: [{ role: 'assistant', content: 'OLD-CANONICAL-BRANCH' }] };
  await h.sandbox.eventSource.emit('prompt', prompt);
  h.sandbox.eventSource.on('settings', data => { data.messages.push({ role: 'assistant', content: 'LATE-OLD-HISTORY' }); });
  await assert.rejects(h.sandbox.sendOpenAIRequest('normal', prompt.chat), { code: 'VN_GAME_PROMPT_CHANGED' });
  assert.equal(requests.length, 0);
});

test('captured native request guard rejects stop, logout ABA and cleared active turn after async preparation', async () => {
  for (const change of [h => h.sandbox.interruptGameTurn(),
    h => { h.sandbox.storageAccountEpoch++; h.sandbox.owner = 'owner-a'; h.sandbox.activeGameTurn = null; },
    h => { h.sandbox.activeGameTurn = null; }]) {
    const gate = deferred(), h = generationFixture(), { requests } = installNativeSender(h, { parametersGate: gate });
    activateSyntheticTurn(h); const prompt = { chat: [] }; await h.sandbox.eventSource.emit('prompt', prompt);
    const result = h.sandbox.sendOpenAIRequest('normal', prompt.chat); await flush(); change(h); gate.resolve();
    await assert.rejects(result, { code: 'VN_GAME_STALE', outcome: 'interrupted' }); assert.equal(requests.length, 0);
  }
});

test('ordinary native requests retain their original payload with no game guard before and after failed game isolation', async () => {
  const h = generationFixture(), { requests } = installNativeSender(h);
  const messages = [{ role: 'user', content: 'ORDINARY-CHAT' }];
  assert.equal(h.sandbox.captureArchiveGameRequestGuard('normal'), null);
  await h.sandbox.sendOpenAIRequest('normal', messages);
  activateSyntheticTurn(h); h.sandbox.oai_settings.squash_system_messages = true;
  const prompt = { chat: messages.map(item => ({ ...item })) }; await h.sandbox.eventSource.emit('prompt', prompt);
  await assert.rejects(h.sandbox.sendOpenAIRequest('normal', prompt.chat), { code: 'VN_GAME_PROMPT' });
  h.sandbox.activeGameTurn = null; await h.sandbox.sendOpenAIRequest('normal', messages);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.deepEqual(request.body.messages, messages);
  assert.equal(h.calls.imports, 0);
  assert.ok(section(bridge, 'function installPresentationModeBridge(', 'function buildPresentationModeToggle(')
    .includes('setHomerGameGenerationGuard(captureArchiveGameRequestGuard);'));
});

test('known unsent game rejection remains exact even if Generate consumes the sender error and resolves', async () => {
  const h = generationFixture(), { requests } = installNativeSender(h);
  h.sandbox.promptManager.serviceSettings.prompts[0].content = '{{lastCharMessage}}';
  h.context.generate = async () => {
    const prompt = { chat: [{ role: 'assistant', content: 'OLD-CANONICAL-BRANCH' }] };
    await h.sandbox.eventSource.emit('prompt', prompt);
    try { await h.sandbox.sendOpenAIRequest('normal', prompt.chat); } catch { /* Mirrors Generate handling a failed sender. */ }
  };
  await assert.rejects(h.generate(), { code: 'VN_GAME_PROMPT_MACRO', outcome: 'failed' });
  assert.equal(requests.length, 0); assert.equal(h.calls.saves, 0);
  assert.equal(h.sandbox.activeGameTurn, null); assert.equal(h.calls.promptWrites.at(-1).value, '');
});

function routingFixture(query = '') {
  const posts = [], listeners = new Map(), noop = () => {};
  let owner = 'owner-a'; const node = { value: '', setAttribute: noop, close: noop,
    classList: { add: noop, remove: noop, toggle: noop } };
  const sandbox = vm.createContext({ URL, URLSearchParams,
    location: { origin: 'https://synthetic.invalid', href: `https://synthetic.invalid/app/chat.html?app_id=app-a&conversation_id=chat-a${query}`, search: `?app_id=app-a&conversation_id=chat-a${query}` },
    activeAppId: 'app-a', activeConversationId: 'chat-a', runtimeAccountEpoch: 1, runtimeReady: true,
    runtimeBindingOwner: () => owner, adminPreview: false, runtimeState: null, pendingDraft: '', adminBindPending: false,
    document: { querySelector: () => null, body: node }, appearance: { refresh: noop }, composerUi: null,
    composerDraftDirty: false, previewInput: node, previewRequestId: 0, readyHandoffTimer: 0,
    runtimeOverlayActive: false, frame: {}, switchShellScope: '', insetsSignature: '', pendingTool: null,
    launcherVisual: {}, launcher: node, announcer: {},
    closeDrawers: noop, showToast: noop, renderCachedConversation: noop, bindPreparedConversation: noop,
    clearReadyTimer: noop, setRuntimeOverlay: noop, syncHostInsets: noop, setDocumentTitle: noop, flushRuntimeCommands: noop,
    forwardPresentationVisibility: noop, canUseIdleHostDisplay: () => false, adoptRuntimeControls: () => false,
    postRuntimeCommand: (type, payload) => posts.push({ type, ...plain(payload) }),
    switchConversation(appId, conversationId) { sandbox.updateVisibleConversationUrl(appId, conversationId); sandbox.runtimeReady = false; },
    window: { addEventListener: (type, handler) => listeners.set(type, handler), clearTimeout: noop,
      history: { state: null, replaceState(_state, _title, value) { sandbox.location.href = String(value); sandbox.location.search = new URL(value).search; } } },
  });
  vm.runInContext(section(host, 'let requestedPresentation =', 'let insetsSignature =')
    + section(host, 'function syncArchivePresentation(', 'function syncHostInsets(')
    + section(host, 'function markReady(', 'function canUseIdleHostDisplay(')
    + section(host, 'function updateVisibleConversationUrl(', 'async function loadHistory(')
    + section(host, 'let navigationPending =', "frame.addEventListener('error'"), sandbox);
  return { sandbox, posts, setOwner: value => { owner = value; }, navigate(query) {
    listeners.get('homer:navigate-conversation')({ detail: { url: `https://synthetic.invalid/app/chat.html?${query}` }, preventDefault: noop });
  } };
}

test('URL game locator crosses retained-ready request only with exact owner, account epoch and canonical IDs', () => {
  const h = routingFixture('&presentation=archive_vn&vn_game=game-a'); h.sandbox.markReady();
  assert.equal(h.posts.find(item => item.type === 'presentation-mode').gameId, 'game-a');
  for (const change of [h => h.setOwner('owner-b'), h => { h.sandbox.runtimeAccountEpoch++; }, h => { h.sandbox.activeConversationId = 'chat-b'; }]) {
    const stale = routingFixture('&presentation=archive_vn&vn_game=game-a'); change(stale); stale.sandbox.markReady();
    assert.equal(stale.posts.filter(item => item.type === 'presentation-mode').length, 0);
  }
});

test('different ordinary target clears old game URL and same-target ordinary entry exits game without switching engine', () => {
  const h = routingFixture('&presentation=archive_vn&vn_game=game-a'); h.sandbox.markReady();
  h.navigate('app_id=app-a&conversation_id=chat-a');
  assert.equal(h.posts.at(-1).mode, 'tavern'); assert.ok(!h.sandbox.location.href.includes('vn_game'));
  const other = routingFixture('&presentation=archive_vn&vn_game=game-a'); other.sandbox.markReady();
  other.navigate('app_id=app-b&conversation_id=chat-b'); assert.ok(!other.sandbox.location.href.includes('vn_game'));
});

test('malformed locator is not forwarded while same-target valid game navigation updates its visible URL', () => {
  const h = routingFixture(); h.navigate('app_id=app-a&conversation_id=chat-a&presentation=archive_vn&vn_game=game-b');
  assert.equal(h.posts.at(-1).gameId, 'game-b'); assert.equal(new URL(h.sandbox.location.href).searchParams.get('vn_game'), 'game-b');
  const bad = routingFixture('&presentation=archive_vn&vn_game=game%2Fbad'); bad.sandbox.markReady();
  assert.equal(bad.posts.find(item => item.type === 'presentation-mode').gameId, '');
});

test('outer sender attaches only the current public document epoch to game requests and refuses an unavailable stamp', () => {
  const h = routingFixture(), messages = [];
  h.sandbox.HOST_CHANNEL = 'synthetic-host';
  h.sandbox.frame = { contentWindow: { postMessage: data => messages.push(plain(data)) },
    contentDocument: { documentElement: { dataset: { homerPresentationEpoch: '7' } } } };
  vm.runInContext(section(host, 'function postRuntimeCommand(', 'function flushRuntimeCommands('), h.sandbox);
  assert.equal(h.sandbox.postRuntimeCommand('presentation-mode', { gameId: 'game-a', mode: 'archive_vn' }), true);
  assert.equal(messages[0].presentation_epoch, 7); assert.equal(messages[0].owner, undefined);
  h.sandbox.frame.contentDocument.documentElement.dataset.homerPresentationEpoch = 'NaN';
  assert.equal(h.sandbox.postRuntimeCommand('presentation-mode', { gameId: 'game-a' }), false); assert.equal(messages.length, 1);
  assert.equal(h.sandbox.postRuntimeCommand('presentation-mode', { mode: 'tavern' }), true); assert.equal(messages[1].presentation_epoch, undefined);
});

test('bridge rejects delayed previous-account epoch game entry even when the owner and target IDs are reused', async () => {
  const h = generationFixture(), events = [], parent = {};
  Object.assign(h.sandbox, { canNotifyHost: () => true, HOST_CHANNEL: 'synthetic-host',
    window: { parent, location: { origin: 'https://synthetic.invalid' } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  }); h.sandbox.document.dispatchEvent = event => events.push(event);
  vm.runInContext(section(bridge, 'async function receiveHostCommand(', "window.addEventListener('message',"), h.sandbox);
  const request = payload => h.sandbox.receiveHostCommand({ origin: h.sandbox.window.location.origin, source: parent,
    data: { channel: 'synthetic-host', version: 1, type: 'presentation-mode', mode: 'archive_vn', gameId: 'game-a',
      app_id: 'app-a', conversation_id: 'chat-a', presentation_epoch: 1, ...payload } });
  for (const payload of [{ presentation_epoch: 0 }, { presentation_epoch: '1' }, { presentation_epoch: undefined },
    { app_id: 'other' }, { conversation_id: 'other' }, { gameId: 'bad/id' }]) await request(payload);
  assert.equal(events.length, 0); await request({}); assert.equal(events.length, 1);
  h.sandbox.storageAccountEpoch++; await request({}); assert.equal(events.length, 1);
  assert.equal(events[0].detail.isCurrent(), false); assert.equal(h.calls.imports, 0);
});

test('host game modules remain lazy and mount passes a restricted result-bearing gameHost instead of context or credentials', () => {
  assert.ok(!/^import .*visual-novel-game/m.test(host)); assert.ok(!/^import .*visual-novel-game/m.test(stage));
  assert.ok(!/^import .*visual-novel-game/m.test(bridge));
  const mount = section(stage, '    const reader = await runtime.mountVisualNovel({', '    if (!isCurrent()) {');
  assert.ok(mount.includes('gameHost: gameId ?')); assert.ok(mount.includes("'game-turn'"));
  for (const property of ['requestId: payload?.requestId', 'channel: payload?.channel', 'eventId: payload?.eventId']) assert.ok(mount.includes(property));
  assert.ok(!mount.includes('bridge_token')); assert.ok(!mount.includes('context: payload'));
});

function stageFixture({ importGate } = {}) {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.dataset = {};
      this.style = { setProperty() {}, removeProperty() {} }; const classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) }; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    querySelectorAll() { return []; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); }
  }
  const document = new Node('document'), body = new Node('body');
  document.body = body; document.documentElement = new Node('html'); document.createElement = tag => new Node(tag);
  document.querySelector = () => null; document.getElementById = id => body.children.find(node => node.id === id) || null;
  let owner = 'owner-a', epoch = 1; const storage = new Map(), calls = { imports: 0, mounts: [], destroyed: 0, requests: [] };
  const context = { characterId: 0, chat: [], characters: [{ name: 'Synthetic role', data: { extensions: {} } }],
    chatMetadata: { homer_bridge: { user_id: owner, app_id: 'app-a', conversation_id: 'chat-a' } } };
  const sandbox = vm.createContext({ document, URLSearchParams, console,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    getContext: () => context, eventSource: { on() {} }, event_types: {},
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: { location: { search: '', origin: 'https://synthetic.invalid' }, setTimeout: () => 0, clearTimeout() {} },
    async loadArchiveRuntime() { calls.imports++; if (importGate) await importGate.promise;
      return { async mountVisualNovel(value) { calls.mounts.push(value); return { setHostVisible() {}, setBusy() {},
        destroy() { calls.destroyed++; } }; } }; },
  }); sandbox.window.parent = sandbox.window;
  vm.runInContext(stage.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    .replace(/import\('\/app\/assets\/js\/visual-novel-runtime\.mjs\?[^']+'\)/, 'loadArchiveRuntime()'), sandbox);
  sandbox.installCardStageRuntime({ captureScope() { const capturedOwner = owner, capturedEpoch = epoch;
    return { scope: Object.freeze({ owner, appId: 'app-a', conversationId: 'chat-a' }),
      isCurrent: () => owner === capturedOwner && epoch === capturedEpoch }; }, isBusy: () => false });
  document.addEventListener('homer-archive-action', event => { calls.requests.push(event.detail);
    event.detail.resolve({ text: 'Real response', messageId: 'reply-a', requestId: event.detail.requestId }); });
  return { sandbox, calls, storage, api: sandbox.window.__homerCardStageRuntime,
    invalidate() { owner = 'owner-b'; epoch++; context.chatMetadata.homer_bridge.user_id = owner;
      document.dispatchEvent(new sandbox.CustomEvent('homer-presentation-invalidated')); } };
}

test('actual lazy stage mount forwards only opaque locator and scoped generate payload, awaits its result, and retires an old game', async () => {
  const h = stageFixture(); await h.api.refresh(); assert.equal(h.calls.imports, 0);
  assert.equal(await h.api.setPresentationMode('archive_vn', { gameId: 'game-a' }), true);
  const first = h.calls.mounts[0]; assert.equal(first.gameId, 'game-a');
  const result = await first.gameHost.generate({ requestId: 'request-a', userText: 'Player', channel: 'stage', eventId: '', context: 'UNTRUSTED' });
  assert.equal(result.messageId, 'reply-a'); assert.equal(h.calls.requests[0].action, 'game-turn');
  assert.equal(h.calls.requests[0].scope.owner, 'owner-a'); assert.equal(h.calls.requests[0].context, undefined);
  assert.ok([...h.storage.values()].every(value => value === 'tavern'));
  await h.api.setPresentationMode('archive_vn', { gameId: 'game-b' }); assert.equal(h.calls.mounts.length, 2);
  await assert.rejects(first.gameHost.generate({ requestId: 'late' }), { outcome: 'interrupted' });
  h.invalidate(); await h.api.refresh(); assert.equal(h.api.presentationMode(), 'tavern');
  assert.equal(h.calls.mounts.length, 2);
});

test('late game reader import cannot mount a switched owner or preserve a game archive default', async () => {
  const gate = deferred(), h = stageFixture({ importGate: gate });
  const opening = h.api.setPresentationMode('archive_vn', { gameId: 'game-a' }); await flush();
  h.invalidate(); gate.resolve(); assert.equal(await opening, false); assert.equal(h.calls.mounts.length, 0);
  assert.ok([...h.storage.values()].every(value => value === 'tavern'));
});
