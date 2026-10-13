"""Homer community works, contests, immutable work versions, and voting."""

from __future__ import annotations

import json
import re
import time
import uuid

from card_version_workshop import ContentVersionStore


WORK_TYPES = {"mod", "ui_template", "preset"}
MAX_WORKS_PER_USER = 100
MAX_VERSIONS_PER_WORK = 100
MIN_VERSION_INTERVAL_MS = 10_000
MAX_STRUCTURED_ENTRIES = 400
MAX_ENTRY_JSON_BYTES = 32 * 1024
MAX_CONTENT_JSON_BYTES = 512 * 1024
MAX_UI_DEMO_BYTES = 200 * 1024


def now_ms() -> int:
    return int(time.time() * 1000)


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _ok(data) -> dict:
    return {"code": 0, "message": "ok", "data": data}


def _err(message: str, status: int = 400) -> dict:
    return {"code": status, "message": message, "__http__": status}


def _loads(value, fallback):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value) if value else fallback
    except (TypeError, ValueError):
        return fallback


def ensure_community_schema(conn, lock) -> None:
    with lock:
        conn.executescript(
            """
            create table if not exists community_works (
                id text primary key,
                work_type text not null,
                owner_user_id text not null,
                owner_name text,
                name text not null,
                summary text,
                cover_url text,
                is_public integer not null default 0,
                is_open_source integer not null default 0,
                content_json text,
                demo_html text,
                status text not null default 'published',
                favorite_count integer not null default 0,
                use_count integer not null default 0,
                current_version_id text,
                created_at integer not null,
                updated_at integer not null
            );
            create index if not exists idx_community_works_public
                on community_works(work_type,is_public,status,updated_at desc);
            create index if not exists idx_community_works_owner
                on community_works(owner_user_id,updated_at desc);
            create table if not exists community_work_favorites (
                user_id text not null,
                work_id text not null,
                created_at integer not null,
                primary key(user_id,work_id)
            );
            create table if not exists community_contests (
                id text primary key,
                title text not null,
                content text,
                reward text,
                cover_url text,
                start_at integer not null,
                end_at integer not null,
                status text not null default 'active',
                created_by text,
                created_at integer not null,
                updated_at integer not null
            );
            create table if not exists community_contest_entries (
                contest_id text not null,
                app_id text not null,
                version_id text not null,
                owner_user_id text not null,
                entered_at integer not null,
                primary key(contest_id,app_id)
            );
            create index if not exists idx_contest_entries_rank
                on community_contest_entries(contest_id,entered_at);
            create table if not exists community_votes (
                contest_id text not null,
                app_id text not null,
                user_id text not null,
                created_at integer not null,
                primary key(contest_id,app_id,user_id)
            );
            create index if not exists idx_community_votes_rank
                on community_votes(contest_id,app_id);
            """
        )
        cols = {row[1] for row in conn.execute("pragma table_info(community_works)").fetchall()}
        if "current_version_id" not in cols:
            conn.execute("alter table community_works add column current_version_id text")
        conn.commit()


def _snapshot(row: dict) -> dict:
    return {
        "name": str(row.get("name") or "")[:120],
        "summary": str(row.get("summary") or "")[:2000],
        "cover_url": str(row.get("cover_url") or "")[:1000],
        "is_public": bool(row.get("is_public")),
        "is_open_source": bool(row.get("is_open_source")),
        "status": str(row.get("status") or "published")[:24],
        "content": _loads(row.get("content_json"), None),
        "demo_html": str(row.get("demo_html") or ""),
    }


def _entry_titles(work_type: str, content) -> list[str]:
    if isinstance(content, dict):
        values = content.get("entries") or content.get("prompts") or content.get("blocks") or []
        if isinstance(values, dict):
            values = list(values.values())
    else:
        values = content if isinstance(content, list) else []
    out = []
    for item in values[:200]:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("title") or item.get("comment") or item.get("identifier")
        if not name and work_type == "mod":
            keys = item.get("keys") or item.get("key") or []
            name = keys[0] if isinstance(keys, list) and keys else ""
        if str(name or "").strip():
            out.append(str(name).strip()[:80])
    return out


def _content_entries(content) -> list:
    if isinstance(content, list):
        return content
    if not isinstance(content, dict):
        return []
    for key in ("entries", "prompts", "blocks"):
        value = content.get(key)
        if isinstance(value, dict):
            return list(value.values())
        if isinstance(value, list):
            return value
    return []


def _validate_work_payload(work_type: str, content, demo_html: str = "") -> None:
    if work_type in {"mod", "preset"}:
        entries = _content_entries(content)
        if not entries:
            raise ValueError("content entries are required")
        if len(entries) > MAX_STRUCTURED_ENTRIES:
            raise ValueError("too many content entries")
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("content entries must be objects")
            if len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_ENTRY_JSON_BYTES:
                raise ValueError("content entry is too large")
    raw_content = json.dumps(content, ensure_ascii=False, separators=(",", ":")) if content is not None else "null"
    if len(raw_content.encode("utf-8")) > MAX_CONTENT_JSON_BYTES:
        raise ValueError("work content is too large")
    if len(str(demo_html or "").encode("utf-8")) > MAX_UI_DEMO_BYTES:
        raise ValueError("UI demo is too large")


class CommunityStore:
    def __init__(self, conn, lock):
        self.conn, self.lock = conn, lock
        self.versions = ContentVersionStore(conn, lock)

    def one(self, sql, args=()):
        with self.lock:
            row = self.conn.execute(sql, args).fetchone()
        return dict(row) if row else None

    def rows(self, sql, args=()):
        with self.lock:
            return [dict(row) for row in self.conn.execute(sql, args).fetchall()]

    def get_work(self, work_id: str):
        return self.one("select * from community_works where id=?", (work_id,))

    def can_use_work(self, user_id: str, row: dict | None) -> bool:
        if not row:
            return False
        if str(row.get("owner_user_id") or "") == user_id:
            return row.get("status") != "deleted"
        if not row.get("is_public") or row.get("status") != "published":
            return False
        return bool(self.one(
            "select 1 as ok from community_work_favorites where user_id=? and work_id=?",
            (user_id, row["id"]),
        ))

    @staticmethod
    def can_view_work(user_id: str, row: dict | None, is_admin: bool = False) -> bool:
        if not row:
            return False
        return bool(
            is_admin
            or (user_id and str(row.get("owner_user_id") or "") == str(user_id))
            or (row.get("is_public") and row.get("status") == "published")
        )

    def public_work(self, row: dict, viewer_id: str = "", is_admin: bool = False, detail: bool = False) -> dict:
        content = _loads(row.get("content_json"), None)
        out = {
            "id": row.get("id"), "work_type": row.get("work_type"),
            "owner_user_id": row.get("owner_user_id"), "owner_name": row.get("owner_name") or "",
            "name": row.get("name") or "", "summary": row.get("summary") or "",
            "cover_url": row.get("cover_url") or "", "is_public": bool(row.get("is_public")),
            "is_open_source": bool(row.get("is_open_source")), "status": row.get("status") or "published",
            "favorite_count": int(row.get("favorite_count") or 0),
            "use_count": int(row.get("use_count") or 0),
            "current_version_id": row.get("current_version_id") or "",
            "created_at": int(row.get("created_at") or 0), "updated_at": int(row.get("updated_at") or 0),
        }
        if row.get("work_type") in {"mod", "preset"}:
            out["entry_count"] = len(_entry_titles(str(row.get("work_type")), content))
        if detail and row.get("work_type") in {"mod", "preset"}:
            out["entry_titles"] = _entry_titles(str(row.get("work_type")), content)
        if detail and row.get("work_type") == "ui_template":
            out["demo_html"] = row.get("demo_html") or ""
        can_see = bool(is_admin or viewer_id == row.get("owner_user_id") or row.get("is_open_source"))
        out["can_see_content"] = can_see
        out["is_owner"] = bool(viewer_id and viewer_id == row.get("owner_user_id"))
        if detail and can_see:
            out["content"] = content
        return out

    def list_works(self, work_type: str, scope: str, user_id: str, search: str = "", limit: int = 60):
        where, args = [], []
        if work_type in WORK_TYPES:
            where.append("work_type=?"); args.append(work_type)
        if scope == "mine":
            where.append("owner_user_id=?"); args.append(user_id)
        elif scope == "favorites":
            where.extend(["is_public=1", "status='published'", "id in(select work_id from community_work_favorites where user_id=?)"]); args.append(user_id)
        else:
            where.extend(["is_public=1", "status='published'"])
        if search:
            where.append("(name like ? or summary like ?)"); args.extend([f"%{search}%", f"%{search}%"])
        args.append(max(1, min(int(limit or 60), 200)))
        rows = self.rows("select * from community_works where " + (" and ".join(where) if where else "1=1") + " order by updated_at desc limit ?", tuple(args))
        return [self.public_work(row, viewer_id=user_id) for row in rows]

    def create_work(self, user_id: str, owner_name: str, data: dict) -> dict:
        work_type = str(data.get("work_type") or "").strip()
        name = str(data.get("name") or "").strip()
        if work_type not in WORK_TYPES or not name:
            raise ValueError("invalid work_type or name")
        content = data.get("content")
        demo_html = str(data.get("demo_html") or "") if work_type == "ui_template" else ""
        _validate_work_payload(work_type, content, demo_html)
        ts, work_id = now_ms(), _id("cw")
        row = {
            "id": work_id, "work_type": work_type, "owner_user_id": user_id,
            "owner_name": owner_name or "", "name": name[:120],
            "summary": str(data.get("summary") or "")[:2000],
            "cover_url": str(data.get("cover_url") or "")[:1000],
            "is_public": 1 if data.get("is_public") else 0,
            "is_open_source": 1 if data.get("is_open_source") else 0,
            "content_json": json.dumps(content, ensure_ascii=False) if content is not None else None,
            "demo_html": demo_html,
            "status": "published", "created_at": ts, "updated_at": ts,
        }
        with self.lock:
            self.conn.execute("begin immediate")
            try:
                count = int(self.conn.execute(
                    "select count(*) from community_works where owner_user_id=? and status!='deleted'",
                    (user_id,),
                ).fetchone()[0] or 0)
                if count >= MAX_WORKS_PER_USER:
                    raise ValueError("work limit reached")
                self.conn.execute(
                    """insert into community_works(id,work_type,owner_user_id,owner_name,name,summary,cover_url,
                    is_public,is_open_source,content_json,demo_html,status,created_at,updated_at)
                    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    tuple(row[k] for k in ("id","work_type","owner_user_id","owner_name","name","summary","cover_url","is_public","is_open_source","content_json","demo_html","status","created_at","updated_at")),
                )
                version = self.versions.create_version(
                    work_type, work_id, _snapshot(row), version_name="v1",
                    author_description=str(data.get("version_description") or data.get("summary") or "初始版本"),
                    created_by=user_id, commit=False,
                )
                self.conn.execute("update community_works set current_version_id=? where id=?", (version["id"], work_id))
                self.conn.commit()
            except Exception:
                self.conn.rollback(); raise
        return self.get_work(work_id)

    def publish_work_version(self, work_id: str, user_id: str, data: dict) -> dict:
        row = self.get_work(work_id)
        if not row or row.get("owner_user_id") != user_id:
            raise PermissionError("forbidden")
        name = str(data.get("version_name") or data.get("label") or "").strip()
        if not name:
            raise ValueError("version_name required")
        description = str(data.get("version_description") or data.get("note") or "").strip()
        if not description:
            raise ValueError("version_description required")
        with self.lock:
            self.conn.execute("begin immediate")
            try:
                locked_row = self.conn.execute("select * from community_works where id=?", (work_id,)).fetchone()
                if not locked_row or str(locked_row["owner_user_id"] or "") != user_id:
                    raise PermissionError("forbidden")
                locked = dict(locked_row)
                merged = dict(locked)
                mapping = {"name":"name", "summary":"summary", "cover_url":"cover_url", "is_public":"is_public", "is_open_source":"is_open_source", "status":"status"}
                for source, target in mapping.items():
                    if source in data:
                        merged[target] = data[source]
                if "content" in data:
                    merged["content_json"] = json.dumps(data.get("content"), ensure_ascii=False)
                if locked.get("work_type") == "ui_template" and "demo_html" in data:
                    merged["demo_html"] = str(data.get("demo_html") or "")
                _validate_work_payload(str(locked.get("work_type") or ""), _loads(merged.get("content_json"), None), str(merged.get("demo_html") or ""))
                stats = self.conn.execute(
                    "select count(*) c,max(created_at) latest from content_versions where entity_type=? and entity_id=?",
                    (str(locked.get("work_type") or ""), work_id),
                ).fetchone()
                if int(stats["c"] or 0) >= MAX_VERSIONS_PER_WORK:
                    raise ValueError("version limit reached")
                if int(stats["latest"] or 0) + MIN_VERSION_INTERVAL_MS > now_ms():
                    raise ValueError("please wait before publishing another version")
                version = self.versions.create_version(locked["work_type"], work_id, _snapshot(merged), version_name=name, author_description=description, created_by=user_id, commit=False)
                self.conn.execute(
                    """update community_works set name=?,summary=?,cover_url=?,is_public=?,is_open_source=?,content_json=?,demo_html=?,status=?,current_version_id=?,updated_at=? where id=?""",
                    (merged.get("name"), merged.get("summary"), merged.get("cover_url"), 1 if merged.get("is_public") else 0,
                     1 if merged.get("is_open_source") else 0, merged.get("content_json"), merged.get("demo_html"),
                     merged.get("status") or "published", version["id"], now_ms(), work_id),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback(); raise
        return version

    def toggle_favorite(self, user_id: str, work_id: str) -> bool:
        with self.lock:
            self.conn.execute("begin immediate")
            try:
                row = self.conn.execute("select * from community_works where id=?", (work_id,)).fetchone()
                value = dict(row) if row else None
                if not value or (value.get("owner_user_id") != user_id and (not value.get("is_public") or value.get("status") != "published")):
                    raise ValueError("work not available")
                deleted = self.conn.execute(
                    "delete from community_work_favorites where user_id=? and work_id=?",
                    (user_id, work_id),
                ).rowcount
                if deleted:
                    self.conn.execute("update community_works set favorite_count=max(0,favorite_count-1) where id=?", (work_id,))
                    favorited = False
                else:
                    inserted = self.conn.execute(
                        "insert or ignore into community_work_favorites(user_id,work_id,created_at) values(?,?,?)",
                        (user_id, work_id, now_ms()),
                    ).rowcount
                    if inserted:
                        self.conn.execute("update community_works set favorite_count=favorite_count+1 where id=?", (work_id,))
                    favorited = bool(inserted)
                self.conn.commit()
                return favorited
            except Exception:
                self.conn.rollback()
                raise

    def active_contest(self):
        ts = now_ms()
        row = self.one("select * from community_contests where status='active' and start_at<=? and end_at>=? order by end_at limit 1", (ts, ts))
        return self.contest_payload(row) if row else None

    @staticmethod
    def contest_payload(row):
        if not row:
            return None
        ts, start, end = now_ms(), int(row.get("start_at") or 0), int(row.get("end_at") or 0)
        phase = "upcoming" if ts < start else ("ended" if ts > end else "active")
        return {**row, "start_at": start, "end_at": end, "phase": phase}

    def register_card(self, app_row: dict, version_id: str, requested: bool, *, commit: bool = True) -> str:
        contest = self.active_contest()
        valid = bool(requested and contest and app_row.get("source") == "user" and app_row.get("status") == "published" and app_row.get("is_public"))
        if not valid:
            if contest:
                with self.lock:
                    self.conn.execute("delete from community_contest_entries where contest_id=? and app_id=?", (contest["id"], app_row.get("id")))
                    self.conn.execute("delete from community_votes where contest_id=? and app_id=?", (contest["id"], app_row.get("id")))
                    if commit:
                        self.conn.commit()
            return ""
        with self.lock:
            previous = self.conn.execute(
                "select version_id from community_contest_entries where contest_id=? and app_id=?",
                (contest["id"], app_row["id"]),
            ).fetchone()
            if previous and str(previous["version_id"] or "") != str(version_id or ""):
                self.conn.execute(
                    "delete from community_votes where contest_id=? and app_id=?",
                    (contest["id"], app_row["id"]),
                )
            self.conn.execute(
                """insert into community_contest_entries(contest_id,app_id,version_id,owner_user_id,entered_at)
                values(?,?,?,?,?) on conflict(contest_id,app_id) do update set version_id=excluded.version_id,entered_at=excluded.entered_at""",
                (contest["id"], app_row["id"], version_id, app_row.get("owner_user_id") or "", now_ms()),
            )
            if commit:
                self.conn.commit()
        return str(contest["id"])

    def vote(self, contest_id: str, app_id: str, user_id: str) -> dict:
        with self.lock:
            self.conn.execute("begin immediate")
            try:
                contest_row = self.conn.execute("select * from community_contests where id=?", (contest_id,)).fetchone()
                contest = dict(contest_row) if contest_row else None
                if not contest or self.contest_payload(contest)["phase"] != "active" or contest.get("status") != "active":
                    raise ValueError("赛事不在进行中")
                entry_row = self.conn.execute("select * from community_contest_entries where contest_id=? and app_id=?", (contest_id, app_id)).fetchone()
                app_row = self.conn.execute("select * from local_apps where id=?", (app_id,)).fetchone()
                entry, app = (dict(entry_row) if entry_row else None), (dict(app_row) if app_row else None)
                if not entry or not app or app.get("source") != "user" or app.get("status") != "published" or not app.get("is_public"):
                    raise ValueError("角色未有效参赛")
                version = self.conn.execute(
                    "select 1 from content_versions where id=? and entity_type='character' and entity_id=?",
                    (entry.get("version_id"), app_id),
                ).fetchone()
                if not version:
                    raise ValueError("参赛版本无效")
                existing = self.conn.execute(
                    "select 1 from community_votes where contest_id=? and app_id=? and user_id=?",
                    (contest_id, app_id, user_id),
                ).fetchone()
                if existing:
                    self.conn.execute("delete from community_votes where contest_id=? and app_id=? and user_id=?", (contest_id, app_id, user_id))
                else:
                    self.conn.execute("insert into community_votes(contest_id,app_id,user_id,created_at) values(?,?,?,?)", (contest_id, app_id, user_id, now_ms()))
                count = self.conn.execute("select count(*) from community_votes where contest_id=? and app_id=?", (contest_id, app_id)).fetchone()[0]
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return {"voted": not bool(existing), "votes": int(count)}


def handle_community_route(method, normalized, query, body, ctx):
    prefix = "console/api/web/community/"
    if not normalized.startswith(prefix):
        return None
    user, is_admin = ctx.get("user") or {}, bool(ctx.get("is_admin"))
    uid = str(user.get("id") or "")
    store = CommunityStore(ctx["conn"], ctx["lock"])
    sub, method = normalized[len(prefix):].strip("/"), method.upper()
    q = lambda key, default="": ((query.get(key) or [default])[0] if isinstance(query.get(key), list) else query.get(key, default)) if isinstance(query, dict) else default
    if sub == "works":
        if method == "GET":
            scope = str(q("scope", "public"))
            if scope in {"mine", "favorites"} and not uid: return _err("unauthorized", 401)
            items = store.list_works(str(q("type", "")), scope, uid, str(q("q", "")), int(q("limit", 60) or 60))
            return _ok({"list": items, "total": len(items)})
        if method == "POST" and uid:
            try:
                row = store.create_work(uid, str(user.get("name") or user.get("nickname") or ""), body if isinstance(body, dict) else {})
                return _ok(store.public_work(row, uid, is_admin, True))
            except ValueError as exc: return _err(str(exc))
        return _err("unauthorized" if not uid else "method not allowed", 401 if not uid else 405)
    version_match = re.fullmatch(r"works/([^/]+)/versions(?:/([^/]+))?", sub)
    if version_match and method == "GET":
        work_id, version_id = version_match.group(1), version_match.group(2)
        row = store.get_work(work_id)
        if not store.can_view_work(uid, row, is_admin):
            return _err("not found", 404)
        if not version_id:
            return _ok({"work_id":work_id, "current_version_id":row.get("current_version_id") or "",
                        "list":store.versions.list_versions(str(row.get("work_type")),work_id)})
        version = store.versions.get_version(version_id, str(row.get("work_type")), work_id)
        snapshot = store.versions.snapshot(version_id, str(row.get("work_type")), work_id)
        if not version or snapshot is None:
            return _err("not found", 404)
        payload = {key:version.get(key) for key in ("id","version_no","version_name","author_description","created_by","created_at")}
        payload["label"], payload["note"] = payload.get("version_name") or "", payload.get("author_description") or ""
        payload["name"], payload["summary"] = snapshot.get("name") or "", snapshot.get("summary") or ""
        payload["entry_titles"] = _entry_titles(str(row.get("work_type")), snapshot.get("content"))
        if is_admin or uid == row.get("owner_user_id") or snapshot.get("is_open_source"):
            payload["content"] = snapshot.get("content")
        if row.get("work_type") == "ui_template":
            payload["demo_html"] = snapshot.get("demo_html") or ""
        return _ok(payload)
    match = re.fullmatch(r"works/([^/]+)(?:/(favorite|update|delete))?", sub)
    if match:
        work_id, action = match.group(1), match.group(2)
        row = store.get_work(work_id)
        if not row: return _err("not found", 404)
        if action is None and method == "GET":
            if not store.can_view_work(uid, row, is_admin): return _err("not found", 404)
            out = store.public_work(row, uid, is_admin, True)
            out["is_favorited"] = bool(uid and store.one("select 1 as ok from community_work_favorites where user_id=? and work_id=?", (uid, work_id)))
            out["versions"] = store.versions.list_versions(str(row.get("work_type")), work_id)
            return _ok(out)
        if not uid: return _err("unauthorized", 401)
        try:
            if action == "favorite" and method == "POST": return _ok({"favorited": store.toggle_favorite(uid, work_id)})
            if action == "update" and method == "POST": return _ok(store.publish_work_version(work_id, uid, body if isinstance(body, dict) else {}))
            if action == "delete" and method == "POST":
                if row.get("owner_user_id") != uid and not is_admin: return _err("forbidden", 403)
                with store.lock:
                    store.conn.execute("update community_works set status='deleted',is_public=0,updated_at=? where id=?", (now_ms(), work_id)); store.conn.commit()
                return _ok({"deleted": True})
        except (ValueError, PermissionError) as exc: return _err(str(exc), 403 if isinstance(exc, PermissionError) else 400)
    if sub == "contests":
        if method == "GET":
            rows = [store.contest_payload(row) for row in store.rows("select * from community_contests order by end_at desc limit 50")]
            return _ok({"list": rows, "active": store.active_contest()})
        if method == "POST" and is_admin:
            data, ts = body if isinstance(body, dict) else {}, now_ms()
            title = str(data.get("title") or "").strip()
            start, end = int(data.get("start_at") or ts), int(data.get("end_at") or ts + 14 * 86400000)
            if not title or end <= start: return _err("invalid contest")
            cid = _id("contest")
            with store.lock:
                store.conn.execute("insert into community_contests values(?,?,?,?,?,?,?,?,?,?,?)", (cid,title[:120],str(data.get("content") or "")[:4000],str(data.get("reward") or "")[:1000],str(data.get("cover_url") or "")[:1000],start,end,"active",uid,ts,ts)); store.conn.commit()
            return _ok(store.contest_payload(store.one("select * from community_contests where id=?", (cid,))))
        return _err("forbidden", 403)
    match = re.fullmatch(r"contests/([^/]+)/(rankings|vote)", sub)
    if match:
        contest_id, action = match.group(1), match.group(2)
        if action == "vote" and method == "POST":
            if not uid: return _err("unauthorized", 401)
            try: return _ok(store.vote(contest_id, str((body or {}).get("app_id") or ""), uid))
            except ValueError as exc: return _err(str(exc))
        if action == "rankings" and method == "GET":
            rows = store.rows("""select e.app_id,e.version_id,count(v.user_id) votes from community_contest_entries e
                join local_apps a on a.id=e.app_id and a.source='user' and a.status='published' and a.is_public=1
                left join community_votes v on v.contest_id=e.contest_id and v.app_id=e.app_id
                where e.contest_id=? group by e.app_id,e.version_id order by votes desc,e.entered_at asc""", (contest_id,))
            app_meta = ctx.get("app_meta")
            out = []
            for index, row in enumerate(rows, 1):
                snapshot = store.versions.snapshot(row["version_id"], "character", row["app_id"])
                if not snapshot:
                    continue
                meta = app_meta(row["app_id"]) if callable(app_meta) else {}
                meta = {
                    **(meta or {}),
                    "name": str(snapshot.get("name") or (meta or {}).get("name") or ""),
                    "summary": str(snapshot.get("summary") or ""),
                    "cover": str(snapshot.get("cover_url") or ""),
                    "cover_url": str(snapshot.get("cover_url") or ""),
                }
                out.append({"rank":index, **row, "votes":int(row.get("votes") or 0), **(meta or {}),
                    "voted": bool(uid and store.one("select 1 as ok from community_votes where contest_id=? and app_id=? and user_id=?", (contest_id,row["app_id"],uid)))})
            return _ok({"list": out, "contest": store.contest_payload(store.one("select * from community_contests where id=?", (contest_id,)))})
    match = re.fullmatch(r"contests/([^/]+)", sub)
    close_match = re.fullmatch(r"contests/([^/]+)/close", sub)
    if close_match and method == "POST":
        if not is_admin:
            return _err("forbidden", 403)
        with store.lock:
            changed = store.conn.execute(
                "update community_contests set status='closed',updated_at=? where id=? and status!='closed'",
                (now_ms(), close_match.group(1)),
            ).rowcount
            store.conn.commit()
        return _ok({"closed": bool(changed), "id": close_match.group(1)})
    if match and method == "GET":
        contest = store.contest_payload(store.one("select * from community_contests where id=?", (match.group(1),)))
        return _ok(contest) if contest else _err("not found", 404)
    return _err("not found", 404)
