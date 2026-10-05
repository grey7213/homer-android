import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const mods = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/RossAscends-mods.js', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../../sillytavern-runtime/public/script.js', import.meta.url), 'utf8');
function harness(autoLoad = true, autoConnect = false) {
    const calls = [], context = { calls, power_user: { auto_load_chat: autoLoad, auto_connect: autoConnect },
        checkStatusDebounced: () => calls.push('status'), RA_autoloadchat: () => calls.push('standalone-chat'), RA_autoconnect: () => calls.push('auto-connect') };
    vm.createContext(context);
    const start = mods.indexOf('export function initRossMods(');
    const end = mods.indexOf("    $('#main_api').on(", start);
    vm.runInContext(mods.slice(start, end).replace(/^export /, '') + '\n}', context);
    return context;
}

test('embedded initialization leaves the cloud host as sole initial chat owner', () => {
    const h = harness(); h.initRossMods({ autoLoadChat: false });
    assert.deepEqual(h.calls, ['status']);
    assert.equal(h.power_user.auto_load_chat, true, 'do not change persisted user settings');
    assert.match(script, /initRossMods\(\{ autoLoadChat: !isHomerEmbedded \}\)/);
});
test('normal standalone callers retain last-chat restoration and existing auto-connect', () => {
    const h = harness(true, true); h.initRossMods();
    assert.deepEqual(h.calls, ['status', 'standalone-chat', 'auto-connect']);
});
test('embedded mode does not silently remove unrelated status or connection handlers', () => {
    const h = harness(true, true); h.initRossMods({ autoLoadChat: false });
    assert.deepEqual(h.calls, ['status', 'auto-connect']);
    const off = harness(false); off.initRossMods(); assert.deepEqual(off.calls, ['status']);
});
