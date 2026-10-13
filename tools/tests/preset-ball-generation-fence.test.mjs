import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/openai.js', import.meta.url), 'utf8');
const from = source.indexOf('async function sendOpenAIRequest(');
const to = source.indexOf('    if (!response.ok)', from);
assert.ok(from > 0 && to > from);
const product = source.slice(from, to) + '\nreturn response;\n}';
test('actual sender rejects pending preset outside swallowing EventEmitter before POST/billing', async () => {
    const errors = []; let posts = 0;
    const h = { AbortController, oai_settings: {}, homerGameGenerationGuardFactory: null,
        homerPresetGenerationGuardFactory: () => () => { throw Object.assign(new Error('[HM-P001] pending'), {code:'HM-P001'}); },
        getChatCompletionModel: () => 'fixture-model', beginDiagnostic: () => ({}), requireAvailableModel() {},
        createGenerationParameters: async () => ({generate_data:{}, stream:false}),
        eventSource: { async emit() { try { throw new Error('listener'); } catch {} } }, event_types: {CHAT_COMPLETION_SETTINGS_READY:'ready'},
        attachHomerGenerationIntent() {}, finishDiagnostic: (_, error) => errors.push(error.code),
        generationFailure: () => new Error('should not replace code'), getRequestHeaders: () => ({}),
        fetch: async () => { posts++; return {ok:true}; }, toastr:{error(){}} };
    vm.createContext(h); vm.runInContext(product + ';globalThis.send = sendOpenAIRequest;', h);
    await assert.rejects(h.send('normal', []), /HM-P001/); assert.equal(posts, 0); assert.deepEqual(errors, ['HM-P001']);
    h.homerPresetGenerationGuardFactory = () => () => {};
    assert.equal((await h.send('normal', [])).ok, true); assert.equal(posts, 1);
});
