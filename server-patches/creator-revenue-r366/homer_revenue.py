"""Creator point revenue. Call settlement inside the existing charge transaction.

No historical backfill, recharge inference, cash withdrawal or provider calls.
The server owns creator identity, consumed points and the configured rate.
"""
import json
import time

REVENUE_ROUTES = frozenset({"console/api/web/earnings", "admin/api/creator-revenue"})
MAX_SAFE_POINTS = 9_007_199_254_740_991


def _timestamp():
    return int(time.time() * 1000)


def validate_rate(value):
    if type(value) is not int or not 0 <= value <= 10000:
        raise ValueError("收益比例须为 0–10000 的整数基点")
    return value


def migrate_revenue_schema(conn):
    """Startup only, after Store.init_schema; never during a payment transaction."""
    if conn.in_transaction:
        raise RuntimeError("收益迁移必须在结算事务之外执行")
    conn.executescript("""
        create table if not exists homer_creator_revenue_config (
            singleton integer primary key check(singleton=1),
            rate_bps integer not null check(rate_bps between 0 and 10000),
            updated_at integer not null, updated_by text not null
        );
        insert or ignore into homer_creator_revenue_config values(1,3500,0,'');
        create table if not exists homer_creator_revenue_totals (
            creator_id text not null, app_id text not null, card_name text not null,
            points integer not null default 0 check(points>=0),
            remainder_bps integer not null default 0 check(remainder_bps between 0 and 9999),
            updated_at integer not null,
            primary key(creator_id,app_id)
        );
        create table if not exists homer_creator_revenue_ledger (
            request_id text primary key, creator_id text not null, app_id text not null,
            payer_id text not null, consumed_points integer not null check(consumed_points>0),
            rate_bps integer not null check(rate_bps between 0 and 10000),
            points integer not null check(points>=0), created_at integer not null
        );
        create index if not exists idx_homer_creator_revenue_owner
            on homer_creator_revenue_ledger(creator_id,created_at);
        create table if not exists homer_creator_revenue_admin_log (
            id integer primary key autoincrement, admin_id text not null,
            previous_rate_bps integer not null, rate_bps integer not null,
            created_at integer not null
        );
    """)
    conn.commit()


def revenue_config(store):
    with store.lock:
        row = store.conn.execute("select rate_bps,updated_at from homer_creator_revenue_config where singleton=1").fetchone()
        if not row:
            raise RuntimeError("收益配置尚未初始化")
        return {"rate_bps": int(row[0]), "updated_at": int(row[1]), "unit": "积分"}


def save_revenue_config(store, admin_id, rate_bps):
    rate_bps = validate_rate(rate_bps)
    if not str(admin_id or "").strip():
        raise PermissionError("管理员身份无效")
    with store.lock:
        try:
            store.conn.execute("begin immediate")
            previous = revenue_config(store)["rate_bps"]
            ts = _timestamp()
            store.conn.execute("update homer_creator_revenue_config set rate_bps=?,updated_at=?,updated_by=? where singleton=1", (rate_bps, ts, admin_id))
            store.conn.execute("insert into homer_creator_revenue_admin_log(admin_id,previous_rate_bps,rate_bps,created_at) values(?,?,?,?)", (admin_id, previous, rate_bps, ts))
            store.conn.commit()
            return {"rate_bps": rate_bps, "updated_at": ts, "unit": "积分"}
        except BaseException:
            store.conn.rollback()
            raise


def settle_creator_revenue_locked(store, payer_id, spent, payload):
    """Do not commit. Charge, credit, ledger and delivery share one rollback boundary.

    The caller supplies the actual spent.points_cost, not an amount from a client.
    Requests without an owned local card produce no creator payout. A duplicate
    request ID cannot issue a second payout. Fractional point remainders accumulate
    per creator/card; changing the rate does not reprice already consumed points.
    """
    if not store.conn.in_transaction:
        raise RuntimeError("分成必须与实际扣费处于同一事务")
    amount = spent.get("points_cost")
    if type(amount) is not int or not 0 < amount <= MAX_SAFE_POINTS:
        raise ValueError("实际消耗积分无效")
    app_id = str(payload.get("app_id") or "").strip()
    app_id = store.resolve_local_app_id(app_id) if app_id else ""
    row = store.conn.execute("select owner_user_id,name from local_apps where id=?", (app_id,)).fetchone()
    if not row or not str(row[0] or "").strip():
        return None
    creator_id, card_name = str(row[0]), str(row[1] or "未命名角色卡")[:200]
    if not store.conn.execute("select 1 from users where id=?", (creator_id,)).fetchone():
        return None
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id or len(request_id) > 160:
        raise ValueError("分成缺少有效生成请求标识")
    old = store.conn.execute("select creator_id,app_id,payer_id,consumed_points,rate_bps,points from homer_creator_revenue_ledger where request_id=?", (request_id,)).fetchone()
    if old:
        if (str(old[0]), str(old[1]), str(old[2]), int(old[3])) != (creator_id, app_id, str(payer_id), amount):
            raise ValueError("生成结算标识冲突")
        return {"points": int(old[5]), "duplicate": True}
    rate = revenue_config(store)["rate_bps"]
    total = store.conn.execute("select points,remainder_bps from homer_creator_revenue_totals where creator_id=? and app_id=?", (creator_id, app_id)).fetchone()
    old_points, remainder = (int(total[0]), int(total[1])) if total else (0, 0)
    issued, remainder = divmod(remainder + amount * rate, 10000)
    if old_points + issued > MAX_SAFE_POINTS:
        raise ValueError("累计收益超出积分范围")
    ts = _timestamp()
    store.conn.execute("insert into homer_creator_revenue_totals(creator_id,app_id,card_name,points,remainder_bps,updated_at) values(?,?,?,?,?,?) on conflict(creator_id,app_id) do update set card_name=excluded.card_name,points=excluded.points,remainder_bps=excluded.remainder_bps,updated_at=excluded.updated_at", (creator_id, app_id, card_name, old_points + issued, remainder, ts))
    store.conn.execute("insert into homer_creator_revenue_ledger(request_id,creator_id,app_id,payer_id,consumed_points,rate_bps,points,created_at) values(?,?,?,?,?,?,?,?)", (request_id, creator_id, app_id, str(payer_id), amount, rate, issued, ts))
    if issued:
        store._add_credit_points_locked(creator_id, issued, "reward")
        store.conn.execute("insert into user_events(user_id,event_type,summary,payload_json,created_at) values(?,?,?,?,?)", (creator_id, "creator_revenue", "角色卡积分收益", json.dumps({"app_id": app_id, "points": issued}, ensure_ascii=False), ts))
        if creator_id == str(payer_id):
            # A creator playing their own card receives real points in this same
            # transaction. The response must not overwrite the actual net balance
            # with the stale post-debit/pre-credit amount.
            balance = store.credit_balance(store.get_user_by_id(creator_id))
            spent.update(points=balance["points"], balance=balance)
    return {"points": issued, "duplicate": False}


def creator_earnings(store, user_id):
    with store.lock:
        rows = store.conn.execute("select app_id,card_name,points from homer_creator_revenue_totals where creator_id=? order by updated_at desc,app_id", (str(user_id),)).fetchall()
        cards = [{"id": str(row[0]), "name": str(row[1]), "points": int(row[2])} for row in rows]
        total = sum(card["points"] for card in cards)
        if total > MAX_SAFE_POINTS:
            raise ValueError("累计收益超出积分范围")
        # No invitation settlement exists in the current server. Do not count
        # recharge/farm/check-in as invitation income or fabricate a policy.
        return {"unit": "积分", "creator_points": total, "cards": cards,
                "invite_points": None, "invite_available": False}


def revenue_route(store, method, path, user, admin_user, body, ok, error):
    """Called only for REVENUE_ROUTES; reuse the host's authenticated token role."""
    if not user:
        return error("unauthorized", 401)
    if path == "console/api/web/earnings":
        return ok(creator_earnings(store, user["id"])) if method == "GET" else error("method not allowed", 405)
    # Do not trust a role supplied by the request body or by cached profile data.
    if not admin_user or not bool(admin_user["is_admin"]):
        return error("forbidden: admin only", 403)
    if method == "GET":
        return ok(revenue_config(store))
    if method == "PUT":
        if not isinstance(body, dict):
            return error("invalid request", 400)
        try:
            return ok(save_revenue_config(store, str(admin_user["id"]), body.get("rate_bps")))
        except ValueError:
            return error("收益比例无效，请输入 0–100 的百分比，最多两位小数", 400)
    return error("method not allowed", 405)
