import ast,copy,importlib.util,json,sqlite3,threading,time,unittest
from pathlib import Path
from build_creator_earnings_patch import transform,SOURCE
MODULE=Path(__file__).resolve().parents[1]/'server-patches/creator-earnings/creator_earnings.py'
spec=importlib.util.spec_from_file_location('creator_earnings',MODULE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Store(module.CreatorEarningsMixin):
 def __init__(self):
  self.conn=sqlite3.connect(':memory:',check_same_thread=False);self.conn.row_factory=sqlite3.Row;self.lock=threading.RLock()
  self.conn.executescript('CREATE TABLE users(id TEXT PRIMARY KEY,points INTEGER);CREATE TABLE local_apps(id TEXT PRIMARY KEY,owner_user_id TEXT,name TEXT);CREATE TABLE api_settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE user_events(id INTEGER PRIMARY KEY,user_id TEXT,event_type TEXT,summary TEXT,payload_json TEXT,created_at INTEGER);INSERT INTO users VALUES("player",1000),("author",0),("other",0);INSERT INTO local_apps VALUES("card","author","测试卡");')
  self.init_creator_earnings_schema()
 def get_user_by_id(self,id):return self.conn.execute('SELECT * FROM users WHERE id=?',(id,)).fetchone()
 def get_local_app(self,id):return self.conn.execute('SELECT * FROM local_apps WHERE id=?',(id,)).fetchone()
 def credit_balance(self,u):return {'points':u['points']}
 def _spend_credit_points_locked(self,user,amount):
  if self.get_user_by_id(user)['points']<amount:raise ValueError('insufficient')
  self.conn.execute('UPDATE users SET points=points-? WHERE id=?',(amount,user));return {'points_cost':amount,'points':self.get_user_by_id(user)['points'],'deducted':{'paid':amount}}
 def _add_credit_points_locked(self,user,amount,type):self.conn.execute('UPDATE users SET points=points+? WHERE id=?',(amount,user))
 def charge(self,n=100,id='reply'):return self.spend_with_creator_earnings('player',n,payload={'app_id':'card','message_id':id})
class Tests(unittest.TestCase):
 def setUp(self):self.s=Store()
 def tearDown(self):self.s.conn.close()
 def test_default_and_private_totals(self):
  self.s.charge();a=self.s.creator_earnings('author');self.assertEqual(a['creator_points'],35);self.assertEqual(self.s.get_user_by_id('author')['points'],35);self.assertEqual(self.s.creator_earnings('other')['cards'],[]);self.assertEqual(set(a['cards'][0]),{'app_id','name','points'})
 def test_fractional_carry(self):
  for i in range(100):self.s.charge(1,str(i))
  self.assertEqual(self.s.creator_earnings('author')['creator_points'],35)
 def test_duplicate_concurrent(self):
  errors=[]
  def run():
   try:self.s.charge()
   except Exception as e:errors.append(e)
  threads=[threading.Thread(target=run) for _ in range(8)]
  for t in threads:t.start()
  for t in threads:t.join()
  self.assertEqual(errors,[]);self.assertEqual(self.s.get_user_by_id('player')['points'],900);self.assertEqual(self.s.creator_earnings('author')['creator_points'],35)
 def test_future_rate_only(self):
  self.s.charge();self.s.update_creator_revenue_rate('admin',5000);self.s.charge(id='second');self.assertEqual(self.s.creator_earnings('author')['creator_points'],85)
  self.assertEqual(self.s.conn.execute("SELECT count(*) FROM user_events WHERE event_type='creator_rate_changed'").fetchone()[0],1)
 def test_invalid_rate(self):
  for value in [-1,10001,True,35.5,'3500',None]:
   with self.assertRaises(ValueError):self.s.update_creator_revenue_rate('admin',value)
 def test_failed_spend(self):
  with self.assertRaises(ValueError):self.s.charge(1001)
  self.assertEqual(self.s.creator_earnings('author')['creator_points'],0);self.assertEqual(self.s.get_user_by_id('player')['points'],1000)
 def test_share_failure_rolls_back_charge(self):
  self.s._add_credit_points_locked=lambda *a:(_ for _ in ()).throw(ValueError('failure'))
  with self.assertRaises(ValueError):self.s.charge()
  self.assertEqual(self.s.get_user_by_id('player')['points'],1000);self.assertEqual(self.s.conn.execute('SELECT count(*) FROM user_events').fetchone()[0],0)
 def test_no_creator_and_zero_rate(self):
  self.s.spend_with_creator_earnings('player',100,payload={'app_id':'unknown','message_id':'a'})
  self.s.update_creator_revenue_rate('admin',0);self.s.charge();self.assertEqual(self.s.creator_earnings('author')['creator_points'],0)
 def test_patch_guard_and_completion_keys(self):
  source=transform(SOURCE.read_text(encoding='utf-8-sig'))
  guard=source.index('if not is_admin(admin_user):');route=source.index('if normalized == "admin/api/creator-revenue":');self.assertLess(guard,route)
  self.assertIn('self.store.creator_earnings(earnings_user["id"])',source);self.assertEqual(source.count('"billing_id": completion_id'),2)

class RealCreditTests(unittest.TestCase):
 """Execute the existing server credit helpers, not approximations of them."""
 def setUp(self):
  self.s=Store()
  self.s.conn.executescript('ALTER TABLE users ADD COLUMN free_points INTEGER DEFAULT 0;ALTER TABLE users ADD COLUMN paid_points INTEGER DEFAULT 0;ALTER TABLE users ADD COLUMN reward_points INTEGER DEFAULT 0;ALTER TABLE users ADD COLUMN updated_at INTEGER DEFAULT 0;UPDATE users SET free_points=20,reward_points=30,paid_points=950 WHERE id="player";')
  tree=ast.parse(SOURCE.read_text(encoding='utf-8-sig'));store=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='Store')
  names={'credit_balance','_spend_credit_points_locked','_add_credit_points_locked'}
  ns={'sqlite3':sqlite3,'now_ms':lambda:int(time.time()*1000)}
  for n in store.body:
   if isinstance(n,ast.FunctionDef) and n.name in names:
    exec(compile(ast.Module(body=[n],type_ignores=[]),str(SOURCE),'exec'),ns)
    setattr(self.s,n.name,ns[n.name].__get__(self.s))
 def tearDown(self):self.s.conn.close()
 def test_real_split_and_reward_credit(self):
  result=self.s.charge();self.assertEqual(result['deducted'],{'free':20,'reward':30,'paid':50});self.assertEqual(result['points'],900)
  self.assertEqual(self.s.credit_balance(self.s.get_user_by_id('author'))['reward_points'],35)
 def test_self_play_actual_balance(self):
  self.s.conn.execute('UPDATE local_apps SET owner_user_id="player"');self.s.conn.commit()
  self.assertEqual(self.s.charge()['points'],935)
 def test_full_rate(self):
  self.s.update_creator_revenue_rate('admin',10000);self.s.charge();self.assertEqual(self.s.creator_earnings('author')['creator_points'],100)

class RouteTests(unittest.TestCase):
 """Run the patched route AST with the original admin guard in a request harness."""
 def setUp(self):
  self.s=Store();source=transform(SOURCE.read_text(encoding='utf-8-sig'));tree=ast.parse(source)
  statements=list(ast.walk(tree))
  userroute=next(n for n in statements if isinstance(n,ast.If) and ast.unparse(n.test)=='normalized == \'console/api/web/earnings\'')
  adminblock=next(n for n in statements if isinstance(n,ast.If) and ast.unparse(n.test)=='normalized.startswith(\'admin/api/\')')
  adminroute=next(n for n in adminblock.body if isinstance(n,ast.If) and ast.unparse(n.test)=='normalized == \'admin/api/creator-revenue\'')
  admin=copy.deepcopy(adminblock);admin.body=admin.body[:3]+[adminroute]
  wrapper=ast.parse('def dispatch(self,normalized,body):\n pass').body[0];wrapper.body=[userroute,admin]
  ns={'ok_response':lambda data:(200,data),'error_response':lambda text,status:(status,text),'is_admin':lambda u:bool(u and u.get('is_admin'))}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[wrapper],type_ignores=[])),'patched-routes','exec'),ns);self.dispatch=ns['dispatch']
 def tearDown(self):self.s.conn.close()
 def request(self,path,method,user,body=None):
  from types import SimpleNamespace
  return self.dispatch(SimpleNamespace(store=self.s,command=method,authenticated_token_user=lambda:user),path,body or {})
 def test_admin_guard_and_methods(self):
  path='admin/api/creator-revenue'
  for user in [None,{'id':'player','is_admin':False}]:
   for method in ['GET','PUT']:self.assertEqual(self.request(path,method,user,{'rate_bps':9000})[0],403)
  self.assertEqual(self.s.creator_revenue_rate()['rate_bps'],3500)
  admin={'id':'admin','is_admin':True}
  self.assertEqual(self.request(path,'PUT',admin,{'rate_bps':4050}),(200,{'rate_bps':4050}))
  self.assertEqual(self.request(path,'GET',admin),(200,{'rate_bps':4050}))
  self.assertEqual(self.request(path,'PUT',admin,{'rate_bps':10001})[0],400)
  self.assertEqual(self.request(path,'DELETE',admin)[0],405)
 def test_owner_is_from_auth_not_request(self):
  self.s.charge();path='console/api/web/earnings'
  self.assertEqual(self.request(path,'GET',None)[0],401)
  self.assertEqual(self.request(path,'POST',{'id':'author'})[0],405)
  self.assertEqual(self.request(path,'GET',{'id':'other'},{'owner_id':'author'})[1]['creator_points'],0)
  self.assertEqual(self.request(path,'GET',{'id':'author'})[1]['creator_points'],35)
if __name__=='__main__':unittest.main()
