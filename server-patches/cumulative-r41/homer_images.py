"""Private, durable image tasks. Provider work never holds the billing lock."""
import base64
import io
import ipaddress
import json
import socket
import threading
import time
import uuid
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

KEY = 'homer_image_providers_v1'
MAX_BYTES = 16 * 1024 * 1024
_services = {}
_services_lock = threading.Lock()


class ImageError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def endpoint(value):
    url = str(value or '').strip().rstrip('/')
    p = urlparse(url)
    if p.scheme != 'https' or not p.hostname or p.username or p.password or p.query or p.fragment:
        raise ImageError('API 地址必须为不含账号和查询参数的 HTTPS 地址')
    if p.port not in (None, 443):
        raise ImageError('API 地址仅支持 HTTPS 标准端口')
    addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ImageError('不允许连接本机或内网地址')
    return url


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ImageError('图片服务重定向被拒绝', 502)


def verified_image(raw):
    # Installed through requirements-images.txt. Decode/re-encode to strip metadata
    # and reject HTML, SVG, truncated files and decompression bombs.
    from PIL import Image
    if not raw or len(raw) > MAX_BYTES:
        raise ImageError('图片大小无效', 502)
    with Image.open(io.BytesIO(raw)) as img:
        if img.format not in ('PNG', 'JPEG', 'WEBP') or img.width * img.height > 20_000_000:
            raise ImageError('图片格式或尺寸无效', 502)
        img.load()
        out = io.BytesIO()
        img.convert('RGB').save(out, format='JPEG', quality=92)
        if out.tell() > MAX_BYTES:
            raise ImageError('图片过大', 502)
        return out.getvalue(), 'image/jpeg'


def generate(prompt, config):
    base = endpoint(config['base_url'])
    url = base if base.endswith('/images/generations') else base + '/images/generations'
    payload = dict(model=config['model'], prompt=prompt, n=1, size=config['size'])
    if config.get('quality'):
        payload['quality'] = config['quality']
    req = Request(url, data=json.dumps(payload).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + config['api_key'], 'Content-Type': 'application/json', 'Accept': 'application/json'})
    opener = build_opener(NoRedirect())
    with opener.open(req, timeout=120) as response:
        raw = response.read(MAX_BYTES * 2 + 1)
    if len(raw) > MAX_BYTES * 2:
        raise ImageError('图片响应过大', 502)
    data = json.loads(raw)
    if data.get('error') or not isinstance(data.get('data'), list) or not data['data']:
        raise ImageError('图片服务未返回图片', 502)
    item = data['data'][0]
    if item.get('b64_json'):
        blob = base64.b64decode(item['b64_json'], validate=True)
    else:
        image_url = str(item.get('url') or '')
        # Signed CDN URLs may have a query; validate origin separately and never
        # forward the model API credential to the returned image host.
        parsed = urlparse(image_url)
        endpoint(parsed._replace(query='', fragment='').geturl())
        with opener.open(Request(image_url, headers={'Accept': 'image/*'}), timeout=45) as response:
            blob = response.read(MAX_BYTES + 1)
    return verified_image(blob)


def service(store):
    with _services_lock:
        if store not in _services:
            _services[store] = ImageService(store)
        return _services[store]


class ImageService:
    def __init__(self, store, generator=generate):
        self.store, self.generator = store, generator
        self.slots = threading.BoundedSemaphore(4)
        with store.lock:
            store.conn.execute('''CREATE TABLE IF NOT EXISTS homer_image_tasks(
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL, request_id TEXT NOT NULL, provider_id TEXT NOT NULL,
                provider_name TEXT NOT NULL, prompt TEXT NOT NULL, cost INTEGER NOT NULL,
                status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', image BLOB, mime TEXT,
                created_at INTEGER NOT NULL, UNIQUE(user_id, request_id))''')
            store.conn.execute('CREATE INDEX IF NOT EXISTS idx_homer_images_history ON homer_image_tasks(user_id,conversation_id,created_at DESC)')
            store.conn.execute("UPDATE homer_image_tasks SET status='failed',error='服务已重启，本次未扣积分，请重新生成' WHERE status='running'")
            store.conn.commit()

    def providers(self, admin=False, secrets=False):
        saved = self.store.get_api_settings_raw()
        raw = saved.get(KEY)
        if raw is None:
            old = self.store.image_model_settings(include_secret=True)
            rows = [dict(old, id='legacy-image', cost_points=0)] if old.get('base_url') else []
        else:
            rows = json.loads(raw) if raw else []
        if secrets:
            return rows
        if admin:
            return [{**{k: v for k, v in r.items() if k != 'api_key'}, 'has_api_key': bool(r.get('api_key'))} for r in rows]
        return [{k: r.get(k) for k in ('id', 'name', 'memo', 'cost_points')} for r in rows if r.get('enabled') and r.get('api_key')]

    def save_providers(self, rows, actor):
        if not isinstance(rows, list) or len(rows) > 100:
            raise ImageError('模型列表无效，最多100项')
        existing = {r['id']: r for r in self.providers(secrets=True)}
        clean, ids = [], set()
        for r in rows:
            if not isinstance(r, dict):
                raise ImageError('模型配置无效')
            rid = str(r.get('id') or uuid.uuid4().hex)[:80]
            if rid in ids:
                raise ImageError('模型标识重复')
            ids.add(rid)
            key = str(r.get('api_key') or existing.get(rid, {}).get('api_key') or '').strip()
            if r.get('clear_api_key'):
                key = ''
            name, model = str(r.get('name') or '').strip()[:120], str(r.get('model') or '').strip()[:160]
            if not name or not model:
                raise ImageError('请填写展示名称和模型标识')
            try:
                cost = int(r.get('cost_points', 0))
            except (TypeError, ValueError):
                raise ImageError('积分必须为整数')
            if cost < 0 or cost > 1000000:
                raise ImageError('积分超出范围')
            base = endpoint(r.get('base_url'))
            if r.get('enabled') and not key:
                raise ImageError('启用前请配置密钥')
            clean.append(dict(id=rid, name=name, model=model, base_url=base, api_key=key,
                              enabled=bool(r.get('enabled')), cost_points=cost,
                              size=str(r.get('size') or '1024x1024')[:40], quality=str(r.get('quality') or '')[:40],
                              memo=str(r.get('memo') or '')[:200]))
        s = self.store
        with s.lock:
            try:
                s.conn.execute('INSERT INTO api_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
                               (KEY, json.dumps(clean), int(time.time()*1000)))
                s.conn.execute('INSERT INTO user_events(user_id,event_type,summary,payload_json,created_at) VALUES(?,?,?,?,?)',
                               (actor, 'image_model_settings', '更新生图模型', json.dumps({'count': len(clean)}), int(time.time()*1000)))
                s.conn.commit()
            except Exception:
                s.conn.rollback()
                raise
        return self.providers(admin=True)

    def history(self, user, conversation):
        if not self.store.get_conversation(conversation, user):
            raise ImageError('会话不存在', 404)
        with self.store.lock:
            return [dict(r) for r in self.store.conn.execute('''SELECT t.id,t.message_id,t.provider_name,t.cost,t.status,t.error,t.created_at
                FROM homer_image_tasks t JOIN messages m ON m.id=t.message_id AND m.user_id=t.user_id
                WHERE t.user_id=? AND t.conversation_id=? ORDER BY t.created_at DESC LIMIT 100''', (user, conversation))]

    def image(self, user, task):
        with self.store.lock:
            row = self.store.conn.execute('''SELECT t.image,t.mime FROM homer_image_tasks t JOIN messages m ON m.id=t.message_id AND m.user_id=t.user_id
                JOIN conversations c ON c.id=t.conversation_id AND c.user_id=t.user_id
                WHERE t.id=? AND t.user_id=? AND t.status='succeeded' ''', (task, user)).fetchone()
            if not row:
                raise ImageError('图片不存在', 404)
            return {'data_url': 'data:' + row['mime'] + ';base64,' + base64.b64encode(row['image']).decode()}

    def create(self, user, body):
        if not isinstance(body, dict):
            raise ImageError('请求无效')
        prompt = str(body.get('text') or '').strip()
        request_id = str(body.get('request_id') or '')
        conv, msg = str(body.get('conversation_id') or ''), str(body.get('message_id') or '')
        if not prompt or len(prompt.encode()) > 12000 or not 8 <= len(request_id) <= 100:
            raise ImageError('请输入图片内容（最多12000 UTF-8字节）')
        s = self.store
        with s.lock:
            previous = s.conn.execute('SELECT * FROM homer_image_tasks WHERE user_id=? AND request_id=?', (user, request_id)).fetchone()
            if previous:
                if (previous['conversation_id'],previous['message_id'],previous['prompt'],previous['provider_id']) != (conv,msg,prompt,str(body.get('provider_id') or '')):
                    raise ImageError('重复请求内容不一致', 409)
                return {'id': previous['id'], 'status': previous['status']}
            message = s.get_message(msg, user)
            if not message or message['conversation_id'] != conv or not s.get_conversation(conv, user):
                raise ImageError('目标消息尚未保存或已删除，请稍后重试', 404)
            provider = next((r for r in self.providers(secrets=True) if r['id'] == body.get('provider_id') and r.get('enabled') and r.get('api_key')), None)
            if not provider:
                raise ImageError('该生图模型已停用，请重新选择', 409)
            cost = int(provider.get('cost_points') or 0)
            if 'expected_cost' in body and body['expected_cost'] != cost:
                raise ImageError('模型积分已调整，请关闭弹窗重新选择并确认费用', 409)
            if cost:
                try: s.require_credit_points(user, cost)
                except ValueError: raise ImageError('积分不足，请选择其他模型或补充积分', 402)
            if s.conn.execute("SELECT 1 FROM homer_image_tasks WHERE user_id=? AND status='running'", (user,)).fetchone():
                raise ImageError('已有图片正在生成，请等待完成', 429)
            if not self.slots.acquire(blocking=False):
                raise ImageError('生图服务繁忙，请稍后重试', 429)
            task = uuid.uuid4().hex
            try:
                s.conn.execute('''INSERT INTO homer_image_tasks(id,user_id,conversation_id,message_id,request_id,provider_id,provider_name,prompt,cost,status,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,'running',?)''', (task,user,conv,msg,request_id,provider['id'],provider['name'],prompt,cost,int(time.time()*1000)))
                s.conn.commit()
                threading.Thread(target=self.run, args=(task,user,msg,prompt,dict(provider)), daemon=True).start()
            except Exception:
                s.conn.rollback()
                s.conn.execute("UPDATE homer_image_tasks SET status='failed',error='任务未能启动，本次未扣积分' WHERE id=?", (task,))
                s.conn.commit()
                self.slots.release()
                raise
            return {'id': task, 'status': 'running'}

    def run(self, task, user, message, prompt, config):
        s = self.store
        try:
            blob, mime = self.generator(prompt, config)
            with s.lock:
                try:
                    row = s.conn.execute('SELECT * FROM homer_image_tasks WHERE id=?', (task,)).fetchone()
                    if row['status'] != 'running': return
                    if not s.get_message(message, user) or not s.get_conversation(row['conversation_id'], user):
                        raise ImageError('目标消息已删除，本次未扣积分')
                    if row['cost']:
                        s._spend_credit_points_locked(user, row['cost'])
                    s.conn.execute("UPDATE homer_image_tasks SET status='succeeded',image=?,mime=? WHERE id=?", (blob,mime,task))
                    s.conn.execute('INSERT INTO user_events(user_id,event_type,summary,payload_json,created_at) VALUES(?,?,?,?,?)',
                        (user,'image_generation_cost','图片生成',json.dumps({'task_id':task,'points_spent':row['cost']}),int(time.time()*1000)))
                    s.conn.commit()
                except Exception:
                    s.conn.rollback()
                    raise
        except Exception:
            # Never return/log upstream payloads, prompts or credentials.
            with s.lock:
                s.conn.execute("UPDATE homer_image_tasks SET status='failed',error='[HM-I502] 图片未能生成或积分不足，本次未扣积分。请检查余额或更换模型重试。' WHERE id=? AND status='running'", (task,))
                s.conn.commit()
        finally:
            self.slots.release()


def route(store, method, path, query, body, user):
    if not user:
        raise ImageError('请先登录', 401)
    svc = service(store)
    if path == 'admin/api/image-models':
        if not user['is_admin']:
            raise ImageError('仅管理员可配置生图模型', 403)
        if method == 'GET': return {'list': svc.providers(admin=True)}
        if method == 'POST': return {'list': svc.save_providers(body.get('list') if isinstance(body,dict) else None, user['id'])}
    if path == 'console/api/web/images/providers' and method == 'GET':
        return {'list': svc.providers()}
    if path == 'console/api/web/images/tasks' and method == 'POST':
        return svc.create(user['id'], body)
    if path == 'console/api/web/images/history' and method == 'GET':
        return {'list': svc.history(user['id'], (query.get('conversation_id') or [''])[0])}
    if path.startswith('console/api/web/images/content/') and method == 'GET':
        return svc.image(user['id'], path.rsplit('/',1)[-1])
    raise ImageError('接口不存在', 404)
