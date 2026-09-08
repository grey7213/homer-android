"""Public startup notices, with admin-only writes routed by the host server."""
import time
import uuid


def ensure_notification_schema(conn, lock):
    with lock:
        conn.execute('''CREATE TABLE IF NOT EXISTS startup_notifications (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL)''')
        conn.commit()


def notification_payload(body):
    if not isinstance(body, dict):
        raise ValueError('通知内容必须为对象')
    title, content = body.get('title'), body.get('content')
    if not isinstance(title, str) or not title.strip() or len(title.strip()) > 80:
        raise ValueError('通知标题须为 1–80 个字符')
    if not isinstance(content, str) or not content.strip() or len(content.strip()) > 10000:
        raise ValueError('通知正文须为 1–10000 个字符')
    enabled = body.get('enabled', True)
    if not isinstance(enabled, bool):
        raise ValueError('启用状态须为布尔值')
    return title.strip(), content.strip(), int(enabled)


def list_notifications(store, public=False):
    with store.lock:
        rows = store.conn.execute('SELECT * FROM startup_notifications '
            + ('WHERE enabled=1 ' if public else '')
            + 'ORDER BY created_at DESC,id DESC LIMIT 100').fetchall()
    return [{**dict(row), 'enabled': bool(row['enabled'])} for row in rows]


def mutate_notification(store, method, notice_id, body):
    if method not in ('POST', 'PUT', 'DELETE') or (not notice_id and method != 'POST'):
        raise ValueError('不支持的通知操作')
    payload = notification_payload(body) if method != 'DELETE' else None
    with store.lock:
        try:
            store.conn.execute('BEGIN IMMEDIATE')
            existing = store.conn.execute('SELECT id FROM startup_notifications WHERE id=?', (notice_id,)).fetchone() if notice_id else None
            if notice_id and not existing:
                raise LookupError('通知不存在或已删除')
            if method == 'DELETE':
                store.conn.execute('DELETE FROM startup_notifications WHERE id=?', (notice_id,))
            elif existing:
                store.conn.execute('UPDATE startup_notifications SET title=?,content=?,enabled=?,updated_at=? WHERE id=?',
                    (*payload, int(time.time()*1000), notice_id))
            else:
                if store.conn.execute('SELECT COUNT(*) FROM startup_notifications').fetchone()[0] >= 100:
                    raise ValueError('最多保留 100 条通知，请删除旧通知后重试')
                notice_id = str(uuid.uuid4())
                now = int(time.time()*1000)
                store.conn.execute('INSERT INTO startup_notifications VALUES(?,?,?,?,?,?)',
                    (notice_id, *payload, now, now))
            store.conn.commit()
        except Exception:
            store.conn.rollback()
            raise
    return {'id': notice_id, 'deleted': method == 'DELETE'}
