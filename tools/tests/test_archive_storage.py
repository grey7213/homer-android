"""Synthetic, isolated SQLite tests. No user database, account or provider calls."""
import copy
import json
import sqlite3
import sys
import threading
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from homer_archive_storage import write_game, read_games, ArchiveStorageError


def bundle(owner="synthetic-owner", game_id="test-game"):
    game = dict(version=1, id=game_id, owner=owner, title="合成测试故事", player={"name": "测试玩家"},
                world={"scene": "测试书店", "summary": ""}, characters=[dict(id="person", appId="private-card", versionId="v1", name="测试人物", avatar="", conversationId="dedicated")],
                active=dict(characterId="person", channel="stage", eventId=""), events=[], turns=[], memories=[], revision=0, createdAt=10, updatedAt=10)
    checkpoint=dict(id="branch-one", label="分支", createdAt=10, revision=0, automatic=False, game=copy.deepcopy(game))
    return {"version": 1, "game": game, "checkpoints": [checkpoint]}


class Tests(unittest.TestCase):
    def setUp(self):
        self.store = type("Store", (), {})()
        self.store.lock = threading.RLock()
        self.store.conn = sqlite3.connect(":memory:")
        self.store.conn.row_factory = sqlite3.Row
        self.store.conn.execute("CREATE TABLE conversations(id TEXT,user_id TEXT,app_id TEXT)")
        self.store.conn.execute("INSERT INTO conversations VALUES('dedicated','synthetic-owner','private-card')")
        self.store.conn.commit()

    def tearDown(self):
        self.store.conn.close()

    def body(self, data=None, commit="commit-one", version=""):
        return dict(game_id="test-game", expected_version=version, commit_id=commit, bundle=data or bundle())

    def test_roundtrip_complete_branch_and_owner_isolation(self):
        saved = write_game(self.store, "synthetic-owner", self.body())
        restored = read_games(self.store, "synthetic-owner", "test-game")
        self.assertEqual(restored["bundle"], bundle())
        self.assertEqual(saved["version"], restored["version"])
        self.assertEqual(read_games(self.store, "other")["total"], 0)
        with self.assertRaises(ArchiveStorageError) as err:
            read_games(self.store, "other", "test-game")
        self.assertEqual(err.exception.status, 404)

    def test_lost_ack_exact_idempotency_and_old_receipt(self):
        body = self.body(); first = write_game(self.store, "synthetic-owner", body)
        duplicate = write_game(self.store, "synthetic-owner", copy.deepcopy(body))
        self.assertEqual(first["version"], duplicate["version"]); self.assertTrue(duplicate["duplicate"])
        newer = bundle(); newer["game"]["world"]["summary"] = "后来进度"; newer["game"]["revision"] = 1
        write_game(self.store, "synthetic-owner", self.body(newer, "commit-two", first["version"]))
        self.assertEqual(write_game(self.store, "synthetic-owner", body)["version"], first["version"])
        self.assertEqual(read_games(self.store, "synthetic-owner", "test-game")["bundle"], newer)
        with self.assertRaises(ArchiveStorageError):
            write_game(self.store, "synthetic-owner", self.body(newer, "commit-one", first["version"]))

    def test_conflicts_preserve_cloud_and_backup(self):
        first = write_game(self.store, "synthetic-owner", self.body())
        newer = bundle(); newer["game"]["world"]["summary"] = "新进度"
        with self.assertRaises(ArchiveStorageError) as err:
            write_game(self.store, "synthetic-owner", self.body(newer, "commit-stale"))
        self.assertEqual(err.exception.status, 409)
        write_game(self.store, "synthetic-owner", self.body(newer, "commit-next", first["version"]))
        old = self.store.conn.execute("SELECT bundle_json FROM homer_archive_backups").fetchone()
        self.assertEqual(json.loads(old[0]), bundle())

    def test_unknown_credentials_and_cross_owner_branches_rejected(self):
        for mutate in (lambda b: b["game"].update(credentials={}),
                       lambda b: b["checkpoints"][0]["game"].update(owner="other"),
                       lambda b: b["game"]["characters"][0].update(conversationId="someone-else"),
                       lambda b: b["game"]["characters"][0].update(avatar="https://example.invalid/p.png?token=private")):
            bad = bundle(); mutate(bad)
            with self.assertRaises(ArchiveStorageError):
                write_game(self.store, "synthetic-owner", self.body(bad))
        self.assertEqual(read_games(self.store, "synthetic-owner")["total"], 0)

    def test_failed_transaction_rolls_back_entire_game_and_receipt(self):
        from homer_archive_storage import ensure_schema
        ensure_schema(self.store.conn); self.store.conn.commit()
        self.store.conn.execute("CREATE TRIGGER synthetic_failure BEFORE INSERT ON homer_archive_commits BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            write_game(self.store, "synthetic-owner", self.body())
        self.assertEqual(read_games(self.store, "synthetic-owner")["total"], 0)
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM homer_archive_commits").fetchone()[0], 0)

    def test_no_false_ack_inside_an_uncommitted_outer_transaction(self):
        self.store.conn.execute("INSERT INTO conversations VALUES('pending','synthetic-owner','private-card')")
        with self.assertRaises(ArchiveStorageError) as err:
            write_game(self.store,"synthetic-owner",self.body())
        self.assertEqual(err.exception.status,503)
        self.assertTrue(self.store.conn.in_transaction)
        self.store.conn.rollback()
        self.assertEqual(read_games(self.store,"synthetic-owner")["total"],0)

    def test_acknowledged_game_and_receipt_survive_database_reopen(self):
        with tempfile.TemporaryDirectory(prefix="homer-archive-durable-") as directory:
            self.store.conn.close();path=Path(directory)/"synthetic.sqlite"
            self.store.conn=sqlite3.connect(path);self.store.conn.row_factory=sqlite3.Row
            self.store.conn.execute("CREATE TABLE conversations(id TEXT,user_id TEXT,app_id TEXT)")
            self.store.conn.execute("INSERT INTO conversations VALUES('dedicated','synthetic-owner','private-card')");self.store.conn.commit()
            saved=write_game(self.store,"synthetic-owner",self.body())
            self.store.conn.close();self.store.conn=sqlite3.connect(path);self.store.conn.row_factory=sqlite3.Row
            self.assertEqual(read_games(self.store,"synthetic-owner","test-game")["bundle"],bundle())
            self.assertEqual(write_game(self.store,"synthetic-owner",self.body())["version"],saved["version"])
            self.store.conn.close();self.store.conn=sqlite3.connect(":memory:")


if __name__ == "__main__":
    unittest.main()
