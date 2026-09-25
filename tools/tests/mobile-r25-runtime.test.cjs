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

test('cloud binding initializes name and integrity without reading or saving a provisional chat', async () => {
  const start = source.indexOf('export async function bindCharacterChatWithoutLoad(');
  const end = source.indexOf('//////////', start);
  let fields = {}, prompts = [];
  const scope = { characters:[{name:'New card'}], this_chid:0, name2:'Previous card', chat_metadata:{old:true},
    isChatSaving:false, debounce_timeout:{extended:100}, waitUntilCondition:async check=>assert.ok(check()),
    clearChat:async()=>{}, uuidv4:()=> 'new-integrity', $:selector=>({val:value=>fields[selector]=value}),
    getCurrentChatId:()=> 'Homer-id', loadItemizedPrompts:async id=>prompts.push(id) };
  vm.runInNewContext(source.slice(start, end).replace('export ', ''), scope);
  await scope.bindCharacterChatWithoutLoad('Homer-id');
  assert.equal(scope.characters[0].chat, 'Homer-id');
  assert.equal(scope.name2, 'New card');
  assert.equal(scope.chat_metadata.integrity, 'new-integrity');
  assert.equal(scope.chat_metadata.old, undefined);
  assert.deepEqual(prompts, ['Homer-id']);
});
