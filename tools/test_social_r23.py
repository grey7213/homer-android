"""Isolated community authorization, relation pagination and promotion regressions."""
import sqlite3
import sys
import threading
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'server-extensions'))
from community_feed import ensure_feed_schema, handle_feed_route
from community_policy import VERSION
from promotion_guard import classify, enforce, PromotionRejected, record_rejection, active_mute


class SocialR23(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.lock=threading.RLock()
        ensure_feed_schema(self.db,self.lock)
        for uid in ('alice','bob'):
            self.db.execute('INSERT INTO social_consents VALUES(?,?,0)',(uid,VERSION))
            self.db.execute('INSERT INTO social_members(user_id,name) VALUES(?,?)',(uid,uid))
        self.db.commit()

    def tearDown(self): self.db.close()
    def call(self,path,method='GET',body=None,uid='alice',admin=False,query=None):
        return handle_feed_route(method,'console/api/web/social/'+path,query or {},body or {},
            dict(conn=self.db,lock=self.lock,user={'id':uid,'name':uid},is_admin=admin))
    def post(self,content='一个普通故事',uid='alice'):
        return self.call('posts','POST',{'client_id':'new-'+uid,'title':'故事','content':content,'topic':'角色故事'},uid)
    def test_ordinary_owner_edits_other_user_cannot(self):
        p=self.post()['data']
        body={'version':p['version'],'content':'更新后的内容','title':'修改标题','topic':'角色故事'}
        self.assertEqual(self.call('posts/'+str(p['id']),'PATCH',body,'bob')['__http__'],403)
        edited=self.call('posts/'+str(p['id']),'PATCH',body)['data']
        self.assertEqual(edited['content'],'更新后的内容')
        self.assertEqual(self.call('posts/'+str(p['id']),'PATCH',body)['__http__'],409)
    def test_promotion_persists_but_content_does_not(self):
        r=self.post('有，无限制，无偿，私我')
        self.assertEqual(r['kind'],'promotion_muted')
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_posts').fetchone()[0],0)
        self.assertTrue(active_mute(self.db,'alice'))
        self.assertEqual(self.post()['kind'],'muted')
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_sanctions').fetchone()[0],1)
        status=self.call('account-status')['data'];sid=status['sanctions'][0]['id']
        self.assertTrue(self.call('appeals','POST',{'sanction_id':sid,'reason':'申请复核'})['data']['submitted'])
        self.assertEqual(self.call('admin/sanctions/'+str(sid)+'/revoke','POST',{'reason':'误判'})['__http__'],403)
        self.assertEqual(self.call('admin/sanctions/'+str(sid)+'/revoke','POST',{'reason':'误判'},'bob',True)['code'],0)
        self.assertFalse(active_mute(self.db,'alice'))
    def test_preflight_and_quoting_do_not_mute(self):
        self.call('preflight','POST',{'content':'有，无限制，无偿，私我'})
        self.assertFalse(active_mute(self.db,'alice'))
        p=self.post('举报广告示例：有，无限制，无偿，私我')['data']
        self.assertEqual(p['status'],'pending');self.assertFalse(active_mute(self.db,'alice'))
    def test_comment_and_edit_use_same_policy(self):
        p=self.post(uid='bob')['data']
        r=self.call('posts/'+str(p['id'])+'/comments','POST',{'client_id':'c','content':'这是地址 https://pveso.com/'})
        self.assertEqual(r['kind'],'promotion_muted')
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_comments').fetchone()[0],0)
        self.assertEqual(self.call('posts/'+str(p['id']),'PATCH',{'version':1,'content':'有，无限制，无偿，私我','topic':'角色故事'},'bob')['kind'],'promotion_muted')
    def test_unauthorized_edit_does_not_punish_owner(self):
        p=self.post()['data']
        self.call('posts/'+str(p['id']),'PATCH',{'version':1,'content':'有，无限制，无偿，私我','topic':'角色故事'},'bob')
        self.assertEqual(self.db.execute('SELECT count(*) FROM social_sanctions').fetchone()[0],0)
    def test_relation_pagination_and_blocking(self):
        for i in range(105):
            uid=f'person-{i:03}'
            self.db.execute('INSERT INTO social_members(user_id,name) VALUES(?,?)',(uid,uid))
            self.db.execute('INSERT INTO social_follows VALUES(?,?)',('alice',uid))
        self.db.commit();seen=[];cursor=''
        while True:
            d=self.call('users/alice/following',query={'cursor':cursor,'limit':'40'})['data']
            seen.extend(x['user_id'] for x in d['list']);self.assertTrue(all(x['following'] for x in d['list']))
            if not d['has_more']:break
            cursor=d['next_cursor']
        self.assertEqual(len(set(seen)),105)
        search=self.call('users/alice/following',query={'q':'person-104','limit':'40'})['data']
        self.assertEqual([x['user_id'] for x in search['list']],['person-104'])
        self.db.execute('INSERT INTO social_blocks VALUES(?,?,0)',('person-000','alice'));self.db.commit()
        d=self.call('users/alice/following')['data'];self.assertNotIn('person-000',[x['user_id'] for x in d['list']])
        self.db.execute('UPDATE social_members SET following_public=0 WHERE user_id=?',('alice',));self.db.commit()
        self.assertTrue(self.call('users/alice/following',uid='bob')['data']['private'])
    def test_examples_and_normal_speech(self):
        for text in ['有，无限制，无偿，私我','AI软件网址：https://b23.tv/RPxYL5w 软件获取备用方法1：https://b23.tv/G3QGzQc 支持解除AI限制/AI破甲','这是地址[doge_金箍]，https://pveso.com/']:
            self.assertEqual(classify(text)['action'],'mute')
        for text in ['有','无偿帮忙修卡','有问题私我','推荐这张卡 ID：1234','这个故事没有限制','教程参考 https://b23.tv/example','Tavo 的长记忆功能如何使用？']:
            self.assertEqual(classify(text)['action'],'allow')
    def test_relation_search_counts_and_mutual(self):
        self.db.execute('INSERT INTO social_follows VALUES(?,?)',('alice','bob'))
        self.db.execute('INSERT INTO social_follows VALUES(?,?)',('bob','alice'))
        self.db.execute('UPDATE social_members SET name=?,bio=? WHERE user_id=?',('Bobby','写故事的人','bob'))
        self.db.commit()
        for kind in ('following','followers'):
            result=self.call('users/alice/'+kind,query={'q':'BOB'})['data']
            self.assertEqual(result['counts'],{'following':1,'followers':1})
            self.assertEqual(result['total'],1)
            self.assertTrue(result['list'][0]['following'])
            self.assertTrue(result['list'][0]['followed_by'])
            self.assertEqual(self.call('users/alice/'+kind,query={'q':'not present'})['data']['list'],[])
        self.db.execute('INSERT INTO social_blocks VALUES(?,?,0)',('bob','alice'));self.db.commit()
        result=self.call('users/alice/followers')['data']
        self.assertEqual(result['counts'],{'following':0,'followers':0})
    def test_external_surface_shared_mute(self):
        try:enforce(self.db,'alice','有，无限制，无偿，私我','card-comment:test')
        except PromotionRejected as exc:record_rejection(self.db,'alice',exc);self.db.commit()
        with self.assertRaises(ValueError):enforce(self.db,'alice','正常留言','card-comment:other')
        self.assertEqual(self.post()['kind'],'muted')

if __name__=='__main__':unittest.main()
