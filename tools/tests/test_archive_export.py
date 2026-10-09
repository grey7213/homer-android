"""Synthetic provider transformation and exact distributed artifact parity."""
import ast
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools'))
from export_archive_server import transform_server

SOURCE='''import json
class Handler:
    def route(self, normalized, body, query):
        if normalized in (
            "console/api/web/dialogue/runtime-state",
        ):
            return "existing_route_unchanged"
'''

class Tests(unittest.TestCase):
    def test_route_is_additive_and_authenticated(self):
        result=transform_server(SOURCE);ast.parse(result)
        self.assertIn('return "existing_route_unchanged"',result)
        self.assertLess(result.index('if not token_user:'),result.index('owner = str(token_user["id"])'))
        self.assertIn('read_games(self.store, owner',result)
        self.assertIn('write_game(self.store, owner, body)',result)
        self.assertNotIn('body["user_id"]',result)
    def test_boundary_change_or_duplicate_patch_fails_closed(self):
        for source in [SOURCE.replace('import json','import missing'),SOURCE.replace('dialogue/runtime-state','changed'),SOURCE+SOURCE,transform_server(SOURCE)]:
            with self.assertRaises(ValueError):transform_server(source)
    def test_ordered_chat_storage_then_archive_preserves_both_routes(self):
        from test_r354_export import FIXTURE
        from export_r354_server import transform_server as transform_chat_storage
        hook='''
    def runtime_route(self, normalized, body, query):
        if normalized in (
            "console/api/web/dialogue/runtime-state",
        ):
            return "existing_route_unchanged"
'''
        result=transform_server(transform_chat_storage(FIXTURE+hook));ast.parse(result)
        self.assertIn('from homer_chat_storage import',result)
        self.assertIn('from homer_archive_storage import',result)
        self.assertIn('write_game(self.store, owner, body)',result)
        self.assertIn('storage_commit_id',result)
        self.assertNotIn('limit=500',result)
        archive=json.loads((ROOT/'server-patches/archive-r361/manifest.json').read_text())
        chat=json.loads((ROOT/'server-patches/chat-storage-r354-v2/manifest.json').read_text())
        self.assertTrue(archive['requires_chat_storage_v2'])
        self.assertEqual(archive['source_sha256_lf'],chat['result_sha256_lf'])
    def test_distributed_module_has_exact_hash(self):
        folder=ROOT/'server-patches/archive-r361'
        source=(ROOT/'tools/server/homer_archive_storage.py').read_bytes()
        self.assertEqual((folder/'homer_archive_storage.py').read_bytes(),source)
        manifest=json.loads((folder/'manifest.json').read_text())
        self.assertEqual(hashlib.sha256(source).hexdigest(),manifest['module_sha256'])

if __name__=='__main__':unittest.main()
