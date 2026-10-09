import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateInvitations, readableGameReply, createGame, applyGameCommand, buildGameContext } from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
import { projectGameMessages } from '../../frontend/app/assets/js/visual-novel-game-session.mjs';
const setup = {id:'invite-test',owner:'synthetic-owner',title:'合成故事',player:{name:'合成玩家'},world:{scene:'教室',summary:''},
  characters:[{id:'person',appId:'test-app',name:'合成人物',avatar:'',conversationId:'test-conversation'}]};
test('invitations require complete standalone markers; code examples and ambiguous prose are inert', () => {
  assert.deepEqual(parseDateInvitations('要不要散步？'),[]);
  assert.deepEqual(parseDateInvitations('这只是[约会邀请:海边|日落]的演示'),[]);
  assert.deepEqual(parseDateInvitations('```text\n[约会邀请:海边|日落]\n```'),[]);
  assert.deepEqual(parseDateInvitations('[约会邀请:海边|日落]\n[约会邀请：海边|日落]\n[约会邀请: |地点]'),[{title:'海边',scene:'日落'}]);
  assert.equal(parseDateInvitations(Array.from({length:5},(_,i)=>`[约会邀请:主题${i}|地点${i}]`).join('\n')).length,3);
});
test('readable projection removes only actionable markers, retaining raw reply and code examples', () => {
  const reply='一起走走吧。\n[约会邀请:海边|日落]\n```text\n[约会邀请:海边|日落]\n```';
  assert.equal(readableGameReply(reply),'一起走走吧。\n```text\n[约会邀请:海边|日落]\n```');
});
test('private reply and invitation commit atomically, explicit entry/finish drive separate event state', () => {
  let game=createGame(setup); const command=c=>game=applyGameCommand(game,c);
  command({type:'select',characterId:'person',channel:'talk'});
  command({type:'begin-turn',requestId:'turn-1',...game.active,userText:'一起出去吗'});
  assert.equal(game.events.length,0);
  command({type:'finish-turn',requestId:'turn-1',reply:'当然。\n[约会邀请:海边|日落]',canonicalMessageId:'real-result'});
  assert.equal(game.events.length,1); assert.equal(game.events[0].status,'planned'); assert.equal(game.active.channel,'talk');
  assert.equal(projectGameMessages(game).at(-1).mes,'当然。'); assert.equal(game.turns[0].reply,'当然。\n[约会邀请:海边|日落]');
  const event=game.events[0]; command({type:'start-date',eventId:event.id});
  assert.equal(game.active.eventId,event.id); assert.equal(game.active.channel,'stage');
  assert.match(buildGameContext(game,'person','stage',event.id),/约会地点：日落/);
  command({type:'finish-date',eventId:event.id}); assert.equal(game.active.channel,'talk');
  assert.match(buildGameContext(game,'person','talk'),/已结束约会：海边/);
  assert.throws(()=>command({type:'finish-turn',requestId:'turn-1',reply:'重复',canonicalMessageId:'duplicate'}),{code:'VN_GAME_REQUEST_INVALID'});
  assert.equal(game.events.length,1);
});
test('stage output, stopped and uncertain replies never fabricate invitations', () => {
  let game=createGame(setup); game=applyGameCommand(game,{type:'begin-turn',requestId:'stage',...game.active,userText:'行动'});
  game=applyGameCommand(game,{type:'finish-turn',requestId:'stage',reply:'[约会邀请:主题|地点]',canonicalMessageId:'stage-result'});
  assert.equal(game.events.length,0);
});

test('group has separate all-member transcript, never includes private memories or dates', () => {
  let game=createGame(setup); const command=c=>game=applyGameCommand(game,c);
  assert.throws(()=>command({type:'select',characterId:'person',channel:'group'}),{code:'VN_GAME_GROUP_MEMBERS'});
  command({type:'add-character',character:{id:'person-b',appId:'app-b',name:'人物乙',avatar:'',conversationId:'conversation-b'}});
  command({type:'select',characterId:'person',channel:'talk'});
  command({type:'begin-turn',requestId:'private-secret',...game.active,userText:'私聊哨兵'});
  command({type:'finish-turn',requestId:'private-secret',reply:'私人回复哨兵',canonicalMessageId:'private-result'});
  command({type:'archive-turn',requestId:'private-secret'});
  command({type:'plan-date',eventId:'private-date',characterId:'person',title:'私人约会哨兵',scene:'私人地点哨兵'});
  command({type:'start-date',eventId:'private-date'}); command({type:'finish-date',eventId:'private-date'});
  command({type:'select',characterId:'person',channel:'group'});
  command({type:'begin-turn',requestId:'group-one',...game.active,userText:'群话题哨兵'});
  command({type:'finish-turn',requestId:'group-one',reply:'[角色:人物乙]\n群回复哨兵\n[约会邀请:不要进入|不要进入]',canonicalMessageId:'group-result'});
  assert.equal(game.events.length,1); // No invitations from group output.
  command({type:'select',characterId:'person-b',channel:'group'});
  assert.equal(projectGameMessages(game).length,2);
  const context=buildGameContext(game,'person-b','group');
  assert.match(context,/群话题哨兵/); assert.match(context,/群回复哨兵/); assert.match(context,/故事群成员：合成人物、人物乙/);
  assert.doesNotMatch(context,/私聊哨兵|私人回复哨兵|私人约会哨兵|私人地点哨兵/);
  command({type:'archive-turn',requestId:'group-one'});
  assert.match(buildGameContext(game,'person-b','group'),/群话题哨兵/);
  assert.doesNotMatch(buildGameContext(game,'person','talk'),/群话题哨兵|群回复哨兵/);
  assert.throws(()=>buildGameContext(game,'person','group','private-date'),{code:'VN_GAME_ACTIVE_MISMATCH'});
});
