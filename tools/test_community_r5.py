"""R5 regression tests: realistic transitions and an isolated upload directory."""
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_community_feed import FeedTests
from community_feed import ensure_feed_schema,handle_feed_route
from community_media import CommunityMediaStore
from community_service import Rejected

class CommunityR5Tests(FeedTests):
    def test_media_ownership_and_publication(self):
        with tempfile.TemporaryDirectory(prefix='homer-community-test-') as directory:
            store=CommunityMediaStore(self.conn,self.lock,directory)
            def call(path,body,user='a'):
                return handle_feed_route('POST','console/api/web/social/media/'+path,{},body,dict(conn=self.conn,lock=self.lock,user={'id':user,'name':'媒体测试'},is_admin=False,media_store=store))
            content=b'\x00\x00\x00\x20ftypisom'+b'0'*40
            upload=call('init',{'mime':'video/mp4','size':len(content)})['data']['id']
            chunk={'id':upload,'index':0,'data':base64.b64encode(content).decode()}
            self.assertEqual(call('chunk',chunk,user='b')['__http__'],404)
            self.assertEqual(call('chunk',chunk)['data']['next_chunk'],1)
            self.assertEqual(call('chunk',chunk)['data']['next_chunk'],1)
            url=call('finalize',{'id':upload})['data']['url']
            self.assertEqual(call('finalize',{'id':upload})['data']['url'],url)
            ctx={'conn':self.conn,'lock':self.lock,'user':{'id':'b'}}
            with self.assertRaises(Rejected):store.read_file(upload,ctx)
            # Referencing someone else's private upload must not grant access,
            # including when the attacker can read their own pending post.
            self.call('POST','posts',{'content':'盗用引用测试','topic':'交流闲聊','video':url,'client_id':'stolen'},user='b')
            with self.assertRaises(Rejected):store.read_file(upload,ctx)
            post=self.call('POST','posts',{'content':'媒体帖子','topic':'交流闲聊','video':url,'client_id':'video'})['data']
            self.assertEqual(post['status'],'pending')
            with self.assertRaises(Rejected):store.read_file(upload,ctx)
            self.assertEqual(self.call('PATCH','admin/content/post/'+post['id'],{'action':'approve','version':1,'reason':'人工审核通过'},admin=True)['code'],0)
            path,mime=store.read_file(upload,ctx);self.assertEqual(path.read_bytes(),content);self.assertEqual(mime,'video/mp4')
            self.call('PUT','blocks',{'user_id':'b','blocked':True})
            with self.assertRaises(Rejected):store.read_file(upload,ctx)

    def test_unavailable_card_reference_does_not_leak(self):
        ctx={'conn':self.conn,'lock':self.lock,'user':{'id':'a'},'resolve_cards':lambda ids,u:{'1':{'visible':False,'id':'private','name':'secret'},'2':{'visible':True,'id':'public','name':'角色名','worldbook':'secret'}}}
        result=handle_feed_route('POST','console/api/web/social/resolve-cards',{}, {'ids':['1','2']},ctx)['data']['cards']
        self.assertEqual(result['1'],{'status':'unavailable'});self.assertEqual(result['2'],{'status':'available','internal_id':'public','name':'角色名'})

    def test_rule_import_is_atomic(self):
        r=self.call('POST','admin/rules/import',{'rules':[{'term':'测试导入','category':'spam','action':'review'},{'term':'无效类别','category':'sexual','action':'block'}]},admin=True)
        self.assertEqual(r['__http__'],400)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM social_rules WHERE term='测试导入'").fetchone()[0],0)

    def test_review_cannot_approve_stale_version(self):
        post=self.post();body={'content':'https://example.com/review','topic':'交流闲聊','version':1}
        self.call('PATCH','posts/'+post['id'],body)
        stale=self.call('PATCH','admin/content/post/'+post['id'],{'action':'approve','version':1,'reason':'测试'},admin=True)
        self.assertEqual(stale['__http__'],409)
        self.assertEqual(self.call('GET','posts/'+post['id'],user='b')['data']['content'],post['content'])

    def test_report_claim_conflict_and_notification(self):
        post=self.post(user='b')
        case=self.call('POST','posts/'+post['id']+'/report',{'category':'attack'})['data']['id']
        self.call('PATCH','admin/reports/'+str(case),{'action':'claim','reason':'领取'},user='c',admin=True)
        self.assertEqual(self.call('PATCH','admin/reports/'+str(case),{'action':'delete','reason':'竞争处理'},admin=True)['__http__'],409)
        self.assertEqual(self.call('GET','posts/'+post['id'])['code'],0)
        self.call('PATCH','admin/reports/'+str(case),{'action':'delete','reason':'核查后删除'},user='c',admin=True)
        self.assertEqual(self.call('GET','posts/'+post['id'])['__http__'],404)
        notices=self.call('GET','notifications')['data']['list']
        self.assertEqual(notices[0]['kind'],'report')

    def test_banned_account_can_appeal_and_read_result(self):
        self.call('GET','posts')
        self.call('POST','admin/sanctions',{'user_id':'a','kind':'ban','days':3,'category':'phishing','reason':'测试封禁'},user='b',admin=True)
        self.assertEqual(self.call('GET','posts')['kind'],'banned')
        self.assertEqual(self.call('GET','notifications')['data']['list'][0]['kind'],'system')
        sid=self.call('GET','account-status')['data']['sanctions'][0]['id']
        self.call('POST','appeals',{'sanction_id':sid,'reason':'请求复核'})
        aid=self.call('GET','account-status')['data']['appeals'][0]['id']
        self.call('PATCH','admin/appeals/'+str(aid),{'state':'accepted','reason':'复核解除'},user='b',admin=True)
        self.assertEqual(self.call('GET','posts')['code'],0)

    def test_notifications_are_account_scoped(self):
        post=self.post();self.call('PUT','posts/'+post['id']+'/like',{'liked':True},user='b')
        notice=self.call('GET','notifications')['data']['list'][0]
        self.call('PUT','notifications',{'ids':[notice['id']]},user='b')
        self.assertEqual(self.call('GET','notifications')['data']['unread'],1)
        self.call('PUT','notifications',{'ids':[notice['id']]})
        self.assertEqual(self.call('GET','notifications')['data']['unread'],0)

    def test_migration_keeps_old_report_once(self):
        p=self.post();self.conn.execute('INSERT INTO social_reports(post_id,user_id,reason,created_at) VALUES(?,?,?,?)',(p['id'],'b','旧举报',1))
        self.conn.execute("DELETE FROM social_config WHERE key='r5_initialized'");self.conn.commit()
        ensure_feed_schema(self.conn,self.lock);ensure_feed_schema(self.conn,self.lock)
        reports=self.call('GET','admin/reports',admin=True)['data']['list']
        self.assertEqual(len(reports),1);self.assertEqual(reports[0]['snapshot']['content'],p['content'])

    def test_invalid_media_input_returns_400(self):
        for image in [{'unexpected':1},'https://[invalid']:
            self.assertEqual(self.call('POST','posts',{'images':[image],'topic':'交流闲聊','content':'测试','client_id':'invalid'})['__http__'],400)

if __name__=='__main__':
    unittest.main(defaultTest='CommunityR5Tests')
