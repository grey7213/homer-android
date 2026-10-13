import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the actual harness catch/finally without launching another browser,
// closing the root agent's fixture, or mistaking synthetic checks for UI QA.
const source = (await readFile(new URL('./chatarchive_browser_checks.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const marker = '\n} catch (failure) {\n  runError = failure;';
const index = source.indexOf(marker);
assert.ok(index > 0, 'browser evidence finalizer remains available for regression');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const finalize = new AsyncFunction('evidence', 'failures', 'transport', 'deliberateCancellations', 'browser', 'thrown',
  'phase', 'root', 'startedAt', 'writeFile', 'fetch', 'process',
  `const base = 'http://127.0.0.1:8789'; let runError; try { if (thrown) throw thrown; ${source.slice(index)}`);

async function run({ cases = 12, failures = [], thrown, cleanupError, browserPresent = true, deliberateCancellations = [] } = {}) {
  const evidence = Array.from({ length: cases }, (_, i) => ({ case: `synthetic-${i}`, pass: true }));
  const output = { previous: { cases: 8, pass: true }, writes: 0, stdout: '', shutdowns: 0, closes: 0, exitCode: 0 };
  const browser = browserPresent ? { async close() { output.closes++; if (cleanupError) throw cleanupError; } } : undefined;
  const root = new URL('file:///C:/synthetic-evidence/');
  const process = { stdout: { write(value) { output.stdout += value; } }, get exitCode() { return output.exitCode; }, set exitCode(value) { output.exitCode = value; } };
  const writeFile = async (url, json) => { assert.equal(url.href, new URL('results.json', root).href); output.writes++; output.previous = JSON.parse(json); };
  const fetch = async url => { assert.equal(url, 'http://127.0.0.1:8789/__fixture_stop'); output.shutdowns++; };
  await finalize(evidence, [...failures], [{ url: 'http://127.0.0.1:8789/synthetic/image.png', phase: 'choice' }], deliberateCancellations,
    browser, thrown, 'choice', root, '2026-10-08T00:00:00.000Z', writeFile, fetch, process);
  assert.equal(output.writes, 1);
  assert.equal(output.shutdowns, 1);
  assert.equal(output.previous.cases, cases);
  assert.equal(output.previous.evidence.length, cases);
  assert.equal(output.previous.startedAt, '2026-10-08T00:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(output.previous.completedAt)));
  assert.equal(output.previous.mediaRequests.length, 1);
  assert.deepEqual(JSON.parse(output.stdout).pass, output.previous.pass);
  return output;
}

test('latest successful run replaces stale eight-case evidence and includes cancellation details', async () => {
  const details = [{ kind: 'network', text: 'net::ERR_ABORTED', fixture: true }];
  const out = await run({ deliberateCancellations: details });
  assert.equal(out.previous.pass, true);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.previous.failures, []);
  assert.deepEqual(out.previous.deliberateCancellations, details);
});

test('all functional cases plus live network failure still persist current evidence and exit one', async () => {
  const detail = { kind: 'network', phase: 'choice', text: 'net::ERR_ABORTED', url: 'http://127.0.0.1:8789/synthetic/image.png' };
  const out = await run({ failures: [detail] });
  assert.equal(out.previous.pass, false);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.previous.failures, [detail]);
  assert.deepEqual(out.previous.deliberateCancellations, []);
});

test('assertion failure writes partial evidence with the original failure and exits one', async () => {
  const out = await run({ cases: 3, thrown: new assert.AssertionError({ message: 'synthetic assertion failed' }) });
  assert.equal(out.previous.pass, false);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.previous.failures, [{ kind: 'harness', phase: 'choice', name: 'AssertionError', text: 'synthetic assertion failed' }]);
});

test('launch failure before a browser exists replaces stale evidence', async () => {
  const out = await run({ cases: 0, browserPresent: false, thrown: new Error('synthetic launch unavailable') });
  assert.equal(out.previous.pass, false);
  assert.equal(out.exitCode, 1);
  assert.equal(out.closes, 0);
  assert.equal(out.previous.failures[0].text, 'synthetic launch unavailable');
});

test('browser cleanup failure is retained, writes evidence, and exits one', async () => {
  const out = await run({ cleanupError: new Error('synthetic cleanup failure') });
  assert.equal(out.previous.pass, false);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.previous.failures, [{ kind: 'cleanup', phase: 'choice', name: 'Error', text: 'synthetic cleanup failure' }]);
});
