"""Verify exact-boundary server handoff and distributed provider parity."""
import hashlib
import json
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools'))
from export_r354_server import transform_server

FIXTURE='''import json
class Store:
    def sync_sillytavern_chat(self, conv_id, user_id, app_id, messages, *, title=""):
        self.conn.execute("delete from messages where conversation_id=? and user_id=?")
        return {}
    def other_function(self):
        return "preserve unrelated behavior"
    def read_route(self):
            messages = self.store.list_messages(conversation_id, user_id, limit=500)
            return {
                "messages": messages,
                "runtime_config": runtime_config,
            }
    def save_route(self):
            try:
                result = self.store.sync_sillytavern_chat(
                    conv_id,user_id,app_id,body.get("messages"),
                    title=str(body.get("title") or ""),
                )
            except ValueError as exc:
                return error_response(str(exc), 400)
            self.store.log_event("fixture")
'''
class ExportTests(unittest.TestCase):
    def test_all_wires_and_unchanged_boundary(self):
        result=transform_server(FIXTURE);compile(result,'fixture','exec')
        for field in ('chat_version','storage_version','storage_commit_id','storage_fork','stored_chat["storage"]','except ChatStorageError'):
            self.assertIn(field,result)
        self.assertIn('return "preserve unrelated behavior"',result)
        self.assertNotIn('limit=500',result)
    def test_changed_or_duplicate_boundaries_rejected(self):
        for anchor in ('limit=500','import json','delete from messages where conversation_id=? and user_id=?','"runtime_config": runtime_config'):
            with self.assertRaises((ValueError,SyntaxError)):transform_server(FIXTURE.replace(anchor,'changed_boundary'))
        with self.assertRaises(ValueError):transform_server(FIXTURE+'\n'+FIXTURE)
    def test_distributed_module_and_hash_exact(self):
        folder=ROOT/'server-patches/chat-storage-r354-v2'
        original=(ROOT/'tools/server/homer_chat_storage.py').read_text(encoding='utf-8')
        packaged=(folder/'homer_chat_storage.py').read_text(encoding='utf-8')
        self.assertEqual(original,packaged)
        manifest=json.loads((folder/'manifest.json').read_text())
        self.assertEqual(hashlib.sha256((folder/'homer_chat_storage.py').read_bytes()).hexdigest(),manifest['module_sha256'])
        self.assertNotIn('limit=500',transform_server(FIXTURE))

if __name__=='__main__':unittest.main()
