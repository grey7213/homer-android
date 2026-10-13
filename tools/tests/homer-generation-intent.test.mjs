import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { attachHomerGenerationIntent } from '../../sillytavern-runtime/public/scripts/homer-generation-intent.mjs';

const headers = 'X-Homer-Module: dialogue-module';
test('continuation preserves the request-local administrator draft and other body fields', () => {
  const preview = { prompt: { name: 'Synthetic preset' } };
  const data = { custom_include_headers: headers, custom_include_body: JSON.stringify({ homer_preview: preview, option: 1 }) };
  assert.equal(attachHomerGenerationIntent(data, 'continue'), true);
  assert.deepEqual(JSON.parse(data.custom_include_body), { homer_preview: preview, option: 1, homer_generation_type: 'continue' });
});
test('ordinary provider bodies are unchanged; an old continue flag cannot bleed into a normal Homer turn', () => {
  const external = { custom_include_body: '{"custom":1}' };
  assert.equal(attachHomerGenerationIntent(external, 'continue'), false);
  assert.deepEqual(external, { custom_include_body: '{"custom":1}' });
  const data = { custom_include_headers: headers, custom_include_body: '{"homer_generation_type":"continue"}' };
  attachHomerGenerationIntent(data, 'normal');
  assert.equal(JSON.parse(data.custom_include_body).homer_generation_type, 'normal');
});
test('malformed include bodies and unsupported types fail before a provider request', () => {
  for (const value of ['null', '[]', '1', '{'])
    assert.throws(() => attachHomerGenerationIntent({ custom_include_headers: headers, custom_include_body: value }, 'continue'), /HM-GINTENT/);
  assert.throws(() => attachHomerGenerationIntent({ custom_include_headers: headers }, 'unsupported'), /HM-GINTENT/);
});

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/openai.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function sendOpenAIRequest(');
const sender = source.slice(begin, source.indexOf('export function getStreamingReply(', begin));
test('shipping sender adds the actual call type after settings listeners into the actual POST', async () => {
  const posts = [], permanent = { custom_include_body: '' };
  const scope = { AbortController, attachHomerGenerationIntent, yaml: { parse: JSON.parse },
    homerGameGenerationGuardFactory: null, homerPresetGenerationGuardFactory: null, oai_settings: permanent,
    getChatCompletionModel: () => 'synthetic-model', beginDiagnostic: () => ({}), requireAvailableModel() {},
    createGenerationParameters: async (_settings, model, _type, messages) => ({ generate_data: { model, messages, custom_include_headers: headers }, stream: false }),
    event_types: { CHAT_COMPLETION_SETTINGS_READY: 'settings' },
    eventSource: { emit: async (_event, data) => { data.custom_include_body = '{"homer_preview":{"revision":9}}'; } },
    fetch: async (_url, options) => { posts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Synthetic continuation' } }] }) }; },
    getRequestHeaders: () => ({}), observeDiagnostic(diagnostic, _data, text) { diagnostic.output_chars = text.length; }, finishDiagnostic() {}, checkQuotaError() {}, checkModerationError() {},
    parseChatCompletionLogprobs() {}, saveLogprobsForActiveMessage() {}, delay: async () => {}, generationFailure: () => new Error('Request failed'),
  };
  vm.createContext(scope); vm.runInContext(sender, scope);
  await scope.sendOpenAIRequest('continue', [{ role: 'assistant', content: 'Synthetic last paragraph' }]);
  await scope.sendOpenAIRequest('normal', [{ role: 'user', content: 'Synthetic next turn' }]);
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[0].custom_include_body), { homer_preview: { revision: 9 }, homer_generation_type: 'continue' });
  assert.equal(JSON.parse(posts[1].custom_include_body).homer_generation_type, 'normal');
  assert.equal(permanent.custom_include_body, '');
});
