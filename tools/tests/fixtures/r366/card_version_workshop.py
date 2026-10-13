"""Immutable versions and drafts for Homer characters and community works."""

from __future__ import annotations

import hashlib
import json
import time
import uuid


CHARACTER_SNAPSHOT_FIELDS = (
    "display_id", "source", "owner_user_id", "name", "summary", "description",
    "cover_url", "cover_origin", "tags", "opening_statement", "suggested_questions",
    "pre_prompt", "llm_model", "api_base_url", "age_rating", "gender", "language",
    "status", "is_public", "sort_weight", "official_recommended", "extra_settings",
)
MAX_CHARACTER_VERSIONS = 200


class DraftUnavailableError(ValueError):
    """Raised when a publish request has no unconsumed draft to publish."""


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_card_version_schema(conn, lock) -> None:
    with lock:
        conn.executescript(
            """
            create table if not exists content_versions (
                id text primary key,
                entity_type text not null,
                entity_id text not null,
                version_no integer not null,
                version_name text not null,
                author_description text not null default '',
                snapshot_json text not null,
                content_hash text not null,
                created_by text,
                created_at integer not null,
                unique(entity_type,entity_id,version_no)
            );
            create index if not exists idx_content_versions_entity
                on content_versions(entity_type,entity_id,version_no desc);
            create table if not exists content_drafts (
                entity_type text not null,
                entity_id text not null,
                owner_user_id text not null,
                snapshot_json text not null,
                updated_at integer not null,
                primary key(entity_type,entity_id)
            );
            create table if not exists content_version_assets (
                version_id text not null,
                asset_id text not null,
                primary key(version_id,asset_id)
            );
            create index if not exists idx_content_version_assets_asset
                on content_version_assets(asset_id,version_id);
            """
        )
        app_cols = {row[1] for row in conn.execute("pragma table_info(local_apps)").fetchall()}
        if "current_version_id" not in app_cols:
            conn.execute("alter table local_apps add column current_version_id text")
        conv_cols = {row[1] for row in conn.execute("pragma table_info(conversations)").fetchall()}
        if "version_id" not in conv_cols:
            conn.execute("alter table conversations add column version_id text")
        conn.commit()


def character_snapshot(row: dict) -> dict:
    return {key: row.get(key) for key in CHARACTER_SNAPSHOT_FIELDS if key in row}


def merge_snapshot_over_row(row: dict, snapshot: dict) -> dict:
    merged = dict(row or {})
    merged.update(snapshot or {})
    return merged


class ContentVersionStore:
    def __init__(self, conn, lock):
        self.conn, self.lock = conn, lock

    def get_version(self, version_id: str, entity_type: str = "", entity_id: str = ""):
        if not version_id:
            return None
        sql, args = "select * from content_versions where id=?", [version_id]
        if entity_type:
            sql += " and entity_type=?"; args.append(entity_type)
        if entity_id:
            sql += " and entity_id=?"; args.append(entity_id)
        with self.lock:
            row = self.conn.execute(sql, tuple(args)).fetchone()
        return dict(row) if row else None

    def list_versions(self, entity_type: str, entity_id: str) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                """select id,entity_type,entity_id,version_no,version_name,author_description,created_by,created_at
                from content_versions where entity_type=? and entity_id=? order by version_no desc""",
                (entity_type, entity_id),
            ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["label"] = item.get("version_name") or ""
            item["note"] = item.get("author_description") or ""
            item["app_id"] = entity_id
            out.append(item)
        return out

    def snapshot(self, version_id: str, entity_type: str = "", entity_id: str = ""):
        row = self.get_version(version_id, entity_type, entity_id)
        if not row:
            return None
        try:
            value = json.loads(row.get("snapshot_json") or "{}")
        except (TypeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def create_version(self, entity_type: str, entity_id: str, snapshot: dict, *, version_name: str,
                       author_description: str = "", created_by: str = "", commit: bool = True) -> dict:
        name = str(version_name or "").strip()
        if not name:
            raise ValueError("version_name required")
        blob = json.dumps(snapshot or {}, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()
        with self.lock:
            row = self.conn.execute(
                "select coalesce(max(version_no),0)+1 from content_versions where entity_type=? and entity_id=?",
                (entity_type, entity_id),
            ).fetchone()
            number = int(row[0] if row else 1)
            version_id = "cver_" + uuid.uuid4().hex[:16]
            ts = now_ms()
            self.conn.execute(
                """insert into content_versions(id,entity_type,entity_id,version_no,version_name,author_description,
                snapshot_json,content_hash,created_by,created_at) values(?,?,?,?,?,?,?,?,?,?)""",
                (version_id, entity_type, entity_id, number, name[:80], str(author_description or "")[:4000], blob, digest, created_by, ts),
            )
            asset_ids = sorted(_snapshot_asset_ids(snapshot))
            if asset_ids:
                self.conn.executemany(
                    "insert or ignore into content_version_assets(version_id,asset_id) values(?,?)",
                    [(version_id, asset_id) for asset_id in asset_ids],
                )
            if commit:
                self.conn.commit()
        return {"id": version_id, "entity_type": entity_type, "entity_id": entity_id, "version_no": number,
                "version_name": name[:80], "label": name[:80], "author_description": str(author_description or "")[:4000],
                "note": str(author_description or "")[:4000], "created_by": created_by, "created_at": ts, "content_hash": digest}

    def ensure_character_baseline(self, app_row: dict, commit: bool = True) -> str:
        app_id = str(app_row.get("id") or "")
        current = str(app_row.get("current_version_id") or "")
        if current and self.get_version(current, "character", app_id):
            return current
        with self.lock:
            existing = self.conn.execute(
                "select id from content_versions where entity_type='character' and entity_id=? order by version_no desc limit 1",
                (app_id,),
            ).fetchone()
            if existing:
                version_id = str(existing[0])
            else:
                version_id = self.create_version("character", app_id, character_snapshot(app_row), version_name="v1",
                                                 author_description="初始版本", created_by=str(app_row.get("owner_user_id") or ""), commit=False)["id"]
            self.conn.execute("update local_apps set current_version_id=? where id=?", (version_id, app_id))
            if commit:
                self.conn.commit()
        return version_id

    def save_draft(self, app_row: dict, owner_user_id: str, snapshot: dict, commit: bool = True) -> dict:
        app_id = str(app_row.get("id") or "")
        with self.lock:
            self.conn.execute(
                """insert into content_drafts(entity_type,entity_id,owner_user_id,snapshot_json,updated_at)
                values('character',?,?,?,?) on conflict(entity_type,entity_id) do update set
                owner_user_id=excluded.owner_user_id,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at""",
                (app_id, owner_user_id, json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), now_ms()),
            )
            if commit:
                self.conn.commit()
        return merge_snapshot_over_row(app_row, snapshot)

    def draft_snapshot(self, app_id: str, owner_user_id: str = ""):
        sql, args = "select snapshot_json from content_drafts where entity_type='character' and entity_id=?", [app_id]
        if owner_user_id:
            sql += " and owner_user_id=?"; args.append(owner_user_id)
        with self.lock:
            row = self.conn.execute(sql, tuple(args)).fetchone()
        if not row:
            return None
        try:
            value = json.loads(row[0] or "{}")
        except (TypeError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def publish_character(self, app_row: dict, user_id: str, *, version_name: str, author_description: str,
                          snapshot: dict | None = None, commit: bool = True,
                          after_projection=None, asset_owner_user_id: str | None = None) -> dict:
        app_id = str(app_row.get("id") or "")
        name = str(version_name or "").strip()
        description = str(author_description or "").strip()
        if not name:
            raise ValueError("version_name required")
        if not description:
            raise ValueError("author_description required")
        with self.lock:
            self.conn.execute("begin immediate")
            try:
                locked_row = self.conn.execute("select * from local_apps where id=?", (app_id,)).fetchone()
                if not locked_row:
                    raise ValueError("role not found")
                locked_app = dict(locked_row)
                source = str(locked_app.get("source") or "")
                owner = str(locked_app.get("owner_user_id") or "")
                if user_id != "admin" and (source != "user" or owner != str(user_id or "")):
                    raise PermissionError("forbidden")
                if snapshot is None:
                    draft_row = self.conn.execute(
                        "select snapshot_json from content_drafts where entity_type='character' and entity_id=? and owner_user_id=?",
                        (app_id, user_id),
                    ).fetchone()
                    if not draft_row:
                        raise DraftUnavailableError("draft was already published or is unavailable")
                    try:
                        draft = json.loads(draft_row[0] or "{}")
                    except (TypeError, ValueError) as exc:
                        raise DraftUnavailableError("draft is invalid") from exc
                    if not isinstance(draft, dict):
                        raise DraftUnavailableError("draft is invalid")
                else:
                    draft = dict(snapshot)
                self.ensure_character_baseline(locked_app, commit=False)
                version_count = int(self.conn.execute(
                    "select count(*) from content_versions where entity_type='character' and entity_id=?",
                    (app_id,),
                ).fetchone()[0] or 0)
                if version_count >= MAX_CHARACTER_VERSIONS:
                    raise ValueError("character version limit reached")
                self.validate_character_snapshot_assets(draft, asset_owner_user_id if asset_owner_user_id is not None else user_id, app_id)
                version = self.create_version("character", app_id, draft, version_name=name,
                                              author_description=description, created_by=user_id, commit=False)
                columns = [key for key in CHARACTER_SNAPSHOT_FIELDS if key in draft and key not in {"display_id", "source", "owner_user_id"}]
                if columns:
                    self.conn.execute(
                        "update local_apps set " + ",".join(f"{key}=?" for key in columns) + ",current_version_id=?,updated_at=? where id=?",
                        tuple(draft[key] for key in columns) + (version["id"], now_ms(), app_id),
                    )
                else:
                    self.conn.execute("update local_apps set current_version_id=?,updated_at=? where id=?", (version["id"], now_ms(), app_id))
                projected = self.conn.execute("select * from local_apps where id=?", (app_id,)).fetchone()
                if callable(after_projection):
                    after_projection(dict(projected) if projected else merge_snapshot_over_row(locked_app, draft), version)
                self.conn.execute("delete from content_drafts where entity_type='character' and entity_id=?", (app_id,))
                if commit:
                    self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return version

    def validate_character_snapshot_assets(self, snapshot: dict, owner_user_id: str, app_id: str) -> None:
        asset_ids = sorted(_snapshot_asset_ids(snapshot))
        if not asset_ids:
            return
        table = self.conn.execute(
            "select 1 from sqlite_master where type='table' and name='card_media_assets'"
        ).fetchone()
        if not table:
            raise ValueError("card media assets are unavailable")
        placeholders = ",".join("?" for _ in asset_ids)
        rows = self.conn.execute(
            f"select id,owner_user_id,app_id,status from card_media_assets where id in ({placeholders})",
            tuple(asset_ids),
        ).fetchall()
        by_id = {str(row["id"]): row for row in rows}
        for asset_id in asset_ids:
            row = by_id.get(asset_id)
            if (
                not row
                or str(row["owner_user_id"] or "") != str(owner_user_id or "")
                or str(row["app_id"] or "") != str(app_id or "")
                or str(row["status"] or "") != "ready"
            ):
                raise ValueError(f"card media asset is not ready or does not belong to this card: {asset_id}")


def resolve_versioned_app(conn, lock, app_row, version_id):
    if not app_row:
        return None
    base = dict(app_row)
    app_id = str(base.get("id") or "")
    snapshot = ContentVersionStore(conn, lock).snapshot(str(version_id or ""), "character", app_id)
    return merge_snapshot_over_row(base, snapshot) if snapshot else None


def handle_card_version_route(method, normalized, query, body, ctx):
    prefix = "console/api/web/card-versions/"
    if not normalized.startswith(prefix):
        return None
    parts = [part for part in normalized[len(prefix):].strip("/").split("/") if part]
    if not parts:
        return {"code": 404, "message": "not found", "__http__": 404}
    row = ctx.get("get_app")(parts[0]) if callable(ctx.get("get_app")) else None
    if not row:
        return {"code": 404, "message": "not found", "__http__": 404}
    row, user = dict(row), ctx.get("user") or {}
    uid, app_id = str(user.get("id") or ""), str(row.get("id") or "")
    is_admin = bool(ctx.get("is_admin"))
    can_edit = bool(is_admin or (uid and row.get("source") == "user" and str(row.get("owner_user_id") or "") == uid))
    can_view = bool(can_edit or (row.get("is_public") and row.get("status") == "published"))
    if not can_view:
        return {"code": 404, "message": "not found", "__http__": 404}
    store = ContentVersionStore(ctx["conn"], ctx["lock"])
    current_id = store.ensure_character_baseline(row)
    if len(parts) == 1 and method.upper() == "GET":
        return {"code": 0, "message": "ok", "data": {"app_id": app_id, "current_version_id": current_id,
                "list": store.list_versions("character", app_id)}}
    if len(parts) == 1 and method.upper() == "POST":
        if not can_edit:
            return {"code": 403, "message": "forbidden", "__http__": 403}
        data = body if isinstance(body, dict) else {}
        try:
            version = store.publish_character(row, uid, version_name=str(data.get("version_name") or data.get("label") or ""),
                                              author_description=str(data.get("version_description") or data.get("note") or ""),
                                              after_projection=ctx.get("after_publish_in_transaction"))
        except DraftUnavailableError as exc:
            return {"code": 409, "message": str(exc), "__http__": 409}
        except ValueError as exc:
            return {"code": 400, "message": str(exc), "__http__": 400}
        return {"code": 0, "message": "ok", "data": version}
    if len(parts) == 2 and method.upper() == "GET":
        version = store.get_version(parts[1], "character", app_id)
        snapshot = store.snapshot(parts[1], "character", app_id)
        if not version or snapshot is None:
            return {"code": 404, "message": "not found", "__http__": 404}
        payload = {key: version.get(key) for key in ("id","version_no","version_name","author_description","created_by","created_at")}
        payload["label"], payload["note"] = payload["version_name"], payload["author_description"]
        if can_edit or bool(_snapshot_open_source(snapshot)):
            renderer = ctx.get("card_payload")
            payload["card"] = renderer(merge_snapshot_over_row(row, snapshot)) if callable(renderer) else snapshot
        return {"code": 0, "message": "ok", "data": payload}
    return {"code": 405, "message": "method not allowed", "__http__": 405}


def _snapshot_open_source(snapshot: dict) -> bool:
    try:
        extra = json.loads(snapshot.get("extra_settings") or "{}") if isinstance(snapshot.get("extra_settings"), str) else snapshot.get("extra_settings") or {}
    except (TypeError, ValueError):
        extra = {}
    return bool(extra.get("is_open_source"))


def _snapshot_asset_ids(snapshot: dict) -> set[str]:
    found: set[str] = set()

    def visit(value, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                if child_key in {"asset_id", "media_asset_id"} and isinstance(child, str) and child.strip():
                    found.add(child.strip())
                elif child_key == "id" and key == "media_assets" and isinstance(child, str) and child.strip():
                    found.add(child.strip())
                else:
                    visit(child, child_key)
        elif isinstance(value, list):
            for child in value:
                if key in {"asset_ids", "media_asset_ids"} and isinstance(child, str) and child.strip():
                    found.add(child.strip())
                else:
                    visit(child, key)
        elif isinstance(value, str) and key in {"extra_settings", "content_json", "snapshot_json"}:
            try:
                parsed = json.loads(value)
            except (TypeError, ValueError):
                return
            visit(parsed, key)

    visit(snapshot if isinstance(snapshot, dict) else {})
    return found
