"""Creator points sharing. No cash conversion; caller owns authentication.

Mixin for the existing SQLite Store. All credit mutations share its transaction
and lock. No generation, billing or production connection is started here.
"""
import json
import time

class CreatorEarningsMixin:
    def init_creator_earnings_schema(self):
        with self.lock:
            for sql in (
                "CREATE TABLE IF NOT EXISTS creator_charge_receipts(event_key TEXT PRIMARY KEY, result_json TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS creator_card_earnings(owner_id TEXT NOT NULL, app_id TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, remainder_bps INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,app_id))",
                "CREATE TABLE IF NOT EXISTS creator_earning_events(charge_event_id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, app_id TEXT NOT NULL, rate_bps INTEGER NOT NULL, points INTEGER NOT NULL, created_at INTEGER NOT NULL)",
                "CREATE INDEX IF NOT EXISTS idx_creator_earning_owner ON creator_earning_events(owner_id,app_id)",
            ):
                self.conn.execute(sql)
            self.conn.commit()

    def creator_revenue_rate(self):
        with self.lock:
            row=self.conn.execute("SELECT value FROM api_settings WHERE key='creator_revenue_bps'").fetchone()
            return {"rate_bps":int(row[0]) if row else 3500}

    def update_creator_revenue_rate(self, actor_id, rate_bps):
        if type(rate_bps) is not int or not 0<=rate_bps<=10000:
            raise ValueError("收益比例须为 0%–100%，最多两位小数")
        ts=int(time.time()*1000)
        with self.lock:
            try:
                self.conn.execute('BEGIN IMMEDIATE')
                previous=self.creator_revenue_rate()['rate_bps']
                self.conn.execute("INSERT INTO api_settings(key,value,updated_at) VALUES('creator_revenue_bps',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",(str(rate_bps),ts))
                self.conn.execute("INSERT INTO user_events(user_id,event_type,summary,payload_json,created_at) VALUES(?,?,?,?,?)",(actor_id,'creator_rate_changed','修改创作积分收益比例',json.dumps({'before_bps':previous,'after_bps':rate_bps}),ts))
                self.conn.commit()
            except Exception:
                self.conn.rollback();raise
        return {"rate_bps":rate_bps}

    def spend_with_creator_earnings(self,user_id,amount,*,event_type='chat_cost',summary='聊天消耗',payload=None):
        info=dict(payload or {});stable=info.get('billing_id') or info.get('message_id')
        key=json.dumps([str(user_id),event_type,str(info.get('app_id') or ''),str(stable)],ensure_ascii=False) if stable else None
        with self.lock:
            try:
                self.conn.execute('BEGIN IMMEDIATE')
                if key:
                    existing=self.conn.execute('SELECT result_json FROM creator_charge_receipts WHERE event_key=?',(key,)).fetchone()
                    if existing:
                        self.conn.rollback();return json.loads(existing[0])
                spent=self._spend_credit_points_locked(user_id,amount)
                ts=int(time.time()*1000);info.update(points_spent=spent['points_cost'],deducted=spent['deducted'],points=spent['points'])
                cursor=self.conn.execute('INSERT INTO user_events(user_id,event_type,summary,payload_json,created_at) VALUES(?,?,?,?,?)',(user_id,event_type,summary,json.dumps(info,ensure_ascii=False),ts))
                app=self.get_local_app(str(info.get('app_id') or ''))
                owner=str(app['owner_user_id'] or '') if app else ''
                if owner and self.get_user_by_id(owner):
                    app_id=str(app['id']);bps=self.creator_revenue_rate()['rate_bps']
                    self.conn.execute('INSERT OR IGNORE INTO creator_card_earnings(owner_id,app_id) VALUES(?,?)',(owner,app_id))
                    old=self.conn.execute('SELECT remainder_bps FROM creator_card_earnings WHERE owner_id=? AND app_id=?',(owner,app_id)).fetchone()
                    points,remainder=divmod(int(spent['points_cost'])*bps+old[0],10000)
                    self.conn.execute('INSERT INTO creator_earning_events VALUES(?,?,?,?,?,?)',(cursor.lastrowid,owner,app_id,bps,points,ts))
                    self.conn.execute('UPDATE creator_card_earnings SET points=points+?,remainder_bps=? WHERE owner_id=? AND app_id=?',(points,remainder,owner,app_id))
                    if points:self._add_credit_points_locked(owner,points,'reward')
                # Self-play may credit the same account; return the actual balance.
                balance=self.credit_balance(self.get_user_by_id(user_id))
                result={**spent,'points':balance['points'],'balance':balance}
                if key:self.conn.execute('INSERT INTO creator_charge_receipts VALUES(?,?)',(key,json.dumps(result)))
                self.conn.commit();return result
            except Exception:
                self.conn.rollback();raise

    def creator_earnings(self,owner_id):
        with self.lock:
            rows=self.conn.execute("SELECT e.app_id,e.points,a.name FROM creator_card_earnings e LEFT JOIN local_apps a ON a.id=e.app_id WHERE e.owner_id=? ORDER BY e.points DESC,e.app_id",(owner_id,)).fetchall()
            cards=[{'app_id':r['app_id'],'name':r['name'] or '已删除的角色卡','points':r['points']} for r in rows]
            return {'unit':'积分','creator_points':sum(r['points'] for r in cards),'invite_points':None,'cards':cards}
