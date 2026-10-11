"""Isolated SQLite contract tests. No account or provider/network access."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import threading
import types
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server-patches/creator-revenue-r366"))
import homer_revenue as revenue

# Exercise the exact cumulative generation settlement, with only the one hook
# authored in integration.patch. It is not an imitation settlement algorithm.
source = (ROOT / "server-patches/cumulative-r41/homer_generation.py").read_text(encoding="utf-8")
assert source.count("            deliver(spent)\n") == 1
source = source.replace("            deliver(spent)\n", "            revenue.settle_creator_revenue_locked(store, user_id, spent, event)\n            deliver(spent)\n")
generation = types.ModuleType("test_revenue_generation")
generation.__dict__["revenue"] = revenue
exec(compile(source, "cumulative-r41/homer_generation.py", "exec"), generation.__dict__)


class Store:
    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.conn.executescript("""
          create table users(id text primary key,points integer not null,reward_points integer not null);
          create table local_apps(id text primary key,owner_user_id text,name text);
          create table user_events(user_id text,event_type text,summary text,payload_json text,created_at integer);
          insert into users values('payer',1000,0),('author',1000,0),('other',1000,0);
          insert into local_apps values('card','author','合成测试卡'),('external',null,'上游卡');
        """)
        revenue.migrate_revenue_schema(self.conn)

    def resolve_local_app_id(self, value):
        return value

    def _spend_credit_points_locked(self, user_id, amount):
        row = self.conn.execute("select points from users where id=?", (user_id,)).fetchone()
        if not row or amount <= 0 or row[0] < amount:
            raise ValueError("余额不足")
        self.conn.execute("update users set points=points-? where id=?", (amount, user_id))
        return {"points_cost": amount, "points": row[0] - amount, "deducted": {"free": amount}, "balance": {"points": row[0] - amount}}

    def _add_credit_points_locked(self, user_id, amount, point_type):
        assert point_type == "reward"
        self.conn.execute("update users set points=points+?,reward_points=reward_points+? where id=?", (amount, amount, user_id))

    def points(self, user="author"):
        return self.conn.execute("select points from users where id=?", (user,)).fetchone()[0]

    def get_user_by_id(self, user):
        return self.conn.execute("select * from users where id=?", (user,)).fetchone()

    def credit_balance(self, row):
        return {"points": row["points"], "reward_points": row["reward_points"]}

    def settle(self, amount=1, request_id="generation-1", card="card", deliver=lambda charge: None):
        return generation.settle_delivered_generation(self, "payer", amount, {"app_id": card, "request_id": request_id}, deliver)


class CreatorRevenueTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()

    def tearDown(self):
        self.store.conn.close()

    def test_default_and_fractional_carry(self):
        for index in range(20):
            self.store.settle(request_id=f"generation-{index}")
        data = revenue.creator_earnings(self.store, "author")
        self.assertEqual(data["creator_points"], 7)
        self.assertEqual(self.store.points(), 1007)
        self.assertEqual(self.store.points("payer"), 980)
        self.assertEqual(data["cards"], [{"id": "card", "name": "合成测试卡", "points": 7}])

    def test_rate_change_is_not_retroactive(self):
        self.store.settle(10, "first")
        revenue.save_revenue_config(self.store, "admin", 5000)
        self.store.settle(3, "second")
        self.assertEqual(revenue.creator_earnings(self.store, "author")["creator_points"], 5)
        self.assertEqual([r[0] for r in self.store.conn.execute("select rate_bps from homer_creator_revenue_ledger order by rowid")], [3500, 5000])
        self.assertEqual(self.store.conn.execute("select count(*) from homer_creator_revenue_admin_log").fetchone()[0], 1)

    def test_credited_balance_and_ledger_rollback_with_delivery_failure(self):
        def fail(_):
            raise ConnectionError("synthetic delivery failure")
        with self.assertRaises(ConnectionError):
            self.store.settle(100, deliver=fail)
        self.assertEqual(self.store.points(), 1000)
        self.assertEqual(self.store.points("payer"), 1000)
        self.assertEqual(revenue.creator_earnings(self.store, "author")["creator_points"], 0)
        self.assertEqual(self.store.conn.execute("select count(*) from user_events").fetchone()[0], 0)

    def test_duplicate_hook_does_not_credit_twice(self):
        self.store.settle(100)
        self.store.conn.execute("begin immediate")
        result = revenue.settle_creator_revenue_locked(self.store, "payer", {"points_cost": 100}, {"app_id": "card", "request_id": "generation-1"})
        self.store.conn.commit()
        self.assertTrue(result["duplicate"])
        self.assertEqual(self.store.points(), 1035)

    def test_conflicting_id_rolls_back_entire_second_settlement(self):
        self.store.settle(100)
        with self.assertRaises(ValueError):
            self.store.settle(101)
        self.assertEqual(self.store.points("payer"), 900)
        self.assertEqual(self.store.points(), 1035)

    def test_external_card_has_no_invented_owner(self):
        self.store.settle(100, card="external")
        self.assertEqual(self.store.points(), 1000)
        self.assertEqual(revenue.creator_earnings(self.store, "author")["cards"], [])

    def test_owner_not_body_recipient(self):
        self.store.conn.execute("begin immediate")
        revenue.settle_creator_revenue_locked(self.store, "payer", {"points_cost": 100}, {"app_id": "card", "request_id": "body-owner", "creator_id": "other", "rate_bps": 10000})
        self.store.conn.commit()
        self.assertEqual(self.store.points(), 1035)
        self.assertEqual(self.store.points("other"), 1000)

    def test_read_is_owner_scoped_and_does_not_count_other_rewards(self):
        self.store.settle(100)
        self.store.conn.execute("insert into user_events values('other','recharge','充值','{\"points\":500}',0)")
        self.store.conn.commit()
        self.assertEqual(revenue.creator_earnings(self.store, "other")["creator_points"], 0)
        self.assertIsNone(revenue.creator_earnings(self.store, "author")["invite_points"])

    def test_invalid_rate_is_rejected_without_changes(self):
        for rate in [-1, 10001, True, 0.5, "3500", None]:
            with self.assertRaises(ValueError):
                revenue.save_revenue_config(self.store, "admin", rate)
        self.assertEqual(revenue.revenue_config(self.store)["rate_bps"], 3500)

    def test_zero_rate_and_full_rate(self):
        revenue.save_revenue_config(self.store, "admin", 0)
        self.store.settle(100, "zero")
        revenue.save_revenue_config(self.store, "admin", 10000)
        self.store.settle(100, "full")
        self.assertEqual(self.store.points(), 1100)

    def test_author_playing_own_card_receipt_matches_actual_balance(self):
        self.store.conn.execute("update local_apps set owner_user_id='payer' where id='card'")
        self.store.conn.commit()
        receipt=self.store.settle(100)
        self.assertEqual(self.store.points("payer"),935)
        self.assertEqual(receipt["points"],935)
        self.assertEqual(receipt["balance"]["points"],935)

    def test_migration_does_not_backfill(self):
        self.store.conn.execute("insert into user_events values('payer','sillytavern_chat_cost','旧消费','{\"app_id\":\"card\",\"points_spent\":100}',0)")
        self.store.conn.commit()
        revenue.migrate_revenue_schema(self.store.conn)
        self.assertEqual(self.store.points(), 1000)
        self.assertEqual(revenue.creator_earnings(self.store, "author")["creator_points"], 0)

    def test_routes_use_current_token_role_not_request_body(self):
        ok = lambda data: {"data": data}
        error = lambda text, code: {"code": code, "message": text}
        user = {"id": "author", "is_admin": False}
        request = lambda method, path, token_user, body=None: revenue.revenue_route(self.store, method, path, user, token_user, body, ok, error)
        self.assertEqual(request("PUT", "admin/api/creator-revenue", user, {"rate_bps": 10000, "is_admin": True})["code"], 403)
        self.assertEqual(request("POST", "console/api/web/earnings", user)["code"], 405)
        self.assertEqual(request("PUT", "admin/api/creator-revenue", {"id": "admin", "is_admin": True}, {"rate_bps": 5000})["data"]["rate_bps"], 5000)
        self.assertEqual(request("GET", "console/api/web/earnings", user)["data"]["creator_points"], 0)


if __name__ == "__main__":
    unittest.main()
