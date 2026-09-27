"""Unit verification against the actual backend source; no login or live generation."""
import ast
import importlib.util
import os
from pathlib import Path
import sys
import unittest

SOURCE = Path(os.environ.get('HOMER_BACKEND_SOURCE', 'D:/网站/功能/AIXingYue-main/tools/ai_fengyue_local_server.py'))
sys.path.insert(0, str(SOURCE.parent))
from homer_generation import execute_prompt_regex, generation_error, display_regex

class GenerationTests(unittest.TestCase):
    def test_display_does_not_expose_private_rules(self):
        result = display_regex({'enabled': True, 'scripts': [
            {'id': 'secret', 'promptOnly': True, 'replaceString': 'private'},
            {'id': 'view', 'markdownOnly': True, 'findRegex': 'x'},
        ]})
        self.assertEqual([r['id'] for r in result['scripts']], ['view'])
        self.assertFalse(result['scripts'][0]['promptOnly'])

    def test_prompt_worker_executes_actual_javascript(self):
        result = execute_prompt_regex([{'role': 'user', 'content': 'a中文'}], {'enabled': True, 'scripts': [
            {'id': 'js', 'findRegex': '/(?<=a)\\p{L}+/gu', 'replaceString': 'ok', 'placement': [1]}
        ]})
        self.assertEqual(result[0]['content'], 'aok')

    def test_bad_rule_is_not_silent_success(self):
        with self.assertRaisesRegex(RuntimeError, 'HM-R422'):
            execute_prompt_regex([], {'enabled': True, 'scripts': [{'id': 'broken', 'findRegex': '['}]})

    def test_numbered_errors_are_sanitized(self):
        for status in (400, 401, 402, 403, 404, 409, 429, 502, 503, 504):
            error = generation_error(status, request_id='test')['error']
            self.assertTrue(error['code'].startswith('HM-G'))
            self.assertEqual(error['request_id'], 'test')

    def test_workspace_draft_is_ephemeral_and_bounded(self):
        import copy, json
        tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'admin_dialogue_configuration')
        class Store:
            def effective_llm_settings(self, *args, **kwargs):
                return {'global_prompt_preset': {'name': 'live'}, 'global_regex_preset': {'enabled': False}}
        scope = dict(json=json, normalize_full_prompt_preset=copy.deepcopy, normalize_full_regex_preset=copy.deepcopy,
            normalize_world_info=copy.deepcopy, app_extras=lambda app: app['extra_settings'],
            execute_prompt_regex=execute_prompt_regex, display_regex=display_regex)
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), 'exec'), scope)
        app = {'extra_settings': {'world_info': [{'content': 'original'}]}}
        draft = {'prompt': {'name': 'draft'}, 'worldbook': [{'content': 'temporary'}]}
        result = scope[node.name](Store(), app, 'u', draft)
        self.assertEqual(result['prompt']['name'], 'draft')
        self.assertEqual(app['extra_settings']['world_info'][0]['content'], 'original')
        self.assertEqual(scope[node.name](Store(), app, 'u')['prompt']['name'], 'live')
        with self.assertRaises(ValueError): scope[node.name](Store(), app, 'u', {'prompt': {'content': 'a'*2_000_001}})
        with self.assertRaises(ValueError): scope[node.name](Store(), app, 'u', {'mod_ids': ['x']*31})

    def test_exact_truncated_status_rule_repair(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'normalize_full_regex_script')
        scope = {'REGEX_REPLACE_MAX_CHARS': 240000, 'REGEX_REPLACE_MAX_BYTES': 8 * 1024 * 1024,
                 '_preset_bool': lambda x, default: default if x is None else bool(x)}
        validator = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'checked_regex_replacement'), None)
        if validator:
            exec(compile(ast.Module(body=[validator], type_ignores=[]), str(SOURCE), 'exec'), scope)
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), 'exec'), scope)
        raw = {'scriptName': '去生理状态栏美化', 'findRegex': '/(<status_profile name="[^"]+">[\\s\\S]*?<\\/', 'replaceString': '', 'placement': [2]}
        fixed = scope['normalize_full_regex_script'](raw)
        result = execute_prompt_regex([{'role': 'assistant', 'content': 'before<status_profile name="状态">test</status_profile>after'}], {'enabled': True, 'scripts': [fixed]})
        self.assertEqual(result[0]['content'], 'beforeafter')
        unrelated = scope['normalize_full_regex_script'](dict(raw, scriptName='other'))
        self.assertEqual(unrelated['findRegex'], raw['findRegex'])

    def test_final_provider_payload_contains_transformed_history_once(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'prepare_sillytavern_bridge_generation')
        import homer_generation
        preset = {'enabled': True, 'id': 'r', 'scripts': [{'id': 'replace', 'findRegex': '/raw/g', 'replaceString': 'raw-fixed', 'placement': [1,2], 'promptOnly': True}]}
        class Store:
            def resolve_local_app_id(self, value): return value
            def get_user_by_id(self, value): return {'id': value, 'is_admin': True}
            def versioned_app_for_new_conversation(self, *a): return ({'id': 'card', 'name': 'card'}, None)
            def get_sillytavern_runtime_state(self, *a): return {}
            def public_model_selection(self, value): return value
            def effective_llm_settings(self, *a, **k): return {'global_regex_preset': preset}
            def get_persona(self, *a): return {'name': 'tester'}
        scope = dict(vars(homer_generation))
        scope.update(user_can_play_app=lambda *a: True, apply_sillytavern_runtime_state=lambda app, state: app,
                     normalize_sillytavern_openai_messages=lambda messages: messages,
                     normalize_model_pricing=lambda value: {}, estimate_payload_input_tokens=lambda value: 1,
                     is_admin=lambda user: user['is_admin'], app_extras=lambda app: {},
                     admin_dialogue_configuration=lambda *a: {'prompt': {}, 'regex': preset, 'worldbook': [], 'mod_worldbook': []})
        def build(app, content, history, settings, persona, context):
            self.assertFalse(settings['global_regex_preset']['enabled'])
            return {'enabled': True, 'protocol': 'openai', 'payload': {'messages': [{'role': 'system', 'content': 'official'}, {'role': 'user', 'content': content}]}}
        scope['build_user_llm_request'] = build
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), 'exec'), scope)
        result = scope[node.name](Store(), {'user_id': 'u', 'app_id': 'card', 'admin_preview': True}, {'messages': [{'role':'assistant','content':'raw'}, {'role':'user','content':'raw'}]})
        self.assertEqual([m['content'] for m in result['payload']['messages']], ['official', 'raw-fixed', 'raw-fixed'])
        with self.assertRaises(PermissionError):
            scope[node.name](Store(), {'user_id': 'u', 'app_id': 'card'}, {'homer_preview': {}})

if __name__ == '__main__': unittest.main()
