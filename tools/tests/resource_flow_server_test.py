"""Actual SQLite contracts against the reviewed production-source transformation.

Only synthetic in-memory rows are used. No server, account, or user DB is opened.
"""
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from export_resource_flow_server import transform_workshop

SOURCE = Path(os.environ.get('HOMER_WORKSHOP_SOURCE',
    str(ROOT / 'tools/tests/fixtures/r366/community_workshop.py')))


class ResourceSoftDeletionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = SOURCE.read_text(encoding='utf-8-sig')
        cls.after = transform_workshop(cls.before)
        spec = importlib.util.spec_from_file_location('card_version_workshop', SOURCE.with_name('card_version_workshop.py'))
        versions = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(versions)
        sys.modules['card_version_workshop'] = versions
        cls.versions = versions
        cls.module = {'__name__': 'isolated_workshop_contract'}
        exec(compile(cls.after, str(SOURCE), 'exec'), cls.module)

    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.conn.executescript('create table local_apps(id text primary key); create table conversations(id text primary key);')
        self.versions.ensure_card_version_schema(self.conn, self.lock)
        self.module['ensure_community_schema'](self.conn, self.lock)
        self.store = self.module['CommunityStore'](self.conn, self.lock)

    def tearDown(self):
        self.conn.close()

    def route(self, path, method='GET', body=None, user='qa-owner', admin=False, query=None):
        return self.module['handle_community_route'](method, 'console/api/web/community/' + path,
            query or {}, body or {}, {'conn': self.conn, 'lock': self.lock,
                'user': {'id': user, 'name': 'Synthetic QA'}, 'is_admin': admin})

    def work(self, kind='preset', public=False):
        content = {'prompts': [{'identifier': 'qa', 'content': 'Synthetic prompt', 'enabled': True}]}
        if kind == 'mod': content = {'entries': [{'uid': 1, 'content': 'Synthetic entry', 'key': ['QA']}]}
        if kind == 'ui_template': content = {'regex_scripts': [{'findRegex': 'QA', 'replaceString': '<b>QA</b>'}]}
        result = self.route('works', 'POST', {'work_type': kind, 'name': 'QA-delete-' + kind,
            'content': content, 'is_public': public, 'is_open_source': True})
        self.assertEqual(result['code'], 0, result)
        return result['data']

    def test_original_bug_is_soft_deleted_mine_visibility(self):
        original = {'__name__': 'original_workshop_contract'}
        exec(compile(self.before, str(SOURCE), 'exec'), original)
        work = self.work()
        self.route('works/' + work['id'] + '/delete', 'POST')
        original_store = original['CommunityStore'](self.conn, self.lock)
        self.assertEqual([item['id'] for item in original_store.list_works('preset', 'mine', 'qa-owner')], [work['id']])
        self.assertTrue(original_store.can_view_work('qa-owner', original_store.get_work(work['id'])))

    def test_cancel_confirm_search_and_permissions_all_resource_types(self):
        for kind in ('preset', 'mod', 'ui_template'):
            work = self.work(kind)
            wid = work['id']
            # Cancel means no delete route is called; a reread remains visible.
            listed = self.route('works', query={'scope': 'mine', 'type': kind, 'q': 'QA-delete'})
            self.assertEqual([item['id'] for item in listed['data']['list']], [wid])
            denied = self.route('works/' + wid + '/delete', 'POST', user='qa-other')
            self.assertEqual(denied['code'], 403)
            self.assertEqual(self.store.get_work(wid)['status'], 'published')
            snapshot = self.versions.ContentVersionStore(self.conn, self.lock).snapshot(work['current_version_id'], kind, wid)
            result = self.route('works/' + wid + '/delete', 'POST')
            self.assertEqual(result['data'], {'deleted': True})
            self.assertEqual(self.route('works/' + wid + '/delete', 'POST')['data'], {'deleted': True})
            listed = self.route('works', query={'scope': 'mine', 'type': kind, 'q': 'QA-delete'})
            self.assertEqual(listed['data']['list'], [])
            self.assertEqual(self.store.get_work(wid)['status'], 'deleted')
            # Existing pinned immutable snapshots are preserved, never cascade-deleted.
            self.assertEqual(self.versions.ContentVersionStore(self.conn, self.lock).snapshot(work['current_version_id'], kind, wid), snapshot)

    def test_deleted_detail_versions_update_favorite_are_unavailable(self):
        work = self.work(public=True)
        wid = work['id']
        self.assertTrue(self.route('works/' + wid + '/favorite', 'POST', user='qa-other')['data']['favorited'])
        self.route('works/' + wid + '/delete', 'POST')
        for scope, owner in [('public', ''), ('mine', 'qa-owner'), ('favorites', 'qa-other')]:
            self.assertEqual(self.route('works', user=owner, query={'scope': scope})['data']['list'], [])
        for admin in (False, True):
            for suffix in ('', '/versions', '/versions/' + work['current_version_id']):
                self.assertEqual(self.route('works/' + wid + suffix, admin=admin)['code'], 404)
        update = self.route('works/' + wid + '/update', 'POST', {'version_name': 'v2', 'version_description': 'QA', 'status': 'published'})
        self.assertEqual(update['code'], 400)
        self.assertEqual(self.route('works/' + wid + '/favorite', 'POST')['code'], 400)
        self.assertEqual(self.store.get_work(wid)['status'], 'deleted')

    def test_transformation_refuses_drift_and_does_not_modify_source(self):
        with self.assertRaisesRegex(ValueError, 'boundary changed'):
            transform_workshop(self.before.replace('        where, args = [], []', '        where, args = list(), list()'))
        self.assertEqual(SOURCE.read_text(encoding='utf-8-sig'), self.before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
