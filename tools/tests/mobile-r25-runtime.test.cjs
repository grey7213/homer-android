const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../sillytavern-runtime/public/script.js'), 'utf8');

test('refresh one imported card without reloading all cards or changing other indices', async () => {
  const start = source.indexOf('export async function getOneCharacter(');
  const end = source.indexOf('export function getCharacterSource(', start);
  let requests = [], next = { avatar: 'new.png', name: 'New', chat: 'chat' };
  const scope = {
    characters: [{ avatar: 'existing.png', name: 'Existing' }],
    DOMPurify: { sanitize: text => text }, getRequestHeaders: () => ({}),
    fetch: async (url, options) => { requests.push({url, payload: JSON.parse(options.body)}); return {ok: true, json: async () => next}; },
    toastr: { error: () => { throw Error('Unexpected missing character'); } },
  };
  vm.runInNewContext(source.slice(start, end).replace('export ', ''), scope);
  assert.equal(await scope.getOneCharacter('new.png', {addIfMissing:true}), 1);
  assert.equal(scope.characters.length, 2);
  assert.equal(scope.characters[0].name, 'Existing');
  next = {...next, name:'Updated'};
  assert.equal(await scope.getOneCharacter('new.png', {addIfMissing:true}), 1);
  assert.equal(scope.characters.length, 2);
  assert.equal(scope.characters[1].name, 'Updated');
  assert.ok(requests.every(r => r.url === '/api/characters/get' && r.payload.avatar_url === 'new.png'));
});

function bindingHarness(header) {
  const start = source.indexOf('export async function bindCharacterChatWithoutLoad(');
  const end = source.indexOf('//////////', start);
  assert.ok(start >= 0 && end > start, 'Shipping binder source boundaries');
  const fields = {}, prompts = [], requests = [], clears = [], requestHeaders = { 'X-Fixture-Header': 'synthetic' };
  let jsonReads = 0, uuidCalls = 0;
  const prohibited = () => { throw Error('Binder must not load message bodies or save a provisional chat'); };
  const scope = { characters:[{name:'New card', avatar:'original-card.png'}], this_chid:0, name2:'Previous card', chat_metadata:{old:true},
    isChatSaving:false, debounce_timeout:{extended:100}, waitUntilCondition:async check=>assert.ok(check()),
    clearChat:async options=>clears.push(JSON.parse(JSON.stringify(options))),
    uuidv4:()=> { uuidCalls++; return 'new-integrity'; }, $:selector=>({val:value=>fields[selector]=value}),
    getCurrentChatId:()=> 'Homer-id', loadItemizedPrompts:async id=>prompts.push(id),
    prepareItemizedPrompts: chatId => ({chatId, pending: Promise.resolve()}),
    applyPreparedItemizedPrompts: async preparation => prompts.push(preparation.chatId),
    getRequestHeaders:()=>requestHeaders,
    fetch:async (url, options)=> {
      const payload = JSON.parse(options.body);
      requests.push({url, method:options.method, payload});
      assert.equal(url, '/api/chats/get');
      assert.equal(options.method, 'POST');
      assert.equal(options.cache, 'no-cache');
      assert.equal(options.headers, requestHeaders);
      assert.deepEqual(payload, {avatar_url:'original-card.png', file_name:'Homer-id', metadata_only:true});
      return {ok:true, json:async()=> { jsonReads++; return header; }, text:prohibited, arrayBuffer:prohibited};
    },
    getChat:prohibited, loadChat:prohibited, saveChat:prohibited, saveChatConditional:prohibited,
  };
  vm.runInNewContext(source.slice(start, end).replace(/^export /gm, ''), scope);
  return {scope, fields, prompts, requests, clears, counts:()=>({jsonReads, uuidCalls})};
}

test('cloud binding initializes name and integrity without loading message bodies or saving a provisional chat', async () => {
  const {scope, fields, prompts, requests, clears, counts} = bindingHarness({});
  await scope.bindCharacterChatWithoutLoad('Homer-id');
  assert.equal(scope.characters[0].chat, 'Homer-id');
  assert.equal(scope.characters[0].avatar, 'original-card.png');
  assert.equal(scope.name2, 'New card');
  assert.equal(scope.chat_metadata.integrity, 'new-integrity');
  assert.equal(scope.chat_metadata.old, undefined);
  assert.equal(fields['#selected_chat_pole'], 'Homer-id');
  assert.deepEqual(prompts, ['Homer-id']);
  assert.deepEqual(clears, [{clearData:true, preserveItemizedPrompts:true}]);
  assert.equal(requests.length, 1);
  assert.deepEqual(counts(), {jsonReads:1, uuidCalls:1});
});

test('cloud binding retains the original stored integrity header using only the metadata-only request', async () => {
  const header = {chat_metadata:{integrity:'original-integrity', fixtureHeader:{retained:true}}};
  const original = JSON.stringify(header);
  const {scope, prompts, requests, counts} = bindingHarness(header);
  await scope.bindCharacterChatWithoutLoad('Homer-id');
  assert.deepEqual(JSON.parse(JSON.stringify(scope.chat_metadata)), header.chat_metadata);
  assert.notEqual(scope.chat_metadata, header.chat_metadata);
  assert.equal(scope.chat_metadata.old, undefined);
  assert.equal(scope.characters[0].avatar, 'original-card.png');
  assert.equal(scope.characters[0].chat, 'Homer-id');
  assert.equal(JSON.stringify(header), original, 'The persisted header must not be mutated');
  assert.deepEqual(prompts, ['Homer-id']);
  assert.equal(requests.length, 1);
  assert.deepEqual(counts(), {jsonReads:1, uuidCalls:0});
});
