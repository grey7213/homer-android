"""Synthetic isolated SQLite tests. Never opens a user's real database."""
import json
from pathlib import Path
import sqlite3
import sys
import threading
import unittest
import uuid

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/server'))
from homer_chat_storage import read_chat, write_chat, ChatStorageError


class Store:
    def __init__(self,count=12):
        self.lock=threading.RLock()
        self.conn=sqlite3.connect(':memory:')
        self.conn.row_factory=sqlite3.Row
        self.conn.executescript('''CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT,app_id TEXT,app_name TEXT,app_icon TEXT,title TEXT,last_message TEXT,created_at INTEGER,updated_at INTEGER);
          CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,user_id TEXT,role TEXT,content TEXT,created_at INTEGER,swipes TEXT,swipe_index INTEGER);''')
        self.conn.execute('INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?,?)',('conv','owner','card','','','Test','',1,1))
        for i in range(count): self.conn.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),'conv','owner','assistant',f'fixture-{i}',i+1,None,0))
        self.conn.commit()


class StorageTests(unittest.TestCase):
    def setUp(self): self.store=Store()
    def tearDown(self): self.store.conn.close()
    def read(self,**kw): return read_chat(self.store,'owner','card','conv',**kw)
    def save(self,rows,version,commit='fixture-save',**kw):
        return write_chat(self.store,'owner','card','conv',rows,title='Test',version=version,commit_id=commit,**kw)
    def assertCode(self,code,fn):
        with self.assertRaises(ChatStorageError) as cm: fn()
        self.assertEqual(cm.exception.code,code)

    def test_stale_device_cannot_replace_new_progress(self):
        before=self.read(); newer=before['messages']+[dict(id=str(uuid.uuid4()),role='user',content='new',created_at=999,swipes=[],swipe_index=0)]
        saved=self.save(newer,before['storage']['version'])
        self.assertCode('HM-S409',lambda:self.save(before['messages'][:8],before['storage']['version'],'stale'))
        self.assertEqual(self.read()['messages'],saved['messages'])

    def test_legacy_partial_and_empty_writes_fail_closed(self):
        before=self.read()
        for rows in (before['messages'][:8],[]):
            self.assertCode('HM-S428',lambda:self.save(rows,''))
        self.assertEqual(self.read()['messages'],before['messages'])

    def test_identical_legacy_ack_is_read_only(self):
        before=self.read(); ack=self.save(before['messages'],'',commit='')
        self.assertEqual(ack['storage']['version'],before['storage']['version'])
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM homer_chat_backups').fetchone()[0],0)

    def test_full_histories_501_and_1101_survive_reopen_and_save(self):
        for count in (501,1101):
            store=Store(count)
            try:
                before=read_chat(store,'owner','card','conv')
                self.assertEqual(len(before['messages']),count)
                rows=before['messages']; rows[-1]['content']='edited'
                ack=write_chat(store,'owner','card','conv',rows,version=before['storage']['version'],commit_id='long-save')
                self.assertEqual(len(ack['messages']),count)
                self.assertEqual(len(read_chat(store,'owner','card','conv')['messages']),count)
            finally: store.conn.close()

    def test_conditional_read_omits_only_proven_unchanged_full_version(self):
        first=self.read(); cached=self.read(client_version=first['storage']['version'])
        self.assertEqual(cached['messages'],[])
        self.assertTrue(cached['storage']['unchanged'])
        self.assertEqual(cached['storage']['message_count'],12)
        self.store.conn.execute("UPDATE messages SET content='different' WHERE rowid=1")
        self.store.conn.commit()
        self.assertEqual(len(self.read(client_version=first['storage']['version'])['messages']),12)

    def test_every_external_mutation_changes_version(self):
        for query in ("UPDATE messages SET content='edit' WHERE rowid=1", "DELETE FROM messages WHERE rowid=2"):
            version=self.read()['storage']['version']
            self.store.conn.execute(query);self.store.conn.commit()
            self.assertNotEqual(self.read()['storage']['version'],version)
        version=self.read()['storage']['version']
        self.store.conn.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)',(str(uuid.uuid4()),'conv','owner','user','insert',100,None,0));self.store.conn.commit()
        self.assertNotEqual(self.read()['storage']['version'],version)

    def test_lost_ack_retry_idempotent_not_a_second_rewrite(self):
        first=self.read(); rows=first['messages'][:8]
        one=self.save(rows,first['storage']['version']); two=self.save(rows,first['storage']['version'])
        self.assertEqual(one,two)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM homer_chat_backups').fetchone()[0],1)

    def test_same_commit_id_changed_body_rejected(self):
        first=self.read(); rows=first['messages'][:8]; self.save(rows,first['storage']['version'])
        self.assertCode('HM-S409',lambda:self.save(rows[:5],first['storage']['version']))
        self.assertEqual(len(self.read()['messages']),8)

    def test_lost_ack_after_other_device_write_does_not_restore_old_cloud(self):
        first=self.read(); rows=first['messages'][:8]; one=self.save(rows,first['storage']['version'])
        changed=one['messages'][:7]; self.save(changed,one['storage']['version'],'other-device')
        self.assertCode('HM-S409',lambda:self.save(rows,first['storage']['version']))
        self.assertEqual(len(self.read()['messages']),7)

    def test_fork_keeps_both_progresses_and_retry_has_same_id(self):
        first=self.read(); rows=first['messages'][:8]
        fork=self.save(rows,'',fork=True); retry=self.save(rows,'',fork=True)
        self.assertEqual(fork,retry)
        self.assertNotEqual(fork['conversation_id'],'conv')
        self.assertEqual(self.read()['messages'],first['messages'])
        self.assertEqual(len(read_chat(self.store,'owner','card',fork['conversation_id'])['messages']),8)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM conversations').fetchone()[0],2)

    def test_write_failure_rolls_back_messages_token_backup_and_receipt(self):
        first=self.read(); rows=json.loads(json.dumps(first['messages'][:8])); rows[0]['content']='FAIL'
        self.store.conn.execute("CREATE TRIGGER fail_fixture BEFORE INSERT ON messages WHEN NEW.content='FAIL' BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.save(rows,first['storage']['version'])
        self.assertEqual(self.read(),first)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM homer_chat_backups').fetchone()[0],0)
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM homer_chat_commits').fetchone()[0],0)

    def test_owner_role_and_nonexistent_source_isolation(self):
        for owner,app,conv in [('other','card','conv'),('owner','wrong','conv'),('owner','card','missing')]:
            with self.assertRaises(ChatStorageError): read_chat(self.store,owner,app,conv)
            with self.assertRaises(ChatStorageError): write_chat(self.store,owner,app,conv,[],fork=True,commit_id='isolated')
        self.assertEqual(self.store.conn.execute('SELECT COUNT(*) FROM conversations').fetchone()[0],1)

    def test_duplicate_ids_do_not_silently_drop_rows(self):
        first=self.read(); rows=first['messages']+[first['messages'][0]]
        self.assertCode('HM-S400',lambda:self.save(rows,first['storage']['version']))
        self.assertEqual(self.read(),first)

    def test_backup_preserves_previous_body_and_is_bounded(self):
        first=self.read()
        for i in range(12):
            current=self.read(); rows=current['messages']; rows[0]['content']=f'changed-{i}'
            self.save(rows,current['storage']['version'],f'change-{i}')
        backups=self.store.conn.execute('SELECT * FROM homer_chat_backups ORDER BY created_at,rowid').fetchall()
        self.assertEqual(len(backups),10)
        self.assertEqual(json.loads(backups[-1]['messages_json'])[0]['content'],'changed-10')

    def test_storage_response_uses_canonical_contract(self):
        schema=json.loads((ROOT/'contracts/chat-storage-v2.schema.json').read_text())
        value=self.read()['storage']
        self.assertEqual(set(value),set(schema['properties']))
        self.assertTrue(set(schema['required']).issubset(value))
        self.assertEqual(value['protocol'],schema['properties']['protocol']['const'])
        self.assertRegex(value['version'],schema['properties']['version']['pattern'])
        self.assertEqual(value['complete'],schema['properties']['complete']['const'])
        self.assertGreaterEqual(value['message_count'],0)


if __name__=='__main__': unittest.main()
