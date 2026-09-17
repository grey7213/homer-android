"""Isolated database tests for community permissions and durable behavior."""
import sys, sqlite3, threading, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server-extensions'))
from community_feed import ensure_feed_schema, handle_feed_route
from community_policy import VERSION

class FeedTests(unittest.TestCase):
    def setUp(self):
        self.conn=sqlite3.connect(':memory:');self.lock=threading.RLock();ensure_feed_schema(self.conn,self.lock)
        self.conn.execute("UPDATE social_config SET value='open' WHERE key='mode'")
        for uid in ('a','b','c'):
            self.conn.execute('INSERT INTO social_consents VALUES(?,?,?)',(uid,VERSION,1))
        self.conn.commit()
    def tearDown(self):self.conn.close()
    def call(self,method,path,body=None,user='a',admin=False,query=None):
        return handle_feed_route(method,'console/api/web/social/'+path,query or {},body or {},dict(conn=self.conn,lock=self.lock,user={'id':user,'name':'测试作者'} if user else {},is_admin=admin))
    def post(self,key='first',user='a'):
        return self.call('POST','posts',{'title':'测试帖子','content':'正文 '+key,'topic':'交流闲聊','images':[],'client_id':key},user)['data']
    def test_auth_and_scope(self):
        self.assertEqual(self.call('GET','posts',user='')['__http__'],401)
        p=self.post();self.assertTrue(p['is_owner']);self.assertNotIn('client_id',p)
        self.assertEqual(self.call('DELETE','posts/'+p['id'],user='b')['__http__'],403)
        self.assertEqual(self.call('PATCH','posts/'+p['id'],{},user='b')['__http__'],403)
    def test_publish_is_idempotent(self):
        self.assertEqual(self.post()['id'],self.post()['id']);self.assertEqual(len(self.call('GET','posts')['data']['list']),1)
    def test_like_is_idempotent(self):
        p=self.post();path='posts/'+p['id']+'/like'
        for _ in range(2):self.assertEqual(self.call('PUT',path,{'liked':True})['data']['like_count'],1)
        self.assertEqual(self.call('PUT',path,{'liked':False})['data']['like_count'],0)
    def test_save_is_idempotent_and_scoped(self):
        p=self.post();path='posts/'+p['id']+'/save'
        self.assertTrue(self.call('PUT',path,{'saved':True})['data']['saved'])
        self.assertEqual(self.call('PUT',path,{'saved':True})['data']['save_count'],1)
        saved=self.call('GET','posts',query={'scope':'saved'})['data']['list']
        self.assertEqual([item['id'] for item in saved],[p['id']])
        self.assertFalse(self.call('PUT',path,{'saved':False})['data']['saved'])
        self.assertEqual(self.call('GET','posts',query={'scope':'saved'})['data']['list'],[])
    def test_comments_and_permissions(self):
        p=self.post();path='posts/'+p['id']+'/comments';body={'content':'评论','client_id':'c'}
        self.call('POST',path,body,user='b');self.call('POST',path,body,user='b')
        comments=self.call('GET',path)['data']['list'];self.assertEqual(len(comments),1)
        self.assertEqual(self.call('DELETE','comments/'+comments[0]['id'])['__http__'],403)
        self.assertTrue(self.call('DELETE','comments/'+comments[0]['id'],user='b')['data']['deleted'])
    def test_pagination_and_follow(self):
        for i in range(4):
            self.post(str(i),user='b')
            self.conn.execute('DELETE FROM social_rate')
        first=self.call('GET','posts',query={'limit':'2'})['data'];second=self.call('GET','posts',query={'limit':'2','cursor':first['next_cursor']})['data']
        self.assertFalse(set(p['id'] for p in first['list']) & set(p['id'] for p in second['list']))
        self.assertEqual(self.call('GET','posts',query={'scope':'following'})['data']['list'],[])
        self.call('PUT','follow',{'user_id':'b','following':True})
        self.assertEqual(len(self.call('GET','posts',query={'scope':'following'})['data']['list']),4)
    def test_soft_delete_and_admin(self):
        p=self.post();self.assertTrue(self.call('DELETE','posts/'+p['id'],user='b',admin=True)['data']['deleted'])
        self.assertEqual(self.call('GET','posts/'+p['id'])['__http__'],404)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM social_posts').fetchone()[0],1)
    def test_report_admin_only(self):
        p=self.post();self.call('POST','posts/'+p['id']+'/report',{'category':'attack','reason':'测试举报'},user='b')
        self.assertEqual(len(self.call('GET','reports',user='b')['data']['list']),1)
        self.assertEqual(self.call('GET','admin/reports',user='b')['__http__'],403)
        self.assertEqual(len(self.call('GET','reports',admin=True)['data']['list']),1)
    def test_validation(self):
        for images in [['javascript:alert(1)'],['//evil.test/a'],['https://good.test/\\evil']]:
            r=self.call('POST','posts',{'title':'标题','content':'文本','topic':'交流闲聊','client_id':'bad','images':images})
            self.assertEqual(r['__http__'],400)
        self.assertEqual(self.call('POST','posts',{})['__http__'],400)
        self.assertEqual(self.call('GET','posts',query={'limit':'not-number'})['code'],0)

    def test_rollout_cannot_be_bypassed(self):
        self.conn.execute("UPDATE social_config SET value='internal' WHERE key='mode'")
        self.assertFalse(self.call('GET','bootstrap')['data']['available'])
        self.assertEqual(self.call('GET','posts',query={'preview':'1'})['__http__'],403)
        self.assertTrue(self.call('GET','bootstrap',admin=True)['data']['available'])
        self.call('PUT','admin/config',{'mode':'internal','testers':['b']},admin=True)
        self.assertTrue(self.call('GET','bootstrap',user='b')['data']['available'])

    def test_consent_versions(self):
        self.conn.execute('DELETE FROM social_consents WHERE user_id=?',('a',))
        self.assertEqual(self.call('GET','posts')['kind'],'consent_required')
        self.assertEqual(self.call('POST','consent',{'version':'old','agreement':True,'guidelines':True})['__http__'],409)
        self.assertTrue(self.call('POST','consent',{'version':VERSION,'agreement':True,'guidelines':True})['data']['accepted'])
        self.assertEqual(self.call('GET','posts')['code'],0)

    def test_bilateral_block_filters(self):
        p=self.post(user='b'); self.call('PUT','posts/'+p['id']+'/save',{'saved':True})
        self.call('PUT','blocks',{'user_id':'b','blocked':True})
        for user,scope in [('a','public'),('a','saved'),('b','public')]:
            self.assertEqual(self.call('GET','posts',query={'scope':scope},user=user)['data']['list'],[] if user=='a' else self.call('GET','posts',query={'scope':'mine'},user='b')['data']['list'])
        self.assertEqual(self.call('GET','posts/'+p['id'])['__http__'],404)
        self.assertEqual(self.call('PUT','follow',{'user_id':'b','following':True})['__http__'],403)

    def test_mute_and_appeal(self):
        p=self.post(user='b')
        self.call('GET','posts')
        result=self.call('POST','admin/sanctions',{'user_id':'a','kind':'mute','days':1,'category':'attack','reason':'测试处罚'},admin=True)
        self.assertEqual(result['code'],0,result)
        self.assertEqual(self.call('POST','posts',{'client_id':'blocked'})['kind'],'muted')
        self.assertEqual(self.call('PUT','posts/'+p['id']+'/like',{'liked':True})['kind'],'muted')
        self.assertEqual(self.call('GET','posts')['code'],0)
        sid=self.call('GET','account-status')['data']['sanctions'][0]['id']
        self.assertTrue(self.call('POST','appeals',{'sanction_id':sid,'reason':'请求复核'})['data']['submitted'])

    def test_review_and_version_conflict(self):
        self.call('POST','admin/rules',{'term':'测试拦截','category':'spam','action':'block'},admin=True)
        self.assertEqual(self.call('POST','preflight',{'content':'测试拦截'})['data']['status'],'rejected')
        p=self.post()
        edited=self.call('PATCH','posts/'+p['id'],{'version':1,'content':'https://example.com','topic':'交流闲聊'})
        self.assertTrue(edited['data']['edit_pending'])
        self.assertEqual(self.call('GET','posts/'+p['id'],user='b')['data']['content'],p['content'])
        self.assertEqual(self.call('PATCH','posts/'+p['id'],{'version':1})['__http__'],409)

    def test_report_dedup_and_retired_category(self):
        p=self.post(user='b'); path='posts/'+p['id']+'/report'
        self.assertEqual(self.call('POST',path,{'category':'sexual'})['__http__'],400)
        self.assertFalse(self.call('POST',path,{'category':'phishing'})['data']['duplicate'])
        self.assertTrue(self.call('POST',path,{'category':'phishing'})['data']['duplicate'])
        self.assertEqual(self.call('GET','reports',user='c')['data']['list'],[])

    def test_reply_requires_same_post(self):
        p=self.post(); p2=self.post('second')
        comment=self.call('POST','posts/'+p['id']+'/comments',{'content':'回复','client_id':'reply'},user='b')['data']
        self.assertEqual(self.call('POST','posts/'+p2['id']+'/comments',{'content':'跨帖回复','client_id':'wrong','parent_id':comment['id']})['__http__'],400)

    def test_repeated_migration_preserves_rows(self):
        p=self.post();ensure_feed_schema(self.conn,self.lock)
        self.assertEqual(self.call('GET','posts/'+p['id'])['data']['content'],p['content'])

if __name__=='__main__':unittest.main()
