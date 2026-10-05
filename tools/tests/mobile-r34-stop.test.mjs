import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
function entry(update) {
  const context = {userStopGenerationSerial:0};
  context.SimpleMutex = class {update() {return update(context);}};
  context.sendTextareaMessage = () => {};
  context.$ = () => ({on(_event, handler) {context.handler = handler;}});
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('    const userInputGenerateMutex ='), source.indexOf('    //menu buttons setup')), context);
  return context.handler;
}
test('explicit Stop consumes only its expected input-entry AbortError', async () => {
  const handler = entry(context => {
    context.userStopGenerationSerial++;
    return Promise.reject(Object.assign(new Error('Stopped'), {name:'AbortError'}));
  });
  await handler();
});
test('an AbortError without an explicit Stop is not hidden', async () => {
  const error = Object.assign(new Error('Unexpected abort'), {name:'AbortError'});
  await assert.rejects(entry(() => Promise.reject(error)), value => value === error);
});
test('provider or network failures are not hidden after Stop', async () => {
  const error = Object.assign(new Error('Provider failure'), {code:'HM-G502'});
  await assert.rejects(entry(context => {context.userStopGenerationSerial++; return Promise.reject(error);}), value => value === error);
});
test('normal generation still invokes the existing mutex once', async () => {
  let calls = 0;
  await entry(() => {calls++; return Promise.resolve();})();
  assert.equal(calls, 1);
});
