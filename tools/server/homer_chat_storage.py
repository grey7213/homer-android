"""Transactional complete-history storage. No credentials or provider requests.

Protocol v2: opaque CAS token, idempotent commit, durable previous-snapshot backup.
Messages triggers fence mutations made through legacy edit/rollback routes too.
Only explicit fork creates a second history; conflicts never auto-merge or delete.
"""
import hashlib
import json
import re
import time
import uuid

PROTOCOL = 2
MAX_SNAPSHOT_BYTES = 10_000_000
VERSION_RE = re.compile(r"^[0-9a-f]{32}$")


class ChatStorageError(ValueError):
    def __init__(self, code, message, status=409):
        super().__init__(f"[{code}] {message}")
        self.code, self.status = code, status


def _dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def ensure_schema(conn):
    # Never executescript: it commits an existing transaction before running.
    for sql in (
        "CREATE TABLE IF NOT EXISTS homer_chat_versions (user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(user_id,conversation_id))",
        "CREATE TABLE IF NOT EXISTS homer_chat_commits (user_id TEXT NOT NULL, source_id TEXT NOT NULL, commit_id TEXT NOT NULL, digest TEXT NOT NULL, conversation_id TEXT NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,source_id,commit_id))",
        "CREATE TABLE IF NOT EXISTS homer_chat_backups (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, version TEXT NOT NULL, messages_json TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL)",
        "CREATE INDEX IF NOT EXISTS homer_chat_backup_scope ON homer_chat_backups(user_id,conversation_id,created_at)",
        "CREATE INDEX IF NOT EXISTS homer_chat_receipt_scope ON homer_chat_commits(user_id,source_id,created_at)",
    ):
        conn.execute(sql)
    for event, ref in (("INSERT", "NEW"), ("DELETE", "OLD"), ("UPDATE", "OLD")):
        conn.execute(f"""CREATE TRIGGER IF NOT EXISTS homer_chat_version_{event.lower()}
            AFTER {event} ON messages BEGIN
            INSERT INTO homer_chat_versions(user_id,conversation_id,version)
            VALUES({ref}.user_id,{ref}.conversation_id,lower(hex(randomblob(16))))
            ON CONFLICT(user_id,conversation_id) DO UPDATE SET version=excluded.version;
            END""")
    # Also fence an UPDATE that moves a message to another conversation/owner.
    conn.execute("""CREATE TRIGGER IF NOT EXISTS homer_chat_version_update_destination
        AFTER UPDATE ON messages WHEN NEW.user_id<>OLD.user_id OR NEW.conversation_id<>OLD.conversation_id
        BEGIN INSERT INTO homer_chat_versions(user_id,conversation_id,version)
        VALUES(NEW.user_id,NEW.conversation_id,lower(hex(randomblob(16))))
        ON CONFLICT(user_id,conversation_id) DO UPDATE SET version=excluded.version; END""")


def _version(conn, owner, conv):
    conn.execute("INSERT OR IGNORE INTO homer_chat_versions VALUES(?,?,?)", (owner, conv, uuid.uuid4().hex))
    return conn.execute("SELECT version FROM homer_chat_versions WHERE user_id=? AND conversation_id=?", (owner, conv)).fetchone()[0]


def _conversation(conn, owner, conv, app, resolve=lambda value: value):
    row = conn.execute("SELECT * FROM conversations WHERE user_id=? AND id=?", (owner, conv)).fetchone()
    if not row:
        raise ChatStorageError("HM-S404", "会话不存在或没有访问权限", 404)
    if resolve(str(row["app_id"])) != resolve(app):
        raise ChatStorageError("HM-S409", "会话与角色不匹配")
    return dict(row)


def _messages(conn, owner, conv):
    # Complete source, not a bounded display page. Stable tie order includes rowid.
    rows = conn.execute("SELECT * FROM messages WHERE user_id=? AND conversation_id=? ORDER BY created_at,rowid", (owner, conv)).fetchall()
    return [{"id": r["id"], "role": r["role"], "content": r["content"],
             "created_at": r["created_at"], "swipes": json.loads(r["swipes"] or "[]"),
             "swipe_index": int(r["swipe_index"] or 0)} for r in rows]


def _storage(version, count, unchanged=False):
    return {"protocol": PROTOCOL, "version": version, "complete": True,
            "message_count": count, "unchanged": unchanged}


def read_chat(store, owner, app, conv, client_version=""):
    with store.lock:
        store.conn.execute("SAVEPOINT homer_chat_read")
        try:
            ensure_schema(store.conn)
            _conversation(store.conn, owner, conv, app, getattr(store, "resolve_local_app_id", lambda value: value))
            version = _version(store.conn, owner, conv)
            count = store.conn.execute("SELECT COUNT(*) FROM messages WHERE user_id=? AND conversation_id=?", (owner, conv)).fetchone()[0]
            unchanged = bool(client_version and client_version == version)
            messages = [] if unchanged else _messages(store.conn, owner, conv)
            store.conn.execute("RELEASE homer_chat_read")
            return {"messages": messages, "storage": _storage(version, count, unchanged)}
        except BaseException:
            store.conn.execute("ROLLBACK TO homer_chat_read")
            store.conn.execute("RELEASE homer_chat_read")
            raise


def _normalize(messages, owner, conv):
    if not isinstance(messages, list):
        raise ChatStorageError("HM-S400", "聊天记录格式无效", 400)
    if len(_dump(messages).encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise ChatStorageError("HM-S413", "存档过大，本机进度已保留，请联系管理员", 413)
    # No 500/1000-row truncation. Existing per-message and swipe bounds remain.
    output, seen = [], set()
    base_time = int(time.time()*1000) - max(0, len(messages)-1)
    for index, raw in enumerate(messages):
        if not isinstance(raw, dict):
            raise ChatStorageError("HM-S400", "聊天记录格式无效", 400)
        extra = raw.get("extra") if isinstance(raw.get("extra"), dict) else {}
        role = "system" if raw.get("is_system") is True else "user" if raw.get("is_user") is True else str(raw.get("role") or "assistant")
        if role not in {"user", "assistant", "system"}: role = "assistant"
        content = str(raw.get("mes") if "mes" in raw else raw.get("content") or "")
        swipes = raw.get("swipes") if isinstance(raw.get("swipes"), list) else []
        if len(content) > 500_000 or len(swipes) > 100 or any(len(str(s)) > 500_000 for s in swipes):
            raise ChatStorageError("HM-S413", "消息过大，本机进度已保留", 413)
        swipes = [str(s) for s in swipes]
        try: swipe = int(raw.get("swipe_id", raw.get("swipe_index", 0)) or 0)
        except (ValueError, TypeError): swipe = 0
        swipe = max(0, min(swipe, len(swipes)-1)) if swipes else 0
        if swipes: content = swipes[swipe]
        sync_id = str(raw.get("homer_message_id") or extra.get("homer_message_id") or extra.get("homer_sync_id") or raw.get("id") or "")
        try: mid = str(uuid.UUID(sync_id))
        except (ValueError, AttributeError):
            stable = str(extra.get("homer_sync_id") or raw.get("send_date") or index)
            mid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"homer-sillytavern:{owner}:{conv}:{stable}:{index}"))
        if mid in seen:
            raise ChatStorageError("HM-S400", "消息标识重复，未覆盖云端记录", 400)
        seen.add(mid)
        try: created = int(extra.get("homer_created_at") or raw.get("created_at") or base_time+index)
        except (ValueError, TypeError): created = base_time+index
        output.append({"id":mid,"role":role,"content":content,"created_at":max(1,created),"swipes":swipes,"swipe_index":swipe})
    return output


def write_chat(store, owner, app, conv, messages, *, title="", version="", commit_id="", fork=False):
    owner, app, conv = str(owner), str(app), str(conv)
    # Auth/role access is enforced by the route; never create an unknown original.
    normalized = _normalize(messages, owner, conv)
    title = str(title or "")[:120]
    # Captured request, not normalization-time timestamp defaults: lost-ACK retries
    # must retain the same digest even if the clock advanced.
    digest = hashlib.sha256(_dump({"messages":messages,"title":title,"fork":bool(fork)}).encode()).hexdigest()
    if commit_id and (not isinstance(commit_id,str) or len(commit_id)>200 or not re.fullmatch(r"[A-Za-z0-9._:-]+",commit_id)):
        raise ChatStorageError("HM-S400", "保存标识无效", 400)
    with store.lock:
        conn = store.conn
        conn.execute("SAVEPOINT homer_chat_write")
        try:
            ensure_schema(conn)
            resolve = getattr(store, "resolve_local_app_id", lambda value: value)
            original = _conversation(conn,owner,conv,app,resolve)
            current = _version(conn,owner,conv)
            receipt = conn.execute("SELECT * FROM homer_chat_commits WHERE user_id=? AND source_id=? AND commit_id=?",(owner,conv,commit_id)).fetchone() if commit_id else None
            if receipt:
                if receipt["digest"] != digest:
                    raise ChatStorageError("HM-S409", "保存标识已用于其他内容，未覆盖云端记录")
                target = receipt["conversation_id"]
                _conversation(conn,owner,target,app,resolve)
                if _version(conn,owner,target) != receipt["version"]:
                    raise ChatStorageError("HM-S409", "云端已有较新进度，本机记录已保留")
                result = {"conversation_id":target,"app_id":app,"messages":_messages(conn,owner,target)}
                result.update(message_count=len(result["messages"]),storage=_storage(receipt["version"],len(result["messages"])))
                conn.execute("RELEASE homer_chat_write")
                return result
            old = _messages(conn,owner,conv)
            if not fork and old == normalized and (not title or title == original.get("title")):
                # Legacy opens may acknowledge exactly identical data, but never change it.
                result={"conversation_id":conv,"app_id":app,"messages":old,"message_count":len(old),"storage":_storage(current,len(old))}
                conn.execute("RELEASE homer_chat_write")
                return result
            if not commit_id or (not fork and not VERSION_RE.fullmatch(str(version))):
                raise ChatStorageError("HM-S428", "请更新客户端后保存；本机进度已保留", 428)
            if not fork and version != current:
                raise ChatStorageError("HM-S409", "云端已有较新进度，本机记录已保留")
            source = conv
            now = int(time.time()*1000)
            if fork:
                conv = str(uuid.uuid4())
                copied = dict(original, id=conv, title=(title or original.get("title") or "角色对话")[:100]+" · 本机进度", created_at=now, updated_at=now, last_message="")
                columns = list(copied)
                conn.execute(f"INSERT INTO conversations({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", tuple(copied.values()))
                # Copy existing conversation runtime settings without modifying source.
                tables={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "sillytavern_runtime_states" in tables:
                    for row in conn.execute("SELECT * FROM sillytavern_runtime_states WHERE user_id=? AND conversation_id=?",(owner,source)).fetchall():
                        state=dict(row); state["conversation_id"]=conv
                        if "id" in state: state["id"]=str(uuid.uuid4())
                        keys=list(state)
                        conn.execute(f"INSERT INTO sillytavern_runtime_states({','.join(keys)}) VALUES({','.join('?' for _ in keys)})",tuple(state.values()))
            else:
                conn.execute("INSERT INTO homer_chat_backups VALUES(?,?,?,?,?,?,?)",(str(uuid.uuid4()),owner,conv,current,_dump(old),str(original.get("title") or ""),now))
                # Ten prior snapshots per scope; never prune pending client progress.
                conn.execute("DELETE FROM homer_chat_backups WHERE user_id=? AND conversation_id=? AND id NOT IN (SELECT id FROM homer_chat_backups WHERE user_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10)",(owner,conv,owner,conv))
            conn.execute("DELETE FROM messages WHERE user_id=? AND conversation_id=?",(owner,conv))
            for item in normalized:
                # Message IDs are global primary keys. A fork gets new independent IDs.
                if fork: item=dict(item,id=str(uuid.uuid4()))
                conn.execute("INSERT INTO messages(id,conversation_id,user_id,role,content,created_at,swipes,swipe_index) VALUES(?,?,?,?,?,?,?,?)",(item["id"],conv,owner,item["role"],item["content"],item["created_at"],_dump(item["swipes"]) if item["swipes"] else None,item["swipe_index"]))
            new_version=uuid.uuid4().hex
            conn.execute("INSERT INTO homer_chat_versions VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET version=excluded.version",(owner,conv,new_version))
            saved_title = "" if fork else title
            conn.execute("UPDATE conversations SET title=CASE WHEN ?<>'' THEN ? ELSE title END,last_message=?,updated_at=? WHERE user_id=? AND id=?",(saved_title,saved_title,normalized[-1]["content"][:120] if normalized else "",now,owner,conv))
            conn.execute("INSERT INTO homer_chat_commits VALUES(?,?,?,?,?,?,?)",(owner,source,commit_id,digest,conv,new_version,now))
            # Receipts are small; bounded history, expired retries still fail CAS safely.
            conn.execute("DELETE FROM homer_chat_commits WHERE user_id=? AND source_id=? AND commit_id NOT IN (SELECT commit_id FROM homer_chat_commits WHERE user_id=? AND source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)",(owner,source,owner,source))
            result={"conversation_id":conv,"app_id":app,"messages":_messages(conn,owner,conv),"message_count":len(normalized),"storage":_storage(new_version,len(normalized))}
            conn.execute("RELEASE homer_chat_write")
            return result
        except BaseException:
            conn.execute("ROLLBACK TO homer_chat_write")
            conn.execute("RELEASE homer_chat_write")
            raise
