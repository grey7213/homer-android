"""Account-scoped inert game/branch backups. No media, providers or credentials.

Phone progress is authoritative. Writes require CAS plus durable idempotency
receipts; conflicts preserve both versions instead of merging or rewinding.
"""
import hashlib
import json
import math
import re
import time
import uuid
from urllib.parse import urlsplit, unquote

MAX_GAME = 4 * 1024 * 1024
MAX_BUNDLE = 28 * 1024 * 1024  # Below the existing 32 MiB HTTP body gate.
VERSION = re.compile(r"^[0-9a-f]{32}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
FORBIDDEN = re.compile(r"token|password|passwd|secret|credential|authorization|cookie|bearer|apikey|privatekey|headers|homerbridge")


class ArchiveStorageError(ValueError):
    def __init__(self, code, message, status=400):
        super().__init__(f"[{code}] {message}")
        self.code, self.status = code, status


def _bad():
    raise ArchiveStorageError("HM-A400", "游戏备份格式无效，未修改本机或云端进度")


def _dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def _fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        _bad()


def _text(value, limit=MAX_GAME, nonempty=False):
    if not isinstance(value, str) or len(value) > limit or (nonempty and not value.strip()):
        _bad()
    return value


def _id(value, empty=False):
    _text(value, 1024, not empty)
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        _bad()
    return value


def _int(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2**53 - 1:
        _bad()


def _data(value, depth=0, nodes=None):
    nodes = nodes if nodes is not None else [0]
    nodes[0] += 1
    if depth > 24 or nodes[0] > 150000:
        _bad()
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in {"__proto__", "prototype", "constructor"} or FORBIDDEN.search(re.sub(r"[^a-z0-9]", "", key.lower())):
                _bad()
            _data(item, depth+1, nodes)
    elif isinstance(value, list):
        if len(value) > 10000:
            _bad()
        for item in value:
            _data(item, depth+1, nodes)
    elif isinstance(value, str):
        _text(value)
    elif value is not None and not isinstance(value, (bool, int, float)):
        _bad()
    elif isinstance(value, float) and not math.isfinite(value):
        _bad()


def _game(game, owner):
    _fields(game, ("version", "id", "owner", "title", "player", "world", "characters", "active", "events", "turns", "memories", "revision", "createdAt", "updatedAt"))
    if game["version"] != 1 or game["owner"] != owner:
        _bad()
    _id(game["id"]); _text(game["title"], 200, True)
    for key in ("revision", "createdAt", "updatedAt"):
        _int(game[key])
    _fields(game["player"], ("name",)); _text(game["player"]["name"], 200, True)
    _fields(game["world"], ("scene", "summary")); _text(game["world"]["scene"], 1000); _text(game["world"]["summary"])
    people = game["characters"]
    if not isinstance(people, list) or not 1 <= len(people) <= 12:
        _bad()
    ids, apps, conversations = set(), set(), set()
    for person in people:
        _fields(person, ("id", "appId", "versionId", "name", "avatar", "conversationId"), ("themeRoleId", "mediaRef"))
        for key in ("id", "appId", "versionId", "conversationId"):
            _id(person[key], key in ("versionId", "conversationId"))
        if person["id"] in ids or person["appId"] in apps or (person["conversationId"] and person["conversationId"] in conversations):
            _bad()
        ids.add(person["id"]); apps.add(person["appId"]); conversations.add(person["conversationId"])
        _text(person["name"], 200, True); _text(person["avatar"], 8192)
        if person["avatar"]:
            url = urlsplit(person["avatar"])
            if url.username or url.password or (url.scheme and url.scheme not in ("http", "https")) or FORBIDDEN.search(url.query + url.fragment) or re.search(r"[?&#](?:auth|key)=", "?"+url.query) or re.search(r"/(?:token|auth|secret|credential|password)(?:/|$)", unquote(url.path), re.I):
                _bad()
        if "themeRoleId" in person:
            _text(person["themeRoleId"], 100, True)
        if "mediaRef" in person:
            ref = person["mediaRef"]; _fields(ref, ("resourceId", "revisionId", "sha256", "roleUid"))
            if not UUID.fullmatch(str(ref["resourceId"])) or not UUID.fullmatch(str(ref["revisionId"])) or not re.fullmatch(r"[a-f0-9]{64}", str(ref["sha256"])) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", str(ref["roleUid"])):
                _bad()
    active = game["active"]; _fields(active, ("characterId", "channel", "eventId")); _id(active["eventId"], True)
    channels = {"stage", "talk", "group"}
    if active["characterId"] not in ids or active["channel"] not in channels or (active["channel"] == "group" and len(people) < 2):
        _bad()
    events, turns = {}, {}
    if any(not isinstance(game[k], list) for k in ("events", "turns", "memories")) or len(game["turns"]) > 5000:
        _bad()
    for event in game["events"]:
        _fields(event, ("id", "eventId", "characterId", "title", "scene", "status", "createdAt", "updatedAt")); _id(event["id"])
        if event["eventId"] != event["id"] or event["id"] in events or event["characterId"] not in ids or event["status"] not in {"planned", "active", "completed"}:
            _bad()
        _text(event["title"], 200, True); _text(event["scene"], 1000, True); _int(event["createdAt"]); _int(event["updatedAt"])
        events[event["id"]] = event
    if sum(event["status"] == "active" for event in events.values()) > 1:
        _bad()
    if active["eventId"]:
        event = events.get(active["eventId"])
        if not event or event["characterId"] != active["characterId"] or event["status"] != "active" or active["channel"] != "stage":
            _bad()
    pending, turn_ids = 0, set()
    for turn in game["turns"]:
        _fields(turn, ("id", "requestId", "characterId", "channel", "eventId", "userText", "reply", "canonicalMessageId", "status", "error", "archived", "createdAt", "updatedAt"))
        for key in ("id", "requestId", "eventId", "canonicalMessageId"):
            _id(turn[key], key in ("eventId", "canonicalMessageId"))
        if turn["id"] in turn_ids or turn["requestId"] in turns or turn["characterId"] not in ids or turn["channel"] not in channels or turn["status"] not in {"pending", "completed", "interrupted", "uncertain"} or not isinstance(turn["archived"], bool):
            _bad()
        _text(turn["userText"], nonempty=True); _text(turn["reply"]); _text(turn["error"], 4000)
        _int(turn["createdAt"]); _int(turn["updatedAt"])
        if turn["status"] == "completed":
            if not turn["reply"].strip() or not turn["canonicalMessageId"]:
                _bad()
        elif turn["reply"] or turn["canonicalMessageId"] or turn["archived"]:
            _bad()
        if turn["eventId"] and (turn["channel"] != "stage" or events.get(turn["eventId"], {}).get("characterId") != turn["characterId"]):
            _bad()
        if turn["status"] == "pending":
            pending += 1
            if any(turn[k] != active[k] for k in ("characterId", "channel", "eventId")):
                _bad()
        turns[turn["requestId"]] = turn; turn_ids.add(turn["id"])
    if pending > 1:
        _bad()
    archived = set()
    for memory in game["memories"]:
        _fields(memory, ("requestId", "characterId", "text", "createdAt")); _int(memory["createdAt"])
        turn = turns.get(memory["requestId"])
        if not turn or turn["status"] != "completed" or not turn["archived"] or turn["characterId"] != memory["characterId"] or memory["requestId"] in archived:
            _bad()
        name = next(p["name"] for p in people if p["id"] == turn["characterId"])
        if memory["text"] != f"玩家：{turn['userText']}\n{name}：{turn['reply']}":
            _bad()
        archived.add(memory["requestId"])
    if any(turn["archived"] != (turn["requestId"] in archived) for turn in turns.values()):
        _bad()
    if len(_dump(game).encode()) > MAX_GAME:
        raise ArchiveStorageError("HM-A413", "游戏超过 4 MiB；没有截断剧情", 413)


def validate_bundle(bundle, owner):
    _data(bundle); _fields(bundle, ("version", "game", "checkpoints"))
    if bundle["version"] != 1 or not isinstance(bundle["checkpoints"], list) or len(bundle["checkpoints"]) > 12:
        _bad()
    _game(bundle["game"], owner); ids = set()
    for checkpoint in bundle["checkpoints"]:
        _fields(checkpoint, ("id", "label", "createdAt", "revision", "automatic", "game")); _id(checkpoint["id"])
        _text(checkpoint["label"], 200, True); _int(checkpoint["createdAt"]); _int(checkpoint["revision"])
        if checkpoint["id"] in ids or not isinstance(checkpoint["automatic"], bool):
            _bad()
        _game(checkpoint["game"], owner)
        if checkpoint["game"]["id"] != bundle["game"]["id"] or checkpoint["revision"] != checkpoint["game"]["revision"]:
            _bad()
        ids.add(checkpoint["id"])
    encoded = _dump(bundle)
    if len(encoded.encode()) > MAX_BUNDLE:
        raise ArchiveStorageError("HM-A413", "备份超过 28 MiB；完整进度仍保存在本机", 413)
    return encoded


def ensure_schema(conn):
    for sql in (
        "CREATE TABLE IF NOT EXISTS homer_archive_games(user_id TEXT NOT NULL,game_id TEXT NOT NULL,version TEXT NOT NULL,bundle_json TEXT NOT NULL,digest TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,game_id))",
        "CREATE TABLE IF NOT EXISTS homer_archive_commits(user_id TEXT NOT NULL,game_id TEXT NOT NULL,commit_id TEXT NOT NULL,digest TEXT NOT NULL,version TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,game_id,commit_id))",
        "CREATE TABLE IF NOT EXISTS homer_archive_backups(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,game_id TEXT NOT NULL,version TEXT NOT NULL,bundle_json TEXT NOT NULL,created_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS homer_archive_backup_scope ON homer_archive_backups(user_id,game_id,created_at)",
    ):
        conn.execute(sql)


def _bindings(store, bundle, owner):
    resolve = getattr(store, "resolve_local_app_id", lambda value: value)
    checked = set()
    for game in [bundle["game"]] + [cp["game"] for cp in bundle["checkpoints"]]:
        for person in game["characters"]:
            key = (person["appId"], person["conversationId"])
            if key in checked:
                continue
            checked.add(key)
            if not person["conversationId"]:
                raise ArchiveStorageError("HM-A404", "人物专用会话未建立", 404)
            row = store.conn.execute("SELECT app_id FROM conversations WHERE user_id=? AND id=?", (owner, person["conversationId"])).fetchone()
            if not row or resolve(str(row["app_id"])) != resolve(person["appId"]):
                raise ArchiveStorageError("HM-A404", "人物会话不存在或不属于当前账号", 404)


def write_game(store, owner, body):
    _fields(body, ("game_id", "expected_version", "commit_id", "bundle"))
    game_id, expected, commit = body["game_id"], body["expected_version"], body["commit_id"]
    _id(game_id)
    if not isinstance(expected, str) or (expected and not VERSION.fullmatch(expected)) or not isinstance(commit, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", commit):
        _bad()
    encoded = validate_bundle(body["bundle"], owner)
    if body["bundle"]["game"]["id"] != game_id:
        _bad()
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    with store.lock:
        conn = store.conn
        # A nested savepoint is not a durable commit. Never acknowledge a cloud
        # backup inside somebody else's unfinished transaction or commit it.
        if conn.in_transaction:
            raise ArchiveStorageError("HM-A503", "云备份数据库忙，本机进度已保留，请稍后重试", 503)
        conn.execute("SAVEPOINT homer_archive_write")
        try:
            ensure_schema(conn); _bindings(store, body["bundle"], owner)
            receipt = conn.execute("SELECT digest,version FROM homer_archive_commits WHERE user_id=? AND game_id=? AND commit_id=?", (owner, game_id, commit)).fetchone()
            if receipt:
                if receipt["digest"] != digest:
                    raise ArchiveStorageError("HM-A409", "保存编号已用于其他内容，本机进度已保留", 409)
                conn.execute("RELEASE homer_archive_write")
                return {"game_id": game_id, "version": receipt["version"], "duplicate": True}
            old = conn.execute("SELECT * FROM homer_archive_games WHERE user_id=? AND game_id=?", (owner, game_id)).fetchone()
            if (old["version"] if old else "") != expected:
                raise ArchiveStorageError("HM-A409", "另一台设备已有云端版本，本机与云端均已保留；没有自动覆盖", 409)
            now, version = int(time.time()*1000), uuid.uuid4().hex
            if old:
                conn.execute("INSERT INTO homer_archive_backups VALUES(?,?,?,?,?,?)", (uuid.uuid4().hex, owner, game_id, old["version"], old["bundle_json"], now))
                conn.execute("DELETE FROM homer_archive_backups WHERE user_id=? AND game_id=? AND id NOT IN (SELECT id FROM homer_archive_backups WHERE user_id=? AND game_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5)", (owner, game_id, owner, game_id))
            conn.execute("INSERT INTO homer_archive_games VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,game_id) DO UPDATE SET version=excluded.version,bundle_json=excluded.bundle_json,digest=excluded.digest,updated_at=excluded.updated_at", (owner, game_id, version, encoded, digest, now))
            conn.execute("INSERT INTO homer_archive_commits VALUES(?,?,?,?,?,?)", (owner, game_id, commit, digest, version, now))
            conn.execute("DELETE FROM homer_archive_commits WHERE user_id=? AND game_id=? AND commit_id NOT IN (SELECT commit_id FROM homer_archive_commits WHERE user_id=? AND game_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)", (owner, game_id, owner, game_id))
            conn.execute("RELEASE homer_archive_write")
            return {"game_id": game_id, "version": version, "duplicate": False}
        except BaseException:
            conn.execute("ROLLBACK TO homer_archive_write"); conn.execute("RELEASE homer_archive_write"); raise


def read_games(store, owner, game_id="", page=1):
    with store.lock:
        conn = store.conn; conn.execute("SAVEPOINT homer_archive_read")
        try:
            ensure_schema(conn)
            if game_id:
                _id(game_id)
                row = conn.execute("SELECT * FROM homer_archive_games WHERE user_id=? AND game_id=?", (owner, game_id)).fetchone()
                if not row:
                    raise ArchiveStorageError("HM-A404", "游戏备份不存在或无权限", 404)
                bundle = json.loads(row["bundle_json"]); validate_bundle(bundle, owner)
                result = {"game_id": game_id, "version": row["version"], "bundle": bundle}
            else:
                if not isinstance(page, int) or not 1 <= page <= 1000:
                    _bad()
                total = conn.execute("SELECT COUNT(*) FROM homer_archive_games WHERE user_id=?", (owner,)).fetchone()[0]
                rows = conn.execute("SELECT game_id,version,updated_at FROM homer_archive_games WHERE user_id=? ORDER BY updated_at DESC,game_id LIMIT 30 OFFSET ?", (owner, (page-1)*30)).fetchall()
                result = {"items": [{"id": r["game_id"], "version": r["version"], "updatedAt": r["updated_at"]} for r in rows], "page": page, "pages": max(1, (total+29)//30), "total": total}
            conn.execute("RELEASE homer_archive_read"); return result
        except BaseException:
            conn.execute("ROLLBACK TO homer_archive_read"); conn.execute("RELEASE homer_archive_read"); raise
