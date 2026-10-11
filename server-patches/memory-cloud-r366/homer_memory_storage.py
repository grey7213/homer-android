"""Additive private-memory contract on the existing authenticated runtime-state API.

No caller credentials or author worlds. Deployment is separate from an APK.
Legacy runtime fields retain their existing behavior; an omitted reserved key
cannot erase new private memories. CAS applies only to this optional namespace.
"""
import hashlib
import json
import re
import time
import uuid

KEY = "homer_memory_book"
ZERO = "0" * 32
FIELDS = {"schema_version", "scope", "body", "digest", "change_id", "base_version", "storage_version"}


class MemoryStorageError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _scope(user, app, conv):
    return [str(user or "").strip(), str(app or "").strip(), str(conv or "").strip()]


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _row_memory(store, scope):
    row = store.conn.execute(
        "select variables_json from sillytavern_runtime_states where user_id=? and app_id=? and conversation_id=?", scope
    ).fetchone()
    values = json.loads(row["variables_json"] or "{}") if row else {}
    return values.get(KEY) if isinstance(values, dict) else None


def _validate(memory, scope):
    if not all(scope) or not isinstance(memory, dict) or set(memory) - FIELDS:
        raise MemoryStorageError("invalid private memory")
    if memory.get("schema_version") != 1 or memory.get("scope") != scope:
        raise MemoryStorageError("private memory scope mismatch", 409)
    body = memory.get("body")
    if not isinstance(body, str) or not re.fullmatch(r"[a-f0-9]{64}", str(memory.get("digest", ""))):
        raise MemoryStorageError("invalid private memory digest")
    if hashlib.sha256(body.encode("utf-8")).hexdigest() != memory["digest"]:
        raise MemoryStorageError("incomplete private memory")
    if not re.fullmatch(r"[a-f0-9]{32}", str(memory.get("change_id", ""))):
        raise MemoryStorageError("invalid private memory commit")
    try:
        book = json.loads(body, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    except (ValueError, TypeError) as exc:
        raise MemoryStorageError("invalid private memory body") from exc
    marker = book.get("homerMemory") if isinstance(book, dict) else None
    if not isinstance(marker, dict) or marker.get("version") != 1 or marker.get("scope") != _json(scope):
        raise MemoryStorageError("private book scope mismatch", 409)
    if not isinstance(book.get("entries"), dict) or any(not isinstance(v, dict) for v in book["entries"].values()):
        raise MemoryStorageError("invalid private memory entries")
    return {key: memory[key] for key in ("schema_version", "scope", "body", "digest", "change_id")}


def _receipt(memory, scope):
    return {"protocol": 1, "complete": True, "scope": scope,
            "version": memory["storage_version"] if memory else ZERO,
            "digest": memory["digest"] if memory else None,
            "change_id": memory["change_id"] if memory else None}


def read_runtime_state(store, user, app="", conv=""):
    scope = _scope(user, app, conv)
    with store.lock:
        state = store._get_sillytavern_runtime_state_legacy(*scope)
        # Generic state still merges user/card/conversation defaults. Private
        # memory is NEVER inherited from those coarser scopes.
        values = dict(state.get("variables") or {})
        values.pop(KEY, None)
        memory = _row_memory(store, scope) if all(scope) else None
        if memory:
            _validate(memory, scope)
            if not re.fullmatch(r"[a-f0-9]{32}", str(memory.get("storage_version", ""))):
                raise MemoryStorageError("invalid stored private memory version")
            values[KEY] = memory
        state["variables"] = values
        if all(scope):
            state["memory_storage"] = _receipt(memory, scope)
        return state


def write_runtime_state(store, user, app, conv, data):
    scope = _scope(user, app, conv)
    if not isinstance(data, dict):
        raise MemoryStorageError("invalid runtime state")
    body = dict(data)
    with store.lock:
        try:
            existing = _row_memory(store, scope)
            if existing is not None:
                _validate(existing, scope)
                if not re.fullmatch(r"[a-f0-9]{32}", str(existing.get("storage_version", ""))):
                    raise MemoryStorageError("invalid stored private memory version")
            values = body.get("variables")
            incoming = values.get(KEY) if isinstance(values, dict) else None
            explicit = isinstance(values, dict) and KEY in values
            if explicit:
                normalized = _validate(incoming, scope)
                version = existing.get("storage_version", ZERO) if existing else ZERO
                repeat = existing and existing.get("change_id") == normalized["change_id"]
                if repeat and (existing.get("digest") != normalized["digest"] or existing.get("body") != normalized["body"]):
                    raise MemoryStorageError("private memory commit reused", 409)
                if not repeat and incoming.get("base_version") != version:
                    raise MemoryStorageError("private memory version conflict", 409)
                stored = existing if repeat else {**normalized, "storage_version": uuid.uuid4().hex}
                body["variables"] = {**values, KEY: stored}
                # Validate before any backup/SQL write; never silently truncate.
                store._runtime_json("variables", body["variables"])
                if existing and not repeat:
                    store.conn.execute("""create table if not exists homer_memory_backups(
                        user_id text not null, app_id text not null, conversation_id text not null,
                        version text not null, memory_json text not null, created_at integer not null,
                        primary key(user_id,app_id,conversation_id,version))""")
                    store.conn.execute("insert or ignore into homer_memory_backups values(?,?,?,?,?,?)",
                                       (*scope, existing["storage_version"], _json(existing), int(time.time() * 1000)))
                    store.conn.execute("""delete from homer_memory_backups where user_id=? and app_id=? and conversation_id=?
                        and version not in(select version from homer_memory_backups where user_id=? and app_id=? and conversation_id=?
                        order by created_at desc,rowid desc limit 10)""", (*scope, *scope))
            elif "variables" in body and existing:
                # An old APK replaces the variables column, unaware of this
                # optional namespace. Preserve it and its exact CAS identity.
                body["variables"] = {**(values if isinstance(values, dict) else {}), KEY: existing}
                store._runtime_json("variables", body["variables"])
            store._save_sillytavern_runtime_state_legacy(*scope, body)
        except Exception:
            store.conn.rollback()
            raise
        return read_runtime_state(store, *scope)
