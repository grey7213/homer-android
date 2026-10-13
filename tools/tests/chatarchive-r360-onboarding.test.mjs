import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareArchiveRole } from '../../frontend/app/assets/js/archive-resource-client.mjs';
import {stageCast} from '../../frontend/app/assets/js/archive-cast.mjs';

test('automatic resource preparation is single explicit request, no file picker or model API', async () => {
  let state = {packs:[]}, calls=0;
  const native = {getArchiveMediaStatus:()=>JSON.stringify(state),prepareArchiveMedia(id){calls++;state={packs:[id],state:'ready'};}};
  assert.equal(await prepareArchiveRole('yuuka',{native,delay:()=>Promise.resolve()}),true);
  assert.equal(calls,1);
  await prepareArchiveRole('yuuka',{native}); assert.equal(calls,1);
});
test('failed download and switched owner never proceed to creating game', async () => {
  let state={packs:[],attempt:0};
  const native = {getArchiveMediaStatus:()=>JSON.stringify(state),prepareArchiveMedia(){state={packs:[],attempt:1,requestedPack:'yuuka',state:'download_failed'};}};
  await assert.rejects(prepareArchiveRole('yuuka',{native}),{code:'ARCHIVE_DOWNLOAD_FAILED'});
  await assert.rejects(prepareArchiveRole('yuuka',{native,current:()=>false}),{name:'AbortError'});
});
test('old bridge requires upgrade instead of asking users to move files', async()=>{
  await assert.rejects(prepareArchiveRole('yuuka',{native:{getArchiveMediaStatus:()=>'{"packs":[]}'}}),{code:'ARCHIVE_BRIDGE_REQUIRED'});
});
test('ensemble is explicit joined cast, bounded to three and private date excludes other people',()=>{
  const characters=['yuuka','noa','arisu','hina'].map(id=>({id,name:id,themeRoleId:id}));
  const game={characters,active:{characterId:'yuuka'}};
  assert.deepEqual(stageCast(game,'noa').map(c=>c.id),['noa','yuuka','arisu']);
  game.active.eventId='private-date';assert.deepEqual(stageCast(game,'hina').map(c=>c.id),['yuuka']);
});
