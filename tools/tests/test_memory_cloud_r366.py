"""Real SQLite with exact reviewed provider legacy methods and route excerpt.
Synthetic data only; no server deployment, accounts or original databases.
"""
from __future__ import annotations
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'server-patches/memory-cloud-r366/homer_memory_storage.py'
spec = importlib.util.spec_from_file_location('homer_memory_storage', HELPER)
storage = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = storage
spec.loader.exec_module(storage)
sys.path.insert(0, str(ROOT / 'tools'))
from export_r366_memory_server import transform_server

SOURCE = Path(os.environ.get('HOMER_R366_PROVIDER_SOURCE',
    str(ROOT / 'tools/tests/fixtures/r366/provider_runtime_baseline.py')))


def provider_class():
    source = SOURCE.read_text(encoding='utf-8')
    changed = transform_server(source)
    tree = ast.parse(changed)
    names = {'_runtime_json', '_get_sillytavern_runtime_state_legacy', '_save_sillytavern_runtime_state_legacy',
             'get_sillytavern_runtime_state', 'save_sillytavern_runtime_state'}
    methods = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name in names]
    assert len(methods) == len(names), 'Execute all actual provider storage methods'
    module = ast.Module(body=[ast.ClassDef(name='Provider', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[])
    ast.fix_missing_locations(module)
    env = {'json': json, 'ST_RUNTIME_JSON_LIMITS': {'extension_settings': 512000, 'variables': 512000,
           'worldbook_overrides': 2000000, 'regex_overrides': 256000, 'script_trees': 512000, 'mvu_state': 2000000},
           'now_ms': lambda: int(time.time() * 1000), 'read_runtime_state': storage.read_runtime_state,
           'write_runtime_state': storage.write_runtime_state}
    exec(compile(module, '<actual-r366-provider-storage>', 'exec'), env)
    return env['Provider'], changed


def envelope(scope, content='Synthetic village memory', change='a' * 32, base=storage.ZERO):
    body = json.dumps({'entries': {'0': {'uid': 0, 'stmemorybooks': True, 'content': content, 'disable': False}},
                      'homerMemory': {'version': 1, 'scope': json.dumps(scope, ensure_ascii=False, separators=(',', ':'))}},
                      ensure_ascii=False, separators=(',', ':'))
    return {'schema_version': 1, 'scope': scope, 'body': body, 'digest': hashlib.sha256(body.encode()).hexdigest(),
            'change_id': change, 'base_version': base}


class MemoryCloudTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.Provider, cls.transformed = provider_class()

    def setUp(self):
        self.store = self.Provider()
        self.store.lock = threading.RLock()
        self.store.conn = sqlite3.connect(':memory:')
        self.store.conn.row_factory = sqlite3.Row
        self.store.conn.execute('''create table sillytavern_runtime_states(
            user_id text, app_id text, conversation_id text, extension_settings_json text,
            worldbook_overrides_json text, regex_overrides_json text, script_trees_json text,
            mvu_state_json text, variables_json text, updated_at integer,
            primary key(user_id,app_id,conversation_id))''')
        self.scope = ['synthetic-owner', 'synthetic-card', 'synthetic-chat']

    def tearDown(self):
        self.store.conn.close()

    def save(self, memory=None, values=None, scope=None):
        variables = dict(values or {})
        if memory is not None:
            variables[storage.KEY] = memory
        return self.store.save_sillytavern_runtime_state(*(scope or self.scope), {'variables': variables})

    def read(self, scope=None):
        return self.store.get_sillytavern_runtime_state(*(scope or self.scope))

    def test_full_saved_memory_receipt_repeat_and_old_client_preservation(self):
        memory = envelope(self.scope)
        result = self.save(memory, {'homer_model_settings': {'model_id': 'synthetic'}})
        proof = result['memory_storage']
        self.assertEqual(proof['scope'], self.scope)
        self.assertEqual(proof['digest'], memory['digest'])
        self.assertNotEqual(proof['version'], storage.ZERO)
        repeated = self.save(memory)
        self.assertEqual(repeated['memory_storage'], proof)
        legacy = self.save(values={'old_client_model': 'changed'})
        self.assertEqual(legacy['memory_storage'], proof)
        self.assertEqual(legacy['variables']['old_client_model'], 'changed')
        self.assertEqual(legacy['variables'][storage.KEY]['body'], memory['body'])

    def test_stale_cas_rejected_then_phone_rebase_preserves_previous_cloud_body(self):
        initial = self.save(envelope(self.scope))
        version = initial['memory_storage']['version']
        update = envelope(self.scope, 'New synthetic memory', 'b' * 32)
        with self.assertRaises(storage.MemoryStorageError) as failure:
            self.save(update)
        self.assertEqual(failure.exception.status, 409)
        self.assertEqual(self.read()['memory_storage']['version'], version)
        update['base_version'] = version
        saved = self.save(update)
        self.assertNotEqual(saved['memory_storage']['version'], version)
        backup = self.store.conn.execute('select * from homer_memory_backups').fetchone()
        self.assertEqual(json.loads(backup['memory_json'])['body'], initial['variables'][storage.KEY]['body'])

    def test_explicit_empty_is_durable_clear_missing_is_not_clear(self):
        result = self.save(envelope(self.scope))
        empty = envelope(self.scope, change='b' * 32, base=result['memory_storage']['version'])
        book = json.loads(empty['body']); book['entries'] = {}
        empty['body'] = json.dumps(book, ensure_ascii=False, separators=(',', ':'))
        empty['digest'] = hashlib.sha256(empty['body'].encode()).hexdigest()
        saved = self.save(empty)
        self.assertEqual(json.loads(saved['variables'][storage.KEY]['body'])['entries'], {})
        self.assertEqual(self.save(values={})['memory_storage'], saved['memory_storage'])

    def test_wrong_owner_app_conversation_and_global_scopes_rejected(self):
        for scope in [['other-owner', *self.scope[1:]], [self.scope[0], 'other-card', self.scope[2]],
                      [*self.scope[:2], 'other-chat'], [self.scope[0], '', '']]:
            with self.assertRaises(storage.MemoryStorageError):
                self.save(envelope(self.scope), scope=scope)
        self.assertIsNone(self.read()['memory_storage']['digest'])

    def test_digest_corruption_reused_commit_and_oversize_never_change_saved_body(self):
        original = self.save(envelope(self.scope))
        version = original['memory_storage']['version']
        invalid = envelope(self.scope, 'Invalid body', 'b' * 32, version)
        invalid['digest'] = 'f' * 64
        reused = envelope(self.scope, 'Changed under same id', 'a' * 32, version)
        large = envelope(self.scope, '字' * 180000, 'c' * 32, version)
        for memory in [invalid, reused, large]:
            with self.assertRaises(ValueError):
                self.save(memory)
            self.assertEqual(self.read()['memory_storage']['version'], version)

    def test_private_memory_not_inherited_from_global_or_card_default(self):
        # Deliberate coarse-row pollution tests defensive GET; normal writes
        # already forbid putting a private envelope into a coarse scope.
        self.store._save_sillytavern_runtime_state_legacy(self.scope[0], self.scope[1], '',
            {'variables': {storage.KEY: envelope(self.scope), 'legacy_setting': True}})
        result = self.read()
        self.assertNotIn(storage.KEY, result['variables'])
        self.assertTrue(result['variables']['legacy_setting'])
        self.assertEqual(result['memory_storage']['version'], storage.ZERO)

    def test_authenticated_route_checks_remain_and_conflicts_are_409(self):
        self.assertIn('self.store.get_conversation(conv_id, token_user_id)', self.transformed)
        self.assertIn('conversation role mismatch", 409', self.transformed)
        self.assertIn('exc.status if isinstance(exc, MemoryStorageError) else 400', self.transformed)
        self.assertEqual(self.transformed.count('from homer_memory_storage import'), 1)

    def test_failed_legacy_write_rolls_back_private_backup_and_preserves_original(self):
        original = self.save(envelope(self.scope))
        version = original['memory_storage']['version']
        legacy = self.store._save_sillytavern_runtime_state_legacy
        self.store._save_sillytavern_runtime_state_legacy = lambda *args: (_ for _ in ()).throw(RuntimeError('Synthetic write failure'))
        with self.assertRaisesRegex(RuntimeError, 'Synthetic write failure'):
            self.save(envelope(self.scope, 'Never acknowledged', 'b' * 32, version))
        self.store._save_sillytavern_runtime_state_legacy = legacy
        self.assertEqual(self.read()['memory_storage']['version'], version)
        self.assertFalse(self.store.conn.in_transaction)
        if self.store.conn.execute("select name from sqlite_master where name='homer_memory_backups'").fetchone():
            self.assertEqual(self.store.conn.execute('select count(*) from homer_memory_backups').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
