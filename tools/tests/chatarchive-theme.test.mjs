import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archiveRole, archiveCharacterCard, archiveScene, themeRoleMetadata } from '../../frontend/app/assets/js/chatarchive-theme.mjs';
import { createGame, applyGameCommand } from '../../frontend/app/assets/js/visual-novel-game-store.mjs';
const catalog = JSON.parse(fs.readFileSync(new URL('../../frontend/app/assets/data/chatarchive-theme.json', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../../frontend/app/assets/data/chatarchive-pack.json', import.meta.url)));
test('entire verified 1.1.11 catalog is preserved, with two missing profiles explicitly unavailable', () => {
  assert.equal(catalog.sourceVersion, '1.1.11'); assert.equal(catalog.roles.length, 67);
  assert.equal(catalog.roles.reduce((count, role) => count + role.variants.length, 0), 225);
  assert.equal(catalog.roles.filter(role => role.profile).length, 65);
  assert.equal(catalog.backgrounds.length, 361); assert.equal(catalog.music.length, 57); assert.equal(catalog.emotionAudio.length, 20);
  for (const role of catalog.roles) {
    for (const variant of role.variants) {
      for (const url of [variant.atlas, variant.skeleton, ...variant.textures]) assert.ok(manifest.entries[url.split('/archive-local-1111/')[1]], url);
    }
    if (!role.profile) assert.throws(() => archiveCharacterCard(catalog, role.id));
    else {
      const card = archiveCharacterCard(catalog, role.id);
      assert.equal(card.data.description, role.profile);
      assert.equal(card.data.character_book.entries.length, 66);
      assert.ok(card.data.character_book.entries.some(entry => entry.content === role.profile && entry.constant && entry.enabled));
      assert.equal(card.data.character_book.entries[0].constant, true);
    }
  }
  assert.equal(manifest.bytes > 1_000_000_000, true); // media is external, never APK input
});
test('exact/space-normalized aliases, background keywords and real animation identifiers resolve to real media', () => {
  const koharu = archiveRole(catalog, '下江小春'); assert.equal(koharu.id, 'koharu');
  const variant = koharu.variants[0], animation = variant.animations[0];
  const scene = archiveScene(catalog, { themeRoleId: 'koharu' }, { background: '夏莱办公室', portrait: `koharu/${variant.id}/${animation}` });
  assert.equal(scene.background.id, 'common/BG_MainOffice'); assert.equal(scene.portrait.metadata.spine.animation, animation);
  assert.equal(archiveScene(catalog, { themeRoleId: 'koharu' }, { mood: 'Sad' }).effect.id, 'SFX_Emoticon_Motion_Sad');
  const fallback = archiveScene(catalog, { themeRoleId: 'koharu' }, { portrait: 'https://evil.invalid/../secrets', bgm: 'unknown' });
  assert.ok(fallback.portrait.metadata.spine.skeleton_url.startsWith('/media-cache/card-assets/ready/archive-local-1111/'));
  assert.equal(archiveScene(catalog, {}), null);
  const missing = archiveScene(catalog, { themeRoleId: 'koharu' }, {}, '', { availableRoles: [], availableBackgrounds: [], availableMusic: [] });
  assert.equal(missing.portrait, null); assert.equal(missing.background, null); assert.equal(missing.bgm, null);
});
test('theme identity survives local save, index and restore without changing legacy games', () => {
  const role = themeRoleMetadata(archiveRole(catalog, 'koharu'));
  const game = createGame({ id: 'theme-game', owner: 'synthetic-owner', title: '基沃托斯', player: { name: '老师' }, world: { scene: '夏莱办公室', summary: '' },
    characters: [{ ...role, id: 'private-role', appId: 'private-role', conversationId: 'new-private-thread' }] });
  assert.equal(applyGameCommand(JSON.parse(JSON.stringify(game)), { type: 'select', characterId: 'private-role', channel: 'talk' }).characters[0].themeRoleId, 'koharu');
  assert.ok(!JSON.stringify(game).includes('profile'));
});

test('workshop role uses bundled room without downloading unrelated base media', () => {
  const role={...catalog.roles[0],id:'mod-local',source:{resourceId:'test'},name:'工坊人物'};
  const scene=archiveScene({...catalog,roles:[role]}, {themeRoleId:role.id},{},'',
    {availableRoles:[],availableBackgrounds:[],availableMusic:[]});
  assert.equal(scene.background.id,'homer-room');
  assert.equal(scene.background.url,'/app/assets/images/archive-room.svg');
  assert.ok(scene.portrait);assert.equal(scene.bgm,null);
});
