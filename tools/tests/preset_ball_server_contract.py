"""Exercise original backend methods on isolated SQLite; no module startup/accounts."""
import ast
import hashlib
import json
import re
import sqlite3
import sys
import textwrap
import threading
import unittest
from types import SimpleNamespace
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_preset_ball_server import adapt

source_path = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path('D:/网站/功能/AIXingYue-main/tools/ai_fengyue_local_server.py')
source = adapt(source_path.read_text(encoding='utf-8'))
tree = ast.parse(source)
functions = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
selected = {'_prompt_preset_public_entries', '_conversation_card_prompt_config', '_conversation_prompt_config',
    '_card_prompt_preset_id', 'apply_conversation_card_prompt_override', 'apply_conversation_global_preset_override', 'global_prompt_messages'}
todo = list(selected)
while todo:
    name = todo.pop()
    for call in ast.walk(functions[name]):
        if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in functions and call.func.id not in selected:
            selected.add(call.func.id); todo.append(call.func.id)
namespace = {'__name__': 'isolated_preset_contract', 'json': json, 're': re, 'hashlib': hashlib, 'Path': Path,
    'os': SimpleNamespace(environ={'REQUIRED_WORLD_BOOK_PATH': '__isolated_fixture_no_worldbook__.json'}, getenv=lambda name, default=None: default),
    'GLOBAL_PROMPT_MAX_ENTRIES': 240, 'now_ms': lambda: 1234567890, 'log': lambda *_: None}
for node in tree.body:
    if isinstance(node, ast.Assign):
        try: value = ast.literal_eval(node.value)
        except (ValueError, TypeError, SyntaxError): continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id.isupper(): namespace[target.id] = value
text = 'from __future__ import annotations\n' + '\n\n'.join(ast.get_source_segment(source, functions[n]) for n in sorted(selected))
exec(compile(text, str(source_path) + ':isolated-functions', 'exec'), namespace)
store_node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Store')
for name in ['save_conversation_preset_overrides', 'conversation_preset_override_map']:
    node = next(n for n in store_node.body if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile('from __future__ import annotations\n' + textwrap.dedent(ast.get_source_segment(source, node)), 'backend-method:' + name, 'exec'), namespace)

def preset(pid, kind='global'):
    return {'id': pid, 'name': 'Bound preset', 'enabled': True, 'blocks': [
        {'id': 'scene', 'name': 'Scene', 'content': 'AUTHORIZED_SCENE_BLOCK', 'enabled': True, 'user_toggleable': True},
        {'id': 'private', 'name': 'PRIVATE_NAME', 'content': 'PRIVATE_SOURCE_BLOCK', 'enabled': True, 'user_toggleable': False},
    ]}

class FixtureStore:
    save_conversation_preset_overrides = namespace['save_conversation_preset_overrides']
    conversation_preset_override_map = namespace['conversation_preset_override_map']
    def __init__(self):
        self.lock = threading.RLock(); self.conn = sqlite3.connect(':memory:'); self.conn.row_factory = sqlite3.Row
        self.conn.execute('create table conversation_preset_overrides(user_id text,conversation_id text,preset_kind text,preset_id text,entry_id text,enabled integer,updated_at integer,unique(user_id,conversation_id,preset_kind,preset_id,entry_id))')
        self.app = {'id': 'card', 'extra_settings': json.dumps({'card_prompt_preset': preset('creator')})}
    def get_conversation(self, cid, uid):
        return {'id': cid, 'version_id': 'version-1', 'app_id': 'card'} if uid == 'owner' and cid in {'a', 'b'} else None
    def conversation_runtime_card(self, cid, uid):
        conversation = self.get_conversation(cid, uid)
        return (conversation, dict(self.app)) if conversation else None
    def get_sillytavern_runtime_state(self, *_): return {'variables': {}}
    def public_model_selection(self, *_): return None
    def effective_llm_settings(self, *_, **__): return {'global_prompt_preset': preset('official')}

class ContractTests(unittest.TestCase):
    def setUp(self): self.store = FixtureStore()
    def test_metadata_is_public_and_creator_opt_in_required(self):
        config = namespace['_conversation_card_prompt_config'](self.store, 'a', 'owner')
        self.assertEqual(len(config['entries']), 1)
        self.assertNotIn('PRIVATE', json.dumps(config)); self.assertNotIn('content', json.dumps(config))
    def test_actual_store_save_is_scoped_and_rejects_private_or_wrong_account(self):
        config = namespace['_conversation_prompt_config'](self.store, 'a', 'owner')
        self.store.save_conversation_preset_overrides('a', 'owner', 'global_prompt', config['preset_id'], [{'entry_id': 'scene', 'enabled': False}])
        self.assertFalse(self.store.conversation_preset_override_map('a', 'owner')['global_prompt'][config['preset_id']]['scene'])
        self.assertEqual(self.store.conversation_preset_override_map('b', 'owner')['global_prompt'], {})
        with self.assertRaises(ValueError): self.store.save_conversation_preset_overrides('a', 'owner', 'global_prompt', config['preset_id'], [{'entry_id': 'private', 'enabled': False}])
        with self.assertRaises(PermissionError): self.store.save_conversation_preset_overrides('a', 'another-user', 'global_prompt', config['preset_id'], [{'entry_id': 'scene', 'enabled': False}])
    def test_actual_generation_blocks_follow_acknowledged_global_override(self):
        self.store.save_conversation_preset_overrides('a', 'owner', 'global_prompt', 'official', [{'entry_id': 'scene', 'enabled': False}])
        context = {'conversation_settings': {'preset_overrides': self.store.conversation_preset_override_map('a', 'owner')}}
        adjusted = namespace['apply_conversation_global_preset_override']({'global_prompt_preset': preset('official')}, context)
        rendered = namespace['global_prompt_messages'](adjusted['global_prompt_preset'], 'system_before')
        self.assertNotIn('AUTHORIZED_SCENE_BLOCK', json.dumps(rendered)); self.assertIn('PRIVATE_SOURCE_BLOCK', json.dumps(rendered))
        default = namespace['global_prompt_messages'](preset('official'), 'system_before')
        self.assertIn('AUTHORIZED_SCENE_BLOCK', json.dumps(default))
    def test_creator_override_reaches_actual_card_generation_normalizer(self):
        config = namespace['_conversation_card_prompt_config'](self.store, 'a', 'owner')
        self.store.save_conversation_preset_overrides('a', 'owner', 'card_prompt', config['preset_id'], [{'entry_id': 'scene', 'enabled': False}])
        context = {'conversation_settings': {'version_id': 'version-1', 'preset_overrides': self.store.conversation_preset_override_map('a', 'owner')}}
        adjusted = namespace['apply_conversation_card_prompt_override'](preset('creator'), context)
        self.assertFalse(next(b for b in adjusted['blocks'] if b['id'] == 'scene')['enabled'])
    def test_metadata_source_patch_keeps_provider_and_account_functions_unchanged(self):
        self.assertIn('"card_prompt": card_prompt_config', source)
        self.assertIn('card_prompt_config.get("preset_id") and card_prompt_config.get("enabled")', source)

if __name__ == '__main__': unittest.main()
