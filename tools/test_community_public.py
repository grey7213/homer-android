"""Public launch migration and authorization regression using isolated databases."""
import sqlite3,threading,unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server-extensions'))
from community_feed import ensure_feed_schema,handle_feed_route

class PublicLaunchTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.lock=threading.RLock()
    def tearDown(self):self.db.close()
    def boot(self,user=True):
        return handle_feed_route('GET','console/api/web/social/bootstrap',{}, {},dict(conn=self.db,lock=self.lock,user={'id':'ordinary','name':'普通用户'} if user else {},is_admin=False))
    def test_new_install_public_but_requires_consent_and_login(self):
        ensure_feed_schema(self.db,self.lock)
        data=self.boot()['data'];self.assertTrue(data['available']);self.assertEqual(data['mode'],'open');self.assertFalse(data['consented'])
        self.assertEqual(self.boot(False)['__http__'],401)
        result=handle_feed_route('GET','console/api/web/social/admin/stats',{}, {},dict(conn=self.db,lock=self.lock,user={'id':'ordinary'},is_admin=False))
        self.assertEqual(result['__http__'],403)
    def test_internal_upgrade_once(self):
        ensure_feed_schema(self.db,self.lock)
        self.db.execute("DELETE FROM social_config WHERE key='r8_public_launch'")
        self.db.execute("UPDATE social_config SET value='internal' WHERE key='mode'");self.db.commit()
        ensure_feed_schema(self.db,self.lock);self.assertEqual(self.boot()['data']['mode'],'open')
        self.db.execute("UPDATE social_config SET value='internal' WHERE key='mode'");self.db.commit()
        ensure_feed_schema(self.db,self.lock);self.assertFalse(self.boot()['data']['available'])
    def test_emergency_closure_survives_upgrade(self):
        ensure_feed_schema(self.db,self.lock)
        self.db.execute("DELETE FROM social_config WHERE key='r8_public_launch'")
        self.db.execute("UPDATE social_config SET value='closed' WHERE key='mode'");self.db.commit()
        ensure_feed_schema(self.db,self.lock);self.assertFalse(self.boot()['data']['available'])

if __name__=='__main__':unittest.main()
