import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../frontend/', import.meta.url);
const source = await readFile(new URL('assets/js/theme-bootstrap.js', root), 'utf8');

function run(saved, dark = false, { storageError = false, nativeError = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    window: { HomerNative: { setAppTheme: theme => {
      calls.push(theme);
      if (nativeError) throw Error('bridge unavailable');
    } } },
    document: { documentElement: { dataset: {} } },
    localStorage: { getItem() {
      if (storageError) throw Error('storage unavailable');
      return saved;
    } },
    matchMedia: () => ({ matches: dark }),
  });
  vm.runInContext(source, context);
  return { context, calls, theme: context.document.documentElement.dataset.theme };
}

test('saved appearance takes precedence over the operating system before first paint', () => {
  assert.equal(run('dark', false).theme, 'dark');
  assert.equal(run('', true).theme, 'light');
  assert.equal(run('light', true).theme, 'light');
});

test('unset appearance follows system mode and does not flip later to forced light', () => {
  assert.equal(run(null, true).theme, 'dark');
  assert.equal(run(null, false).theme, 'light');
});

test('unavailable storage or native bridge never prevents document appearance', () => {
  assert.equal(run(null, true, { storageError: true }).theme, 'dark');
  assert.equal(run('dark', false, { nativeError: true }).theme, 'dark');
});

test('repeated bootstrap preserves the shared function and reapplies current preferences', () => {
  const { context, calls } = run('dark');
  const apply = context.window.HomerApplyTheme;
  vm.runInContext(source, context);
  assert.equal(context.window.HomerApplyTheme, apply);
  assert.deepEqual(calls, ['dark', 'dark']);
});

test('My, Explore and Community load shared appearance and final surface styles in the head', async () => {
  for (const page of ['me', 'explore', 'community']) {
    const html = await readFile(new URL(`app/${page}.html`, root), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<script src="\/assets\/js\/theme-bootstrap\.js[^\"]*"><\/script>/);
    assert.equal((head.match(/data-homer-surface-controls/g) || []).length, 1);
    assert(head.indexOf('theme-bootstrap.js') < head.indexOf('rel="stylesheet"'), page);
  }
});

test('late option-picker initialization reuses the first-paint appearance and surface stylesheet', async () => {
  const picker = await readFile(new URL('assets/js/option-picker.js', root), 'utf8');
  const layout = await readFile(new URL('app/assets/js/layout.js', root), 'utf8');
  assert.match(picker, /const applyTheme=window\.HomerApplyTheme\|\|/);
  assert.match(picker, /if\(!document\.querySelector\('link\[data-homer-surface-controls\]'\)\)/);
  assert.match(layout, /if \(window\.HomerApplyTheme\) window\.HomerApplyTheme\(\)/);
});
