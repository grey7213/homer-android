"""Image tasks against real SQLite and the application's actual debit methods."""
import ast
import base64
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import homer_images as images

SOURCE=Path(os.environ.get('HOMER_BACKEND_SOURCE','output/mobile-r31-submission/server/ai_fengyue_local_server.py'))
TREE=ast.parse(SOURCE.read_text(encoding='utf-8-sig'))

class ImageTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:',check_same_thread=False);self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE users(id TEXT,free_points INT,reward_points INT,paid_points INT,points INT,updated_at INT);
            INSERT INTO users VALUES('u',2,3,95,100,0);
            CREATE TABLE user_events(user_id TEXT,event_type TEXT,summary TEXT,payload_json TEXT,created_at INT);
            CREATE TABLE api_settings(key TEXT PRIMARY KEY,value TEXT,updated_at INT);
            CREATE TABLE conversations(id TEXT,user_id TEXT); INSERT INTO conversations VALUES('c','u');
            CREATE TABLE messages(id TEXT,conversation_id TEXT,user_id TEXT); INSERT INTO messages VALUES('m','c','u');''')
        env={'sqlite3':sqlite3,'now_ms':lambda:int(time.time()*1000)}
        cls=next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='Store')
        names={'credit_balance','_spend_credit_points_locked','require_credit_points'}
        for n in cls.body:
            if isinstance(n,ast.FunctionDef) and n.name in names: exec(compile(ast.Module(body=[n],type_ignores=[]),str(SOURCE),'exec'),env)
        self.store=type('Store',(),{k:env[k] for k in names})();s=self.store
        s.conn=self.db;s.lock=threading.RLock()
        s.get_user_by_id=lambda u:self.db.execute('SELECT * FROM users WHERE id=?',(u,)).fetchone()
        s.get_api_settings_raw=lambda:dict(self.db.execute('SELECT key,value FROM api_settings'))
        s.image_model_settings=lambda **kw:{}
        s.get_conversation=lambda c,u:self.db.execute('SELECT * FROM conversations WHERE id=? AND user_id=?',(c,u)).fetchone()
        s.get_message=lambda m,u:self.db.execute('SELECT * FROM messages WHERE id=? AND user_id=?',(m,u)).fetchone()
        raw=io.BytesIO();Image.new('RGB',(40,30),'#887ad7').save(raw,'PNG');self.picture=images.verified_image(raw.getvalue())
        self.svc=images.ImageService(s,generator=lambda *args:self.picture)
        self.provider={'id':'p','name':'绘图','model':'private-model','base_url':'https://example.com/v1','api_key':'fixture-placeholder', 'enabled':True,'cost_points':7}
        self.dns=patch.object(images.socket,'getaddrinfo',return_value=[(2,1,6,'',('93.184.216.34',443))]);self.dns.start()
        self.svc.save_providers([self.provider],'u');self.db.execute('DELETE FROM user_events');self.db.commit()
    def tearDown(self):self.dns.stop();self.db.close()
    def body(self,**kw):return dict(text='a landscape',provider_id='p',conversation_id='c',message_id='m',request_id='test-request-001',**kw)
    def wait(self,task):
        for _ in range(200):
            with self.store.lock:r=self.db.execute('SELECT * FROM homer_image_tasks WHERE id=?',(task,)).fetchone()
            if r['status']!='running':return dict(r)
            time.sleep(.01)
        self.fail('worker did not finish')
    def balance(self):return self.db.execute('SELECT points FROM users').fetchone()[0]
    def test_success_once_private_history_and_key_preserved(self):
        task=self.svc.create('u',self.body())['id'];r=self.wait(task)
        self.assertEqual(r['status'],'succeeded');self.assertEqual(self.balance(),93)
        self.assertEqual(self.svc.create('u',self.body())['id'],task);self.assertEqual(self.balance(),93)
        self.assertEqual(len(self.svc.history('u','c')),1);self.assertTrue(self.svc.image('u',task)['data_url'].startswith('data:image/jpeg;base64,'))
        for method,args in [(self.svc.history,('other','c')),(self.svc.image,('other',task)),(self.svc.create,('other',self.body()))]:
            with self.assertRaises(images.ImageError):method(*args)
        public=json.dumps(self.svc.providers());self.assertNotIn('private-model',public);self.assertNotIn('api_key',public);self.assertNotIn('base_url',public)
        self.svc.save_providers([{**self.provider,'api_key':''}],'u');self.assertEqual(self.svc.providers(secrets=True)[0]['api_key'],'fixture-placeholder')
    def test_failure_timeout_and_empty_no_charge(self):
        for i,error in enumerate([TimeoutError(),ValueError('secret upstream error')]):
            def fail(*args):raise error
            self.svc.generator=fail;b=self.body();b['request_id']=f'failure-{i}'
            row=self.wait(self.svc.create('u',b)['id'])
            self.assertEqual(row['status'],'failed');self.assertNotIn('secret',row['error']);self.assertEqual(self.balance(),100)
    def test_unaffordable_and_invalid_message_do_not_generate(self):
        for change in [{'message_id':'other'},{'conversation_id':'other'},{'provider_id':'none'},{'text':' '},{'text':'中'*4001}]:
            with self.assertRaises(images.ImageError):self.svc.create('u',{**self.body(),**change})
        self.db.execute('UPDATE users SET points=0,free_points=0,paid_points=0,reward_points=0');self.db.commit()
        with self.assertRaises(images.ImageError) as e:self.svc.create('u',self.body())
        self.assertEqual(e.exception.status,402)
    def test_concurrency_and_delete_during_generation(self):
        ready=threading.Event();release=threading.Event()
        def delayed(*args):ready.set();release.wait(2);return self.picture
        self.svc.generator=delayed;task=self.svc.create('u',self.body())['id'];ready.wait(1)
        with self.assertRaises(images.ImageError):self.svc.create('u',{**self.body(),'request_id':'another-task'})
        with self.store.lock:self.db.execute("DELETE FROM messages WHERE id='m'");self.db.commit()
        release.set();self.assertEqual(self.wait(task)['status'],'failed');self.assertEqual(self.balance(),100)
    def test_transaction_failure_rolls_back_debit(self):
        self.db.execute("CREATE TRIGGER fail_images BEFORE UPDATE ON homer_image_tasks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'test'); END");self.db.commit()
        self.assertEqual(self.wait(self.svc.create('u',self.body())['id'])['status'],'failed');self.assertEqual(self.balance(),100)
        self.assertEqual(self.db.execute('SELECT count(*) FROM user_events').fetchone()[0],0)
    def test_free_image_does_not_spend_one_point(self):
        self.svc.save_providers([{**self.provider,'cost_points':0}],'u');self.wait(self.svc.create('u',self.body())['id']);self.assertEqual(self.balance(),100)
    def test_restart_fails_pending_without_billing(self):
        self.db.execute("INSERT INTO homer_image_tasks(id,user_id,conversation_id,message_id,request_id,provider_id,provider_name,prompt,cost,status,created_at) VALUES('orphan','u','c','m','orphan-id','p','name','prompt',7,'running',0)");self.db.commit()
        images.ImageService(self.store);self.assertEqual(self.wait('orphan')['status'],'failed');self.assertEqual(self.balance(),100)
    def test_permissions_and_invalid_assets(self):
        with self.assertRaises(images.ImageError) as e:images.route(self.store,'POST','admin/api/image-models',{}, {'list':[]},{'id':'u','is_admin':False})
        self.assertEqual(e.exception.status,403)
        with self.assertRaises(images.ImageError):images.route(self.store,'GET','console/api/web/images/providers',{},None,None)
        for raw in [b'<svg/>',b'<html>error</html>',b'\x89PNG\r\n\x1a\n']:
            with self.assertRaises(Exception):images.verified_image(raw)
        for url in ['http://example.com','https://user:pass@example.com','https://example.com/?key=private']:
            with self.assertRaises(images.ImageError):images.endpoint(url)
        self.dns.stop()
        with patch.object(images.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
            with self.assertRaises(images.ImageError):images.endpoint('https://example.com')
        self.dns.start()

    def test_price_change_needs_new_confirmation(self):
        with self.assertRaises(images.ImageError) as e:self.svc.create('u',self.body(expected_cost=5))
        self.assertEqual(e.exception.status,409);self.assertEqual(self.balance(),100)

    def test_openai_wire_and_invalid_provider_payloads(self):
        raw=io.BytesIO();Image.new('RGB',(30,20),'red').save(raw,'PNG')
        response={'data':[{'b64_json':base64.b64encode(raw.getvalue()).decode()}]}
        class Opener:
            def open(_,req,**kwargs):
                payload=json.loads(req.data)
                self.assertEqual(payload['prompt'],'one apple');self.assertEqual(payload['model'],'private-model');self.assertEqual(payload['n'],1)
                self.assertEqual(req.full_url,'https://example.com/v1/images/generations')
                return io.BytesIO(json.dumps(response).encode())
        with patch.object(images,'build_opener',return_value=Opener()):
            data,mime=images.generate('one apple',{**self.provider,'size':'1024x1024'})
            self.assertEqual(mime,'image/jpeg');self.assertGreater(len(data),100)
            for invalid in [{'error':{'message':'busy'}},{'data':[]},{'data':[{'b64_json':'not image'}]}]:
                response=invalid
                with self.assertRaises(Exception):images.generate('one apple',{**self.provider,'size':'1024x1024'})

if __name__=='__main__':unittest.main()
