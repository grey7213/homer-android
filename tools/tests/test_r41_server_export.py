"""Small DB/reference and patch-transform contracts; no accounts or services."""
from __future__ import annotations

from pathlib import Path
import sqlite3
import sys
import threading
import unittest
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from export_r41_server import (IMPORT_ANCHOR, MEMO_CONVERSION, NEW_RESOLVER,
                              OLD_RESOLVER, SESSION_CONVERSION, reverse_hunks,
                              transform_server)
from export_r29_delivery import apply_unified, diff


# Exact old get_local_app normalization/query semantics, isolated from server
# initialization. A LEFT JOIN supplies flags but cannot change the selected id.
REFERENCE_LOOKUP = '''    def get_local_app(self, app_id):
        with self.lock:
            clean = unquote(str(app_id or "").strip())
            if not clean:
                return None
            row = self.conn.execute(
                "select a.*,ra.has_opening,ra.has_world_info,ra.has_regex from local_apps a "
                "left join role_card_annotations ra on ra.app_id=a.id where a.id=?", (clean,),
            ).fetchone()
            if row:
                return row
            lookup = clean[1:] if clean.startswith("#") else clean
            if lookup.lower().startswith("id:"):
                lookup = lookup[3:].strip()
            if not lookup:
                return None
            return self.conn.execute(
                "select a.*,ra.has_opening,ra.has_world_info,ra.has_regex from local_apps a "
                "left join role_card_annotations ra on ra.app_id=a.id where a.display_id=?", (lookup,),
            ).fetchone()
'''


def store_class(resolver):
    namespace = {'unquote': unquote}
    exec('class Store:\n' + REFERENCE_LOOKUP + resolver, namespace)
    return namespace['Store']


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            create table local_apps(id text primary key,display_id text,extra_settings text);
            create unique index public_ids on local_apps(display_id) where display_id<>'';
            create table role_card_annotations(app_id text primary key,has_opening int,has_world_info int,has_regex int);
        ''')
        self.db.executemany('insert into local_apps values(?,?,?)', [
            ('card-a', '101', 'x' * (3 * 1024 * 1024)), ('101', '102', '{}'),
            ('中 文', '103', '{}'), ('literal%2Fid', '104', '{}'), ('literal/id', '105', '{}'),
            ('#106', '107', '{}'), ('plain', '106', '{}'),
        ])
        self.db.execute('insert into role_card_annotations values(?,?,?,?)', ('card-a', 1, 1, 1))
        self.original, self.optimized = store_class(OLD_RESOLVER)(), store_class(NEW_RESOLVER)()
        for store in [self.original, self.optimized]:
            store.conn, store.lock = self.db, threading.RLock()

    def test_alias_canonical_precedence_and_normalization_are_unchanged(self):
        for value in [None, '', ' ', 0, 101, 'card-a', '  card-a  ', '#101', 'id:101', '#ID: 101',
                      '101', '#106', '106', '中 文', '%E4%B8%AD%20%E6%96%87', 'literal%252Fid',
                      'literal%25252Fid', '%20card-a%20', 'id:', '#', 'unknown', '%252Fmissing',
                      "' OR 1=1--"]:
            with self.subTest(value=value):
                self.assertEqual(self.optimized.resolve_local_app_id(value),
                                 self.original.resolve_local_app_id(value))

    def test_resolution_reads_only_identifier_and_remains_a_fresh_read(self):
        queries = []
        self.db.set_trace_callback(queries.append)
        self.assertEqual(self.optimized.resolve_local_app_id('card-a'), 'card-a')
        self.assertEqual(self.optimized.resolve_local_app_id('#101'), 'card-a')
        self.assertTrue(all(query.lower().startswith('select id from local_apps ') for query in queries))
        self.assertFalse(any('extra_settings' in query or 'join' in query.lower() or '*' in query for query in queries))
        self.db.execute('update local_apps set display_id=? where id=?', ('201', 'card-a'))
        self.assertEqual(self.optimized.resolve_local_app_id('#101'), '#101')
        self.assertEqual(self.optimized.resolve_local_app_id('#201'), 'card-a')
        self.db.execute('delete from local_apps where id=?', ('card-a',))
        self.assertEqual(self.optimized.resolve_local_app_id('#201'), '#201')

    def test_nonempty_display_lookup_can_use_existing_partial_index(self):
        plan = self.db.execute("explain query plan select id from local_apps where display_id=? and display_id<>''", ('101',)).fetchall()
        self.assertTrue(any('public_ids' in row[3] and 'SEARCH' in row[3] for row in plan))


class PatchTests(unittest.TestCase):
    def test_reverse_patch_reconstructs_original_before_new_cumulative_export(self):
        original = 'alpha\nbeta\ngamma\n'
        changed = 'header\nalpha\nBETA\ngamma\nlast\n'
        patch = diff('tools/synthetic.py', original, changed)
        self.assertEqual(apply_unified(changed, reverse_hunks(patch)), original)

    def test_transform_is_exact_and_does_not_touch_admin_preview_or_other_code(self):
        admin = 'preview_card = silly_card_with_homer_cover(local_app_to_silly_card(app_data, card), "")\n'
        source = IMPORT_ANCHOR + 'class Store:\n' + OLD_RESOLVER + '\ndef request():\n    if True:\n        if True:\n' + SESSION_CONVERSION + '                "",\n            )\n' + admin
        result = transform_server(source)
        self.assertIn(admin, result)
        self.assertIn(MEMO_CONVERSION, result)
        self.assertIn(NEW_RESOLVER, result)
        self.assertEqual(result.count('from homer_session_cards import convert_session_card'), 1)
        with self.assertRaises(ValueError):
            transform_server(result)
        with self.assertRaises(ValueError):
            transform_server(source + OLD_RESOLVER)


if __name__ == '__main__':
    unittest.main()
