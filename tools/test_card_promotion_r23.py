"""Exercise the host's actual comment method with an isolated minimal database."""
import argparse,sqlite3,threading,sys
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--backend-root',type=Path,required=True);args=parser.parse_args()
sys.path.insert(0,str(args.backend_root/'tools'))
from ai_fengyue_local_server import Store
from community_feed import ensure_feed_schema
db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row;lock=threading.RLock();ensure_feed_schema(db,lock)
db.executescript('CREATE TABLE local_apps(id TEXT PRIMARY KEY); INSERT INTO local_apps VALUES ("card"); CREATE TABLE users(id TEXT,name TEXT); INSERT INTO users VALUES("new-user","测试用户"); CREATE TABLE app_comments(id TEXT,app_id TEXT,user_id TEXT,content TEXT,like_count INTEGER,created_at INTEGER,updated_at INTEGER);')
store=Store.__new__(Store);store.conn=db;store.lock=lock;store.resolve_local_app_id=lambda value:value;store.log_event=lambda *args:None
store.app_comment_payload=lambda row,user:dict(row)
comment=store.create_app_comment('new-user','card','无偿帮忙修卡，有问题私我。');assert comment['content'].startswith('无偿')
try:store.create_app_comment('new-user','card','有，无限制，无偿，私我')
except ValueError as e:assert '推广引流' in str(e)
else:raise AssertionError('Promotion accepted')
assert db.execute('SELECT count(*) FROM app_comments').fetchone()[0]==1
assert db.execute('SELECT count(*) FROM social_sanctions').fetchone()[0]==1
assert db.execute('SELECT count(*) FROM social_members WHERE user_id="new-user"').fetchone()[0]==1
try:store.create_app_comment('new-user','card','禁言后不能继续评论')
except ValueError as e:assert '禁言' in str(e)
else:raise AssertionError('Muted account commented')
db.close();print('Host card comment: ordinary speech, rejection, persisted sanction, moderator visibility and cross-request mute passed')
