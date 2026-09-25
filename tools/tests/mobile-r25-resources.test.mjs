import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeResource, readResourceFile } from '../../frontend/app/assets/js/workshop-import.mjs';

test('native presets retain prompt order, flags and custom fields', () => {
  const source = { prompts: [{ identifier: 'main', content: 'hello', enabled: false }], prompt_order: [{ order: [] }], temperature: 0.8 };
  const result = normalizeResource('preset', source);
  assert.deepEqual(result.prompts, source.prompts);
  assert.equal(result.entries, undefined, 'do not double the imported payload');
  assert.deepEqual(result.prompt_order, source.prompt_order);
  assert.equal(result.temperature, 0.8);
});
test('world book entries retain original identifiers and extensions', () => {
  const source = { entries: { 8: { uid: 8, key: ['world'], content: 'setting', selectiveLogic: 2 } } };
  const result = normalizeResource('mod', source);
  assert.equal(result.entries[0].uid, 8);
  assert.equal(result.entries[0].selectiveLogic, 2);
});
test('standalone and nested character regex formats supported', () => {
  const rule = { scriptName: 'test', findRegex: '/cat/g', replaceString: 'dog', disabled: true, placement: [1, 2] };
  assert.deepEqual(normalizeResource('regex', rule).regex_scripts[0], rule);
  assert.deepEqual(normalizeResource('regex', { data: { extensions: { regex_scripts: [rule] } } }).regex_scripts[0], rule);
  assert.equal(normalizeResource('regex', { data: { description: 'private', extensions: { regex_scripts: [rule] } } }).data, undefined);
  assert.throws(() => normalizeResource('regex', [null]), /第 1/);
});
test('file validation handles BOM, invalid JSON and oversized uploads', async () => {
  assert.equal((await readResourceFile('regex', new File(['\uFEFF{"findRegex":"a"}'], 'sample.json'))).regex_scripts.length, 1);
  await assert.rejects(readResourceFile('mod', new File(['no'], 'bad.json')), /JSON/);
  await assert.rejects(readResourceFile('mod', { size: 9 * 1024 * 1024 }), /8 MB/);
});
test('regex preview uses native flags, disabled rules, groups and match macro', () => {
  let result;
  const scope = { self: { postMessage: value => { result = value; } } };
  vm.runInNewContext(fs.readFileSync(new URL('../../frontend/app/assets/js/regex-preview-worker.mjs', import.meta.url), 'utf8'), scope);
  scope.self.onmessage({ data: { sample: 'cat cat', rules: [{ findRegex: '/(cat)/g', replaceString: '[$1:{{match}}]' }, { findRegex: 'cat', replaceString: 'bad', disabled: true }] } });
  assert.equal(result.output, '[cat:cat] [cat:cat]');
  scope.self.onmessage({ data: { sample: 'test', rules: [{ findRegex: '[' }] } });
  assert.ok(result.error);
});
