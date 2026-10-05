import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('function reaffirmSelectedCardCapabilities()');
const end = source.indexOf('\nasync function importLaunchCardJson(', start);
assert.ok(start >= 0 && end > start);
const implementation = source.slice(start, end);

function run(selectedApp, launchApp) {
    const character = { avatar: 'fixture.png', data: { extensions: { homer_bridge: { app_id: selectedApp } } } };
    const enabled = [];
    const scope = { launch: { app_id: launchApp }, getContext: () => ({ characterId: '0', characters: [character] }),
        enableEmbeddedCardCapabilities: item => enabled.push(item) };
    vm.createContext(scope);
    vm.runInContext(implementation + '\nreaffirmSelectedCardCapabilities();', scope);
    return { enabled, character };
}

test('post-APP_READY overlay restores the selected authorized card, before settings/chat hooks', () => {
    const replay = source.slice(source.indexOf('postApplicationReadyWork = (async () => {'));
    assert.match(replay, /replaceExtensionSettings\(conversationExtensionSettings\);\s*reaffirmSelectedCardCapabilities\(\);\s*await eventSource.emit\(event_types.SETTINGS_LOADED\)/);
    const { enabled, character } = run('owned-card', 'owned-card');
    assert.deepEqual(enabled, [character]);
});

test('prewarm and a stale or mismatched card cannot acquire selected-card permissions', () => {
    for (const [selected, launch] of [['previous', 'next'], ['owned', ''], [undefined, 'owned'], [undefined, undefined]]) {
        assert.deepEqual(run(selected, launch).enabled, []);
    }
});

test('bootstrap and sidebar switch refresh existing controls after clearing the busy flag', () => {
    for (const [start, end] of [['async function bootstrapLaunch(', '\nasync function startHomerBridge()'],
        ['async function switchConversation(', '\nasync function copyDiagnostic(']]) {
        const offset=source.indexOf(start), stop=source.indexOf(end,offset);
        assert.ok(offset>=0 && stop>offset);
        const operation=source.slice(offset,stop);
        const settled=operation.slice(operation.lastIndexOf('} finally {'));
        assert.match(settled, /loadingLaunch = false;[\s\S]*queueMessageMenuRender\(\);/);
    }
});
