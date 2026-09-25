"""Host contract tests against staged source. No production DB or secrets used."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import textwrap
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
HOST = Path(os.environ.get('HOMER_TEST_HOST_SOURCE', 'D:/网站/功能/AIXingYue-main'))
sys.path[:0] = [str(ROOT / 'tools'), str(HOST / 'tools')]
from build_mobile_r25_server_patch import transform_model_catalog, transform_workshop


class PublicCatalogTests(unittest.TestCase):
    def test_groups_and_aliases_do_not_leak_provider_configuration(self):
        source = transform_model_catalog((HOST / 'tools/ai_fengyue_local_server.py').read_text(encoding='utf-8-sig'))
        tree = ast.parse(source)
        node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'public_model_presets')
        scope = dict(split_model_names=lambda s: s.split(','), model_config_for_preset=lambda p, m: p['model_configs'][m], normalize_model_pricing=lambda p: p or {}, model_charge_points=lambda p: 0, model_price_label=lambda p: '', model_selection_id=lambda p, m: p + '::' + m)
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<public catalog>', 'exec'), scope)
        presets = [{'id': f'p{i}', 'name': group, 'enabled': True, 'model': 'provider-model', 'model_configs': {'provider-model': {'display_name': alias}}, 'api_key': 'DO-NOT-EXPOSE', 'base_url': 'private-provider'} for i, (group, alias) in enumerate([('日常', '轻语'), ('创作', '星河'), ('高级', '皓月')])]
        host = type('Host', (), {'llm_presets': lambda self, include_secrets: (presets, 'p1')})()
        result = scope['public_model_presets'](host)
        self.assertEqual([m['group_name'] for m in result['list']], ['日常', '创作', '高级'])
        self.assertEqual([m['name'] for m in result['list']], ['轻语', '星河', '皓月'])
        self.assertEqual(result['default_id'], 'p1')
        self.assertNotIn('DO-NOT-EXPOSE', json.dumps(result))
        self.assertNotIn('private-provider', json.dumps(result))


class WorkshopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = transform_workshop((HOST / 'tools/community_workshop.py').read_text(encoding='utf-8-sig'))
        cls.scope = {'__name__': 'r25_workshop_tests'}
        exec(compile(source, '<staged workshop>', 'exec'), cls.scope)

    def test_regex_large_native_html_and_malformed_payload(self):
        validate = self.scope['_validate_work_payload']
        validate('regex', {'regex_scripts': [{'findRegex': 'LOADING', 'replaceString': 'x' * 3_100_000}]})
        with self.assertRaises(ValueError): validate('regex', {'regex_scripts': [{'findRegex': 42}]})
        with self.assertRaises(ValueError): validate('regex', {'regex_scripts': []})
        with self.assertRaises(ValueError): validate('regex', {'regex_scripts': [{'findRegex': 'x', 'replaceString': 'x' * (9 * 1024 * 1024)}]})

    def test_closed_source_owner_and_other_user_boundaries(self):
        store = self.scope['CommunityStore'](sqlite3.connect(':memory:'), threading.RLock())
        row = {'id': 'resource', 'owner_user_id': 'creator', 'work_type': 'regex', 'is_public': 1, 'is_open_source': 0, 'status': 'published', 'content_json': json.dumps({'regex_scripts': [{'scriptName': '规则', 'findRegex': 'secret', 'replaceString': 'private'}]})}
        self.assertIn('content', store.public_work(row, 'creator', detail=True))
        self.assertNotIn('content', store.public_work(row, 'reader', detail=True))
        self.assertFalse(store.public_work(row, 'reader', detail=True)['is_owner'])
        self.assertTrue(store.can_view_work('reader', row))
        row['is_public'] = 0
        self.assertFalse(store.can_view_work('reader', row))
        self.assertTrue(store.can_view_work('creator', row))
        self.assertIn('content', store.public_work(row, 'admin', is_admin=True, detail=True))


if __name__ == '__main__': unittest.main()
