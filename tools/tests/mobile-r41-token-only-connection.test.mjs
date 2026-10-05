import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js', import.meta.url), 'utf8');
function section(start, end) {
    const offset = source.indexOf(start);
    assert.ok(offset >= 0, `Missing source section: ${start}`);
    const finish = source.indexOf(end, offset + start.length);
    assert.ok(finish > offset, `Missing source boundary: ${end}`);
    return source.slice(offset, finish);
}
const connectionSource = [
    section('function enforceStreamingConfiguration()', 'function applyConnectionConfiguration()'),
    section('function applyConnectionConfiguration()', 'function reaffirmConversationConnection()'),
    section('function reaffirmConversationConnection()', 'async function refreshBridgeToken()'),
].join('\n');

const headersFor = token => `Authorization: Bearer ${token}\nX-Homer-Module: dialogue-module`;

function harness({ settings = {}, mainApi = 'openai', streamChecked = true } = {}) {
    class Input { constructor() { this.checked = streamChecked; } }
    class Textarea { constructor() { this.disabled = true; this.placeholder = 'synthetic stale hint'; } }
    const composer = new Textarea(), stream = new Input();
    const values = new Map(), controls = new Map(), writes = [], triggers = [], scopes = [], statuses = [], apiChanges = [];
    let saves = 0;
    const model = { model_id: 'fixture-model', temperature: 0.8, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.2 };
    const c = {
        session: { user: { id: 'synthetic-owner' }, runtime: { dialogue_api_base_url: 'https://synthetic.invalid/dialogue/v1/' } },
        launch: { app_id: 'synthetic-app', conversation_id: 'synthetic-chat', bridge_token: 'synthetic-new-token' },
        oai_settings: {
            chat_completion_source: 'custom', custom_url: 'https://synthetic.invalid/dialogue/v1', custom_model: model.model_id,
            custom_include_headers: headersFor('synthetic-old-token'), temp_openai: model.temperature, top_p_openai: model.top_p,
            freq_pen_openai: model.frequency_penalty, pres_pen_openai: model.presence_penalty,
            bypass_status_check: true, stream_openai: true, unrelated_field: 'preserve-synthetic-value', ...settings,
        },
        HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
        document: { documentElement: { dataset: {} }, querySelector: selector => selector === '#send_textarea' ? composer : selector === '#stream_toggle' ? stream : null },
        getContext: () => ({ mainApi }),
        conversationModelSettings: () => ({ ...model }),
        activateModelScope: (scope, id) => scopes.push({ scope: JSON.parse(scope), id }),
        changeMainAPI: api => { mainApi = api; apiChanges.push(api); },
        setOnlineStatus: id => statuses.push(id),
        saveSettingsDebounced: () => { saves++; },
        $: selector => {
            if (!controls.has(selector)) {
                const control = {
                    val(value) {
                        assert.equal(this, control, 'jQuery val retains its receiver');
                        if (arguments.length) { values.set(selector, value); writes.push({ selector, value }); return control; }
                        return values.get(selector);
                    },
                    trigger(event) { assert.equal(this, control); triggers.push({ selector, event }); return control; },
                };
                controls.set(selector, control);
            }
            return controls.get(selector);
        },
    };
    vm.createContext(c);
    vm.runInContext(connectionSource, c);
    return { c, composer, stream, values, writes, triggers, scopes, statuses, apiChanges, model,
        saves: () => saves, run: () => c.applyConnectionConfiguration() };
}

test('fresh token-only connection updates live headers and composer without a native global save or unrelated control writes', () => {
    const h = harness({ streamChecked: false });
    const previous = JSON.stringify(h.c.oai_settings);
    h.run();
    assert.equal(h.saves(), 0);
    assert.deepEqual(h.writes, [{ selector: '#custom_include_headers', value: headersFor('synthetic-new-token') }]);
    assert.equal(h.c.oai_settings.custom_include_headers, headersFor('synthetic-new-token'));
    assert.equal(h.values.get('#custom_include_headers'), headersFor('synthetic-new-token'));
    assert.equal(h.composer.disabled, false);
    assert.equal(h.composer.placeholder, '输入想发送的消息');
    assert.equal(h.stream.checked, true);
    assert.equal(h.c.document.documentElement.dataset.homerStreaming, 'true');
    assert.deepEqual(h.statuses, ['fixture-model']);
    assert.deepEqual(h.triggers, []); assert.deepEqual(h.apiChanges, []);
    const expected = JSON.parse(previous); expected.custom_include_headers = headersFor('synthetic-new-token');
    assert.equal(JSON.stringify(h.c.oai_settings), JSON.stringify(expected));
    assert.deepEqual(h.scopes, [{ scope: ['synthetic-owner', false, 'synthetic-app', 'synthetic-chat'], id: 'fixture-model' }]);
});

test('token rotation always installs the newest current scope headers; identical repeat retains the original early-return contract', () => {
    const h = harness();
    h.run();
    h.c.launch.bridge_token = 'synthetic-second-token';
    h.c.launch.conversation_id = 'synthetic-second-chat';
    h.run(); h.run();
    assert.equal(h.saves(), 0);
    assert.equal(h.c.oai_settings.custom_include_headers, headersFor('synthetic-second-token'));
    assert.equal(h.values.get('#custom_include_headers'), headersFor('synthetic-second-token'));
    assert.equal(h.writes.length, 2);
    assert.equal(h.scopes[1].scope[3], 'synthetic-second-chat');
    assert.equal(h.scopes[2].scope[3], 'synthetic-second-chat');
    assert.equal(h.statuses.length, 3); assert.equal(h.composer.disabled, false);
});

for (const [label, field, value] of [
    ['source', 'chat_completion_source', 'openai'],
    ['URL', 'custom_url', 'https://synthetic.invalid/other-v1'],
    ['model', 'custom_model', 'other-fixture-model'],
    ['temperature', 'temp_openai', 1.1],
    ['top-P', 'top_p_openai', 0.6],
    ['frequency penalty', 'freq_pen_openai', 0.7],
    ['presence penalty', 'pres_pen_openai', 0.8],
    ['status bypass false', 'bypass_status_check', false],
    ['status bypass unset', 'bypass_status_check', undefined],
    ['status bypass nonboolean', 'bypass_status_check', 'true'],
    ['stream false', 'stream_openai', false],
    ['stream unset', 'stream_openai', undefined],
    ['stream nonboolean', 'stream_openai', 'true'],
]) {
    test(`${label} difference keeps the original complete configuration update and save`, () => {
        const h = harness({ settings: { [field]: value } });
        h.run();
        assert.equal(h.saves(), 1);
        assert.equal(h.c.oai_settings.custom_include_headers, headersFor('synthetic-new-token'));
        assert.equal(h.values.get('#custom_include_headers'), headersFor('synthetic-new-token'));
        assert.ok(h.writes.some(write => write.selector === '#custom_api_url_text'));
        assert.ok(h.writes.some(write => write.selector === '#temp_openai'));
        assert.equal(h.c.oai_settings.bypass_status_check, true); assert.equal(h.c.oai_settings.stream_openai, true);
        assert.equal(h.composer.disabled, false);
        assert.deepEqual(h.triggers, field === 'chat_completion_source' ? [{ selector: '#chat_completion_source', event: 'change' }] : []);
    });
}

test('switching from another API keeps the original main API transition and full save', () => {
    const h = harness({ mainApi: 'textgenerationwebui' }); h.run();
    assert.equal(h.saves(), 1); assert.deepEqual(h.apiChanges, ['openai']);
    assert.ok(h.writes.some(write => write.selector === '#main_api' && write.value === 'openai'));
    assert.equal(h.composer.disabled, false);
});

test('actual model selection and sampling changes remain fully applied rather than masked by token refresh', () => {
    const h = harness();
    h.model.model_id = 'synthetic-selected-model'; h.model.temperature = 1.2;
    h.run();
    assert.equal(h.saves(), 1); assert.equal(h.c.oai_settings.custom_model, 'synthetic-selected-model');
    assert.equal(h.c.oai_settings.temp_openai, 1.2); assert.deepEqual(h.statuses, ['synthetic-selected-model']);
    assert.equal(h.scopes[0].id, 'synthetic-selected-model');
});

test('no verified runtime or no bridge token leaves authorization and controls untouched', () => {
    for (const missing of ['runtime', 'launch', 'token']) {
        const h = harness();
        if (missing === 'runtime') h.c.session.runtime = null;
        if (missing === 'launch') h.c.launch = null;
        if (missing === 'token') h.c.launch.bridge_token = '';
        const previous = JSON.stringify(h.c.oai_settings);
        h.run();
        assert.equal(h.saves(), 0); assert.equal(JSON.stringify(h.c.oai_settings), previous);
        assert.deepEqual(h.writes, []); assert.deepEqual(h.scopes, []); assert.deepEqual(h.statuses, []);
    }
});

test('existing unchanged authorization early return stays unchanged and never introduces a new global save', () => {
    const h = harness({ settings: { custom_include_headers: headersFor('synthetic-new-token') } });
    h.run();
    assert.equal(h.saves(), 0); assert.deepEqual(h.writes, []); assert.deepEqual(h.statuses, ['fixture-model']);
});
