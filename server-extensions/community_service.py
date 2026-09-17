"""Community domain service for the existing authenticated application host.

No web server, login system, or production configuration is created here.
All writes run within the host connection/lock and a request savepoint.
"""
import base64
import csv
import io
import json
import math
import re
import time
import unicodedata
import uuid
from urllib.parse import urlparse
from community_policy import VERSION, CATEGORIES, AGREEMENT, GUIDELINES, DEFAULT_TOPICS


class Rejected(Exception):
    def __init__(self, message, status=400, kind='invalid'):
        super().__init__(message)
        self.status, self.kind = status, kind


def fail(message, status=400, kind='invalid'):
    raise Rejected(message, status, kind)


def string(value, limit=1000, required=False):
    if not isinstance(value, str): fail('输入格式不正确')
    value = value.strip()
    if len(value) > limit or (required and not value): fail('请检查内容长度')
    return value


def integer(value, default=0):
    try: return max(0, min(int(value), 2**53 - 1))
    except (TypeError, ValueError): return default


def safe_url(value):
    if not isinstance(value, str) or len(value) > 2000 or '\\' in value or any(ord(c)<32 for c in value): return ''
    if value.startswith('/') and not value.startswith('//'): return value
    try:
        url = urlparse(value)
        return value if url.scheme == 'https' and url.hostname and not url.username and not url.password else ''
    except ValueError: return ''


def initialize(conn, lock):
    """Additive and repeatable migration; preserves existing community rows."""
    with lock:
        for table, fields in {
            'social_posts': {'status': "TEXT NOT NULL DEFAULT 'published'", 'version': 'INTEGER NOT NULL DEFAULT 1',
                             'pinned': 'INTEGER NOT NULL DEFAULT 0', 'featured': 'INTEGER NOT NULL DEFAULT 0',
                             'locked': 'INTEGER NOT NULL DEFAULT 0', 'tags': "TEXT NOT NULL DEFAULT '[]'", 'video': "TEXT NOT NULL DEFAULT ''"},
            'social_comments': {'status': "TEXT NOT NULL DEFAULT 'published'", 'parent_id': 'INTEGER NOT NULL DEFAULT 0',
                                'root_id': 'INTEGER NOT NULL DEFAULT 0', 'images': "TEXT NOT NULL DEFAULT '[]'"},
        }.items():
            names = {r[1] for r in conn.execute('PRAGMA table_info('+table+')')}
            for name, declaration in fields.items():
                if name not in names: conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {declaration}')
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS social_config (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS social_members (user_id TEXT PRIMARY KEY,name TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '',
          bio TEXT NOT NULL DEFAULT '',comments_public INTEGER NOT NULL DEFAULT 1,following_public INTEGER NOT NULL DEFAULT 1,
          notifications INTEGER NOT NULL DEFAULT 1,last_active INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS social_consents (user_id TEXT PRIMARY KEY,version TEXT NOT NULL,accepted_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS social_blocks (user_id TEXT NOT NULL,target_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,target_id));
        CREATE TABLE IF NOT EXISTS social_sanctions (id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,until_at INTEGER NOT NULL,
          category TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS social_sanctions_user ON social_sanctions(user_id,revoked,until_at);
        CREATE TABLE IF NOT EXISTS social_cases (id INTEGER PRIMARY KEY,object_type TEXT NOT NULL,object_id TEXT NOT NULL,
          reporter TEXT NOT NULL,category TEXT NOT NULL,reason TEXT NOT NULL,snapshot TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',resolution TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(object_type,object_id,reporter));
        CREATE TABLE IF NOT EXISTS social_appeals (id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,sanction_id INTEGER NOT NULL,
          reason TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',resolution TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,UNIQUE(user_id,sanction_id));
        CREATE TABLE IF NOT EXISTS social_audit (id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,object_type TEXT NOT NULL,
          object_id TEXT NOT NULL,reason TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS social_rules (id INTEGER PRIMARY KEY,term TEXT NOT NULL,category TEXT NOT NULL,action TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,UNIQUE(term,category));
        CREATE TABLE IF NOT EXISTS social_notices (id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,
          post_id TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',read_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
          event_key TEXT NOT NULL,UNIQUE(user_id,event_key));
        CREATE INDEX IF NOT EXISTS social_notices_user ON social_notices(user_id,read_at,id DESC);
        CREATE TABLE IF NOT EXISTS social_comment_likes (comment_id INTEGER NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(comment_id,user_id));
        CREATE TABLE IF NOT EXISTS social_versions (post_id INTEGER NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,
          created_at INTEGER NOT NULL,PRIMARY KEY(post_id,version));
        CREATE TABLE IF NOT EXISTS social_refs (object_type TEXT NOT NULL,object_id TEXT NOT NULL,public_id TEXT NOT NULL,PRIMARY KEY(object_type,object_id,public_id));
        CREATE TABLE IF NOT EXISTS social_topics (id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,description TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS social_announcements (id INTEGER PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,
          start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS social_activity (day TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(day,user_id));
        CREATE TABLE IF NOT EXISTS social_feed_snapshots (token TEXT PRIMARY KEY,user_id TEXT NOT NULL,filters TEXT NOT NULL,
          ids TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS social_rate (user_id TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS social_history (user_id TEXT NOT NULL,post_id INTEGER NOT NULL,viewed_at INTEGER NOT NULL,PRIMARY KEY(user_id,post_id));
        CREATE INDEX IF NOT EXISTS social_rate_scope ON social_rate(user_id,action,at);
        ''')
        conn.execute("INSERT OR IGNORE INTO social_config VALUES('mode','open')")
        # One-time public launch; later operator closures must survive restarts.
        if not conn.execute("SELECT 1 FROM social_config WHERE key='r8_public_launch'").fetchone():
            conn.execute("UPDATE social_config SET value='open' WHERE key='mode' AND value='internal'")
            conn.execute("INSERT INTO social_config VALUES('r8_public_launch','1')")
        conn.execute("INSERT OR IGNORE INTO social_config VALUES('testers','[]')")
        if not conn.execute("SELECT 1 FROM social_config WHERE key='r5_initialized'").fetchone():
            for i, name in enumerate(DEFAULT_TOPICS):
                conn.execute('INSERT OR IGNORE INTO social_topics(name,position) VALUES(?,?)', (name,i))
            for term,category in [('免费代开发票','spam'),('提供你的验证码','phishing'),('出售他人身份证','privacy')]:
                conn.execute("INSERT OR IGNORE INTO social_rules(term,category,action,updated_at) VALUES(?,?,'review',?)",(term,category,int(time.time()*1000)))
            conn.execute('INSERT OR IGNORE INTO social_members(user_id,name) SELECT user_id,author FROM social_posts GROUP BY user_id')
            for legacy in conn.execute('SELECT r.post_id,r.user_id,r.reason,r.created_at,p.content,p.user_id,p.author,p.images FROM social_reports r JOIN social_posts p ON p.id=r.post_id').fetchall():
                pid,reporter,reason,created,content,author_id,author,images=legacy
                snapshot=json.dumps({'id':pid,'user_id':author_id,'author':author,'content':content,'images':images,'version':1},ensure_ascii=False)
                conn.execute("INSERT OR IGNORE INTO social_cases(object_type,object_id,reporter,category,reason,snapshot,created_at,updated_at) VALUES('post',?,?,'legacy',?,?,?,?)",(str(pid),reporter,reason,snapshot,created,created))
            conn.execute("INSERT INTO social_config VALUES('r5_initialized','1')")
        # Retired categories cannot remain active after upgrading an older policy.
        conn.execute('UPDATE social_rules SET enabled=0 WHERE category NOT IN ('+','.join('?'*len(CATEGORIES))+')', tuple(CATEGORIES))
        conn.commit()


class Community:
    def __init__(self, ctx, method, path, query, body):
        self.ctx, self.db = ctx, ctx['conn']
        self.user = ctx.get('user') or {}
        self.uid = str(self.user.get('id') or '')
        self.admin = bool(ctx.get('is_admin'))
        self.now = int(time.time()*1000)
        self.method, self.path, self.query = method.upper(), path, query or {}
        self.body = body if isinstance(body,dict) else {}

    def rows(self, sql, args=()):
        cur=self.db.execute(sql,args)
        names=[d[0] for d in cur.description]
        return [dict(zip(names,r)) for r in cur.fetchall()]

    def one(self, sql, args=()):
        rows=self.rows(sql,args)
        return rows[0] if rows else None

    def count(self, sql, args=()): return self.db.execute(sql,args).fetchone()[0]

    def q(self, key, default=''):
        val=self.query.get(key,default)
        return val[0] if isinstance(val,list) and val else val

    def config(self,key,default=''):
        row=self.one('SELECT value FROM social_config WHERE key=?',(key,))
        return row['value'] if row else default

    def enabled(self):
        mode=self.config('mode','open')
        return mode=='open' or (mode=='internal' and (self.admin or self.uid in json.loads(self.config('testers','[]'))))

    def sanctions(self):
        return self.rows('SELECT id,kind,until_at,category,reason,created_at FROM social_sanctions WHERE user_id=? AND revoked=0 AND (until_at=0 OR until_at>?) ORDER BY id DESC',(self.uid,self.now))

    def blocked(self,target):
        return bool(self.one('SELECT 1 FROM social_blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)',(self.uid,str(target),str(target),self.uid)))

    def block_sql(self, column):
        return f'{column} NOT IN (SELECT target_id FROM social_blocks WHERE user_id=? UNION SELECT user_id FROM social_blocks WHERE target_id=?)'

    def consented(self):
        return bool(self.one('SELECT 1 FROM social_consents WHERE user_id=? AND version=?',(self.uid,VERSION)))

    def interactive(self):
        if self.sanctions(): fail('你暂时无法参与互动，请在“我的 → 设置 → 账号状态”查看原因',403,'muted')

    def rate(self,action,seconds=10,max_count=1):
        self.db.execute('DELETE FROM social_rate WHERE at<?',(self.now-86400000,))
        if self.count('SELECT count(*) FROM social_rate WHERE user_id=? AND action=? AND at>?',(self.uid,action,self.now-seconds*1000))>=max_count:
            fail('操作较频繁，请稍后重试。内容已保留。',429,'rate_limited')
        self.db.execute('INSERT INTO social_rate VALUES(?,?,?)',(self.uid,action,self.now))

    def audit(self,action,typ,oid,reason,before=None,after=None):
        self.db.execute('INSERT INTO social_audit(actor,action,object_type,object_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
            (self.uid,action,typ,str(oid),reason,json.dumps(before or {},ensure_ascii=False),json.dumps(after or {},ensure_ascii=False),self.now))

    def notify(self,target,kind,title,post='',key='',actor=None):
        target=str(target)
        actor=self.uid if actor is None else actor
        if target==actor or (actor and self.blocked(target)): return
        if kind in ('like','follow') and self.one('SELECT 1 FROM social_members WHERE user_id=? AND notifications=0',(target,)): return
        self.db.execute('INSERT OR IGNORE INTO social_notices(user_id,kind,title,post_id,actor,created_at,event_key) VALUES(?,?,?,?,?,?,?)',
            (target,kind,title,str(post),actor,self.now,key or str(uuid.uuid4())))

    def validate_category(self,value):
        if value not in CATEGORIES: fail('请选择有效的违规类型')
        return value

    def object(self,typ,oid,moderator=False):
        table={'post':'social_posts','comment':'social_comments'}.get(typ)
        if not table: fail('内容类型不正确')
        row=self.one('SELECT * FROM '+table+' WHERE id=?',(integer(oid),))
        if not row: fail('内容不存在或暂不可查看',404,'unavailable')
        if moderator and self.admin: return row
        if row['deleted'] or self.blocked(row['user_id']): fail('内容不存在或暂不可查看',404,'unavailable')
        if row['status']!='published' and row['user_id']!=self.uid: fail('内容不存在或暂不可查看',404,'unavailable')
        if typ=='comment': self.object('post',row['post_id'])
        return row

    def media(self,values,limit=9):
        if not isinstance(values,list) or len(values)>limit: fail(f'最多 {limit} 张图片')
        if any(not isinstance(v,str) for v in values): fail('图片地址不正确')
        values=list(dict.fromkeys(values))
        if any(not safe_url(v) for v in values): fail('图片地址不正确')
        # User-provided external media is reviewed, not silently trusted.
        return values

    def screen(self,text,has_media=False):
        normalized=unicodedata.normalize('NFKC',text).casefold()
        matched=[]; action='published'
        for rule in self.rows('SELECT * FROM social_rules WHERE enabled=1'):
            if rule['category'] not in CATEGORIES: continue
            if unicodedata.normalize('NFKC',rule['term']).casefold() in normalized:
                matched.append({'category':rule['category'],'action':rule['action']})
                if rule['action']=='block': action='rejected'
                elif rule['action']=='review' and action!='rejected': action='pending'
        # A configured reviewer may classify images/video/text; unknown results await human review.
        reviewer=self.ctx.get('review_content')
        if reviewer:
            try:
                verdict=reviewer(text=text,has_media=has_media,user_id=self.uid)
                if verdict in ('pending','rejected') and action!='rejected': action=verdict
            except Exception: action='pending'
        elif has_media or re.search(r'https?://',text):
            if action!='rejected': action='pending'
        return {'status':action,'matches':matched}

    def content_data(self,comment=False):
        content=string(self.body.get('content',''),2000 if comment else 10000)
        title='' if comment else string(self.body.get('title',''),80)
        images=self.media(self.body.get('images',[]),3 if comment else 9)
        video='' if comment else string(self.body.get('video',''),2000)
        if video and (not safe_url(video) or images): fail('视频与图片请选择一种发布')
        if not (content or title or images or video): fail('请填写内容或选择媒体')
        refs=list(dict.fromkeys(re.findall(r'(?<![A-Za-z0-9_])ID\s*[:：]\s*([0-9]{1,20})(?![0-9])',content,re.I)))
        if len(refs)>20: fail('每篇最多引用 20 张角色卡')
        mentions=set(re.findall(r'@\{([A-Za-z0-9_-]{1,160})\}',content))
        if len(mentions)>(5 if comment else 10): fail('提及用户数量超过限制')
        if any(self.blocked(target) for target in mentions): fail('无法提及该用户',403)
        if len(re.findall(r'https?://\S+',content))>5: fail('最多添加 5 个外部链接')
        tags=self.body.get('tags',[])
        if not isinstance(tags,list) or len(tags)>5: fail('最多选择 5 个话题')
        tags=list(dict.fromkeys(string(t,24,True) for t in tags))
        topic='' if comment else string(self.body.get('topic',''),40,True)
        if not comment and not self.one('SELECT 1 FROM social_topics WHERE name=? AND enabled=1',(topic,)): fail('请选择有效版块')
        verdict=self.screen(title+'\n'+content,bool(images or video))
        if verdict['status']=='rejected': fail('内容未通过规则检查，请修改后重试',422,'content_rejected')
        return dict(content=content,title=title,images=json.dumps(images),video=video,topic=topic,
                    tags=json.dumps(tags,ensure_ascii=False),status=verdict['status']),refs

    def refs(self,typ,oid,refs):
        self.db.execute('DELETE FROM social_refs WHERE object_type=? AND object_id=?',(typ,str(oid)))
        for ref in refs: self.db.execute('INSERT INTO social_refs VALUES(?,?,?)',(typ,str(oid),ref))

    def resolve(self,ids):
        if not isinstance(ids,list) or len(ids)>20: fail('角色引用数量不正确')
        ids=list(dict.fromkeys(string(x,20,True) for x in ids))
        resolver=self.ctx.get('resolve_cards')
        result={x:{'status':'unavailable'} for x in ids}
        if resolver:
            rows=resolver(ids,self.user)  # Host MUST enforce published/creator visibility.
            for key,card in (rows or {}).items():
                if key in result and card and card.get('visible') is True:
                    result[key]={'status':'available','internal_id':str(card['id']),'name':str(card['name'])}
        return result

    def post_payloads(self,posts):
        if not posts: return []
        ids=[p['id'] for p in posts]; slots=','.join('?'*len(ids))
        def counts(table,where=''):
            return {str(r['post_id']):r['n'] for r in self.rows('SELECT post_id,count(*) n FROM '+table+' WHERE post_id IN ('+slots+') '+where+' GROUP BY post_id',ids)}
        lc=counts('social_likes'); sc=counts('social_saves')
        cc={str(r['post_id']):r['n'] for r in self.rows('SELECT post_id,count(*) n FROM social_comments WHERE post_id IN ('+slots+") AND deleted=0 AND status='published' AND "+self.block_sql('user_id')+' GROUP BY post_id',ids+[self.uid,self.uid])}
        liked={str(r['post_id']) for r in self.rows('SELECT post_id FROM social_likes WHERE user_id=? AND post_id IN ('+slots+')',[self.uid]+ids)}
        saved={str(r['post_id']) for r in self.rows('SELECT post_id FROM social_saves WHERE user_id=? AND post_id IN ('+slots+')',[self.uid]+ids)}
        follows={r['author_id'] for r in self.rows('SELECT author_id FROM social_follows WHERE user_id=?',(self.uid,))}
        result=[]
        for p in posts:
            p=dict(p); pid=str(p['id']); p['id']=pid
            for key in ('images','tags'): p[key]=json.loads(p[key])
            p.update(liked=pid in liked,saved=pid in saved,following=p['user_id'] in follows,
                     like_count=lc.get(pid,0),save_count=sc.get(pid,0),comment_count=cc.get(pid,0),
                     is_owner=p['user_id']==self.uid,can_delete=p['user_id']==self.uid or self.admin)
            if p['is_owner']:
                pending=self.one("SELECT data FROM social_versions WHERE post_id=? AND version=? AND status='pending'",(pid,p['version']))
                if pending and p['status']=='published':
                    data=json.loads(pending['data']);data['images']=json.loads(data['images']);data['tags']=json.loads(data['tags']);p['pending_edit']=data
            for key in ('client_id','deleted'): p.pop(key,None)
            result.append(p)
        return result

    def post_payload(self,p): return self.post_payloads([p])[0]

    def feed(self):
        scope=self.q('scope','public'); sort=self.q('sort','latest')
        topic=string(self.q('topic',''),40); query=string(self.q('q',''),100)
        conditions=['p.deleted=0',self.block_sql('p.user_id')]; args=[self.uid,self.uid]
        conditions.append("(p.status='published' OR p.user_id=?)" if scope=='mine' else "p.status='published'")
        if scope=='mine': args.append(self.uid); conditions.append('p.user_id=?'); args.append(self.uid)
        elif scope=='following': conditions.append('p.user_id IN (SELECT author_id FROM social_follows WHERE user_id=?)'); args.append(self.uid)
        elif scope=='saved': conditions.append('p.id IN (SELECT post_id FROM social_saves WHERE user_id=?)'); args.append(self.uid)
        if topic: conditions.append('p.topic=?'); args.append(topic)
        if self.q('author'): conditions.append('p.user_id=?'); args.append(str(self.q('author')))
        if query: conditions.append('(instr(p.title,?) OR instr(p.content,?) OR instr(p.tags,?))'); args.extend([query]*3)
        if sort=='featured': conditions.append('p.featured=1')
        size=max(1,min(integer(self.q('limit'),20),40)); signature=json.dumps([scope,sort,topic,query,self.q('author')])
        offset=0; token=''; cursor=self.q('cursor')
        self.db.execute('DELETE FROM social_feed_snapshots WHERE expires<?',(self.now,))
        if cursor:
            try: token,position=cursor.split(':'); offset=integer(position)
            except ValueError: fail('列表已更新，请刷新',409,'cursor_expired')
            snap=self.one('SELECT * FROM social_feed_snapshots WHERE token=? AND user_id=? AND filters=? AND expires>?',(token,self.uid,signature,self.now))
            if not snap: fail('列表已更新，请刷新',409,'cursor_expired')
            ids=json.loads(snap['ids'])
        else:
            columns='p.id,p.created_at,p.pinned'
            if sort=='hot': columns+=",(SELECT count(*) FROM social_likes l WHERE l.post_id=p.id) likes,(SELECT count(*) FROM social_saves s WHERE s.post_id=p.id) saves,(SELECT count(DISTINCT user_id) FROM social_comments c WHERE c.post_id=p.id AND c.deleted=0 AND c.status='published') comments"
            candidates=self.rows('SELECT '+columns+' FROM social_posts p WHERE '+' AND '.join(conditions)+' ORDER BY p.pinned DESC,p.id DESC LIMIT 2000',args)
            if sort=='hot': candidates.sort(key=lambda p:(p['pinned'],(p['likes']+2*p['saves']+2*p['comments']+1)/((self.now-p['created_at'])/3600000+2)**1.3,p['id']),reverse=True)
            ids=[r['id'] for r in candidates]; token=uuid.uuid4().hex
            self.db.execute('INSERT INTO social_feed_snapshots VALUES(?,?,?,?,?)',(token,self.uid,signature,json.dumps(ids),self.now+900000))
        page=[]
        while offset<len(ids) and len(page)<size:
            pid=ids[offset]; offset+=1
            rows=self.rows('SELECT p.* FROM social_posts p WHERE p.id=? AND '+' AND '.join(conditions),[pid]+args)
            page.extend(rows)
        return {'list':self.post_payloads(page),'has_more':offset<len(ids),'next_cursor':f'{token}:{offset}' if offset<len(ids) else ''}

    def comment_payload(self,c):
        c=dict(c); c['id']=str(c['id']); c['images']=json.loads(c['images']); c['can_delete']=c['user_id']==self.uid or self.admin
        c['liked']=bool(self.one('SELECT 1 FROM social_comment_likes WHERE comment_id=? AND user_id=?',(c['id'],self.uid)))
        c['like_count']=self.count('SELECT count(*) FROM social_comment_likes WHERE comment_id=?',(c['id'],))
        c['reply_count']=self.count("SELECT count(*) FROM social_comments WHERE root_id=? AND deleted=0 AND status='published' AND "+self.block_sql('user_id'),(c['id'],self.uid,self.uid))
        if c['parent_id']:
            parent=self.one('SELECT user_id,author,deleted FROM social_comments WHERE id=?',(c['parent_id'],))
            c['reply_to']=parent['author'] if parent and not parent['deleted'] and not self.blocked(parent['user_id']) else '已不可查看的评论'
        c.pop('client_id',None); c.pop('deleted',None)
        return c

    def comments(self,pid):
        post=self.object('post',pid)
        root=integer(self.q('root')); page=max(1,integer(self.q('page'),1)); size=10 if root else 20
        conditions=['post_id=?','root_id=?','deleted=0',"(status='published' OR user_id=?)",self.block_sql('user_id')]
        args=[integer(pid),root,self.uid,self.uid,self.uid]
        if root: self.object('comment',root)
        if self.q('author_only')=='1': conditions.append('user_id=?'); args.append(post['user_id'])
        snapshot=integer(self.q('snapshot')) or self.now
        conditions.append('created_at<=?'); args.append(snapshot)
        order='id DESC' if self.q('sort')=='latest' else 'id ASC'
        if self.q('sort')=='hot': order='(SELECT count(*) FROM social_comment_likes l WHERE l.comment_id=social_comments.id) DESC,id ASC'
        where=' AND '.join(conditions)
        total=self.count('SELECT count(*) FROM social_comments WHERE '+where,args)
        pages=max(1,math.ceil(total/size)); page=min(page,pages)
        rows=self.rows('SELECT * FROM social_comments WHERE '+where+' ORDER BY '+order+' LIMIT ? OFFSET ?',args+[size,(page-1)*size])
        return {'list':[self.comment_payload(c) for c in rows],'total':total,'page':page,'pages':pages,'snapshot':snapshot,'has_more':page<pages}

    def send_comment(self,pid):
        post=self.object('post',pid); self.interactive()
        if post['status']!='published' or post['locked']: fail('当前帖子暂不接受评论',403)
        client=string(self.body.get('client_id',''),80,True)
        prior=self.one('SELECT * FROM social_comments WHERE user_id=? AND client_id=?',(self.uid,client))
        if prior:
            if prior['post_id']!=integer(pid): fail('重复请求标识',409)
            return self.comment_payload(prior)
        data,refs=self.content_data(True)
        parent=integer(self.body.get('parent_id')); root=0
        if parent:
            target=self.object('comment',parent)
            if target['post_id']!=integer(pid) or target['status']!='published': fail('回复目标不可用')
            root=target['root_id'] or parent
        self.rate('comment',10,3)
        cur=self.db.execute('INSERT INTO social_comments(post_id,user_id,author,content,created_at,client_id,status,parent_id,root_id,images) VALUES(?,?,?,?,?,?,?,?,?,?)',
             (integer(pid),self.uid,self.name,data['content'],self.now,client,data['status'],parent,root,data['images']))
        cid=cur.lastrowid; self.refs('comment',cid,refs)
        if data['status']=='published':
            receiver=target['user_id'] if parent else post['user_id']
            self.notify(receiver,'reply','你的内容收到了新回复',pid,f'comment:{cid}')
            self.mentions(data['content'],pid,f'comment:{cid}',5)
        return self.comment_payload(self.object('comment',cid))

    def mentions(self,content,pid,key,limit=10):
        # The editor inserts stable user IDs using @{id}; display resolves server-side.
        ids=list(dict.fromkeys(re.findall(r'@\{([A-Za-z0-9_-]{1,160})\}',content)))
        if len(ids)>limit: fail(f'最多提及 {limit} 位用户')
        for target in ids:
            if self.blocked(target): fail('无法提及该用户',403)
            if self.one('SELECT 1 FROM social_members WHERE user_id=?',(target,)):
                self.notify(target,'mention','有人在社区提到了你',pid,key+':mention:'+target)

    def dispatch(self):
        if not self.uid: fail('请先登录',401,'unauthenticated')
        self.name=str(self.user.get('name') or self.user.get('nickname') or '社区用户')[:80]
        if self.path.startswith('admin/'):
            if not self.admin: fail('无管理权限',403)
            return self.manage(self.path[6:])
        if self.path=='bootstrap' and self.method=='GET':
            return {'available':self.enabled(),'mode':self.config('mode'),'consented':self.consented(),'version':VERSION,
                'agreement':AGREEMENT,'guidelines':GUIDELINES,'categories':CATEGORIES,'sanctions':self.sanctions(),
                'is_admin':self.admin,'media':bool(self.ctx.get('media_store'))}
        if self.path=='policy' and self.method=='GET': return {'version':VERSION,'agreement':AGREEMENT,'guidelines':GUIDELINES,'categories':CATEGORIES}
        if self.path=='account-status' and self.method=='GET':
            return {'sanctions':self.rows('SELECT id,kind,until_at,category,reason,created_at,revoked FROM social_sanctions WHERE user_id=? ORDER BY id DESC',(self.uid,)),
                    'appeals':self.rows('SELECT * FROM social_appeals WHERE user_id=? ORDER BY id DESC',(self.uid,))}
        if self.path=='appeals' and self.method=='POST':
            sanction=self.one('SELECT * FROM social_sanctions WHERE id=? AND user_id=?',(integer(self.body.get('sanction_id')),self.uid))
            if not sanction: fail('处罚记录不存在',404)
            reason=string(self.body.get('reason'),2000,True)
            self.db.execute('INSERT OR IGNORE INTO social_appeals(user_id,sanction_id,reason,created_at) VALUES(?,?,?,?)',(self.uid,sanction['id'],reason,self.now))
            return {'submitted':True}
        if self.path=='notifications' and self.consented():
            return self.account_routes()
        if not self.enabled(): fail('社区暂未开放',403,'community_closed')
        if self.path=='consent' and self.method=='POST':
            if self.body.get('version')!=VERSION or self.body.get('agreement') is not True or self.body.get('guidelines') is not True: fail('请阅读并同意当前协议与规范',409,'consent_required')
            self.db.execute('INSERT OR REPLACE INTO social_consents VALUES(?,?,?)',(self.uid,VERSION,self.now))
            return {'accepted':True,'version':VERSION}
        if not self.consented(): fail('请先阅读并同意社区协议',403,'consent_required')
        if any(s['kind']=='ban' for s in self.sanctions()): fail('当前账号已被社区封禁，可在账号状态中申诉',403,'banned')
        self.db.execute('INSERT INTO social_members(user_id,name,avatar,last_active) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,last_active=excluded.last_active',
            (self.uid,self.name,safe_url(self.user.get('avatar_url') or ''),self.now))
        self.db.execute('INSERT OR IGNORE INTO social_activity VALUES(?,?)',(time.strftime('%Y-%m-%d',time.gmtime(self.now/1000+28800)),self.uid))
        if self.path=='topics': return {'list':[r['name'] for r in self.rows('SELECT * FROM social_topics WHERE enabled=1 ORDER BY position,id')]}
        if self.path=='announcements': return {'list':self.rows('SELECT * FROM social_announcements WHERE enabled=1 AND start_at<=? AND (end_at=0 OR end_at>?) ORDER BY id DESC',(self.now,self.now))}
        if self.path=='resolve-cards' and self.method=='POST': return {'cards':self.resolve(self.body.get('ids',[]))}
        if self.path=='preflight' and self.method=='POST': return self.screen(string(self.body.get('content',''),10100))
        if self.path.startswith('media/'):
            self.interactive()
            store=self.ctx.get('media_store')
            if not store: fail('媒体服务暂未接入，请先保存草稿',503,'media_unavailable')
            return store.handle(self.path[6:],self.method,self.body,self.uid)
        if self.path=='posts':
            if self.method=='GET': return self.feed()
            if self.method=='POST':
                self.interactive(); client=string(self.body.get('client_id',''),80,True)
                prior=self.one('SELECT * FROM social_posts WHERE user_id=? AND client_id=?',(self.uid,client))
                if prior:
                    if prior['deleted']: fail('帖子已删除',409)
                    return self.post_payload(prior)
                data,refs=self.content_data(); self.rate('post',60,3)
                # Similar repeated content is held for review, rather than punished automatically.
                if self.one('SELECT 1 FROM social_posts WHERE user_id=? AND content=? AND created_at>?',(self.uid,data['content'],self.now-600000)): data['status']='pending'
                cur=self.db.execute('INSERT INTO social_posts(user_id,author,title,content,topic,images,created_at,updated_at,client_id,status,tags,video) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                    (self.uid,self.name,data['title'],data['content'],data['topic'],data['images'],self.now,self.now,client,data['status'],data['tags'],data['video']))
                pid=cur.lastrowid; self.refs('post',pid,refs)
                self.db.execute('INSERT INTO social_versions VALUES(?,?,?,?,?)',(pid,1,json.dumps(data,ensure_ascii=False),data['status'],self.now))
                if data['status']=='published': self.mentions(data['content'],pid,f'post:{pid}')
                return self.post_payload(self.object('post',pid))
        match=re.fullmatch(r'posts/(\d+)(?:/(comments|like|save|report))?',self.path)
        if match:
            pid=integer(match[1]); action=match[2]; post=self.object('post',pid)
            if not action:
                if self.method=='GET':
                    self.db.execute('INSERT OR REPLACE INTO social_history VALUES(?,?,?)',(self.uid,pid,self.now))
                    self.db.execute('DELETE FROM social_history WHERE user_id=? AND post_id NOT IN (SELECT post_id FROM social_history WHERE user_id=? ORDER BY viewed_at DESC LIMIT 200)',(self.uid,self.uid))
                    return self.post_payload(post)
                if self.method=='DELETE':
                    if post['user_id']!=self.uid and not self.admin: fail('不能删除他人的帖子',403)
                    self.remove('post',pid,string(self.body.get('reason','作者删除'),500,True)); return {'deleted':True}
                if self.method=='PATCH':
                    self.interactive()
                    if post['user_id']!=self.uid: fail('不能编辑他人的帖子',403)
                    if integer(self.body.get('version'))!=post['version']: fail('帖子已更新，请重新打开后编辑',409,'version_conflict')
                    data,refs=self.content_data(); version=post['version']+1
                    self.db.execute('INSERT INTO social_versions VALUES(?,?,?,?,?)',(pid,version,json.dumps(data,ensure_ascii=False),data['status'],self.now))
                    if data['status']=='published' or post['status']!='published': self.apply_version(pid,version,data)
                    else: self.db.execute('UPDATE social_posts SET version=? WHERE id=?',(version,pid))
                    self.refs('post',pid,refs)
                    result=self.post_payload(self.object('post',pid)); result['edit_pending']=data['status']=='pending'; return result
            if action=='comments': return self.comments(pid) if self.method=='GET' else self.send_comment(pid) if self.method=='POST' else fail('方法不支持',405)
            if action in ('like','save') and self.method=='PUT':
                if action=='like': self.interactive()
                if post['status']!='published': fail('该内容尚未公开',403)
                field='liked' if action=='like' else 'saved'; desired=self.body.get(field)
                if not isinstance(desired,bool): fail('状态不正确')
                table='social_likes' if action=='like' else 'social_saves'
                existing=self.one('SELECT 1 FROM '+table+' WHERE post_id=? AND user_id=?',(pid,self.uid))
                if desired:
                    if action=='like': self.db.execute('INSERT OR IGNORE INTO social_likes VALUES(?,?)',(pid,self.uid))
                    else: self.db.execute('INSERT OR IGNORE INTO social_saves VALUES(?,?,?)',(pid,self.uid,self.now))
                else: self.db.execute('DELETE FROM '+table+' WHERE post_id=? AND user_id=?',(pid,self.uid))
                if action=='like' and desired and not existing: self.notify(post['user_id'],'like','你的帖子收到了赞',pid,f'like:{pid}:{self.uid}')
                return self.post_payload(post)
            if action=='report' and self.method=='POST': return self.report('post',pid)
        match=re.fullmatch(r'comments/(\d+)(?:/(like|report))?',self.path)
        if match:
            cid=integer(match[1]); comment=self.object('comment',cid)
            if match[2]=='report' and self.method=='POST': return self.report('comment',cid)
            if match[2]=='like' and self.method=='PUT':
                self.interactive(); desired=self.body.get('liked')
                if comment['status']!='published': fail('该内容尚未公开',403)
                if not isinstance(desired,bool): fail('状态不正确')
                if desired: self.db.execute('INSERT OR IGNORE INTO social_comment_likes VALUES(?,?)',(cid,self.uid))
                else: self.db.execute('DELETE FROM social_comment_likes WHERE comment_id=? AND user_id=?',(cid,self.uid))
                return self.comment_payload(comment)
            if not match[2] and self.method=='DELETE':
                if comment['user_id']!=self.uid and not self.admin: fail('不能删除他人的评论',403)
                self.remove('comment',cid,string(self.body.get('reason','作者删除'),500,True)); return {'deleted':True}
        if self.path=='follow' and self.method=='PUT':
            self.interactive(); target=string(self.body.get('user_id'),160,True); desired=self.body.get('following')
            if target==self.uid or not isinstance(desired,bool) or self.blocked(target): fail('不能关注该用户',403)
            if not self.one('SELECT 1 FROM social_members WHERE user_id=?',(target,)): fail('用户不存在',404)
            if desired:
                self.db.execute('INSERT OR IGNORE INTO social_follows VALUES(?,?)',(self.uid,target))
                self.notify(target,'follow','有人关注了你',key='follow:'+self.uid)
            else: self.db.execute('DELETE FROM social_follows WHERE user_id=? AND author_id=?',(self.uid,target))
            return {'following':desired}
        if self.path in ('blocks','preferences','notifications','search','history') or self.path.startswith('users/'):
            return self.account_routes()
        if self.path=='reports' and self.method=='GET':
            if self.admin: return self.manage('reports')
            return {'list':self.rows('SELECT id,object_type,object_id,category,reason,state,resolution,created_at FROM social_cases WHERE reporter=? ORDER BY id DESC',(self.uid,))}
        fail('接口不存在',404)

    def apply_version(self,pid,version,data):
        self.db.execute('UPDATE social_posts SET title=?,content=?,topic=?,images=?,tags=?,video=?,status=?,version=?,updated_at=? WHERE id=?',
            (data['title'],data['content'],data['topic'],data['images'],data['tags'],data['video'],data['status'],version,self.now,pid))

    def remove(self,typ,oid,reason):
        row=self.object(typ,oid,moderator=self.admin)
        self.db.execute('UPDATE '+('social_posts' if typ=='post' else 'social_comments')+' SET deleted=1 WHERE id=?',(oid,))
        self.audit('delete',typ,oid,reason,{'deleted':row['deleted']},{'deleted':1})
        if row['user_id']!=self.uid: self.notify(row['user_id'],'system','你的内容已被移除：'+reason,key=f'delete:{typ}:{oid}',actor='')

    def report(self,typ,oid):
        obj=self.object(typ,oid); category=self.validate_category(self.body.get('category'))
        reason=string(self.body.get('reason',''),500)
        prior=self.one('SELECT id FROM social_cases WHERE object_type=? AND object_id=? AND reporter=?',(typ,str(oid),self.uid))
        if prior: return {'reported':True,'duplicate':True,'id':prior['id']}
        self.rate('report',60,10)
        snap={k:obj[k] for k in ('id','user_id','author','content','images','status')}; snap['version']=obj.get('version',1)
        cur=self.db.execute('INSERT INTO social_cases(object_type,object_id,reporter,category,reason,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            (typ,str(oid),self.uid,category,reason,json.dumps(snap,ensure_ascii=False),self.now,self.now))
        return {'reported':True,'duplicate':False,'id':cur.lastrowid}

    def account_routes(self):
        if self.path=='history':
            if self.method=='DELETE':
                self.db.execute('DELETE FROM social_history WHERE user_id=?',(self.uid,));return {'deleted':True}
            if self.method!='GET': fail('方法不支持',405)
            rows=self.rows("SELECT p.* FROM social_history h JOIN social_posts p ON p.id=h.post_id WHERE h.user_id=? AND p.deleted=0 AND p.status='published' AND "+self.block_sql('p.user_id')+' ORDER BY h.viewed_at DESC LIMIT 200',(self.uid,self.uid,self.uid))
            return {'list':self.post_payloads(rows)}
        if self.path=='blocks':
            if self.method=='GET': return {'list':self.rows('SELECT b.target_id,m.name,b.created_at FROM social_blocks b LEFT JOIN social_members m ON m.user_id=b.target_id WHERE b.user_id=?',(self.uid,))}
            if self.method!='PUT': fail('方法不支持',405)
            target=string(self.body.get('user_id'),160,True); desired=self.body.get('blocked')
            if not isinstance(desired,bool) or target==self.uid: fail('拉黑状态不正确')
            if desired:
                self.db.execute('INSERT OR IGNORE INTO social_blocks VALUES(?,?,?)',(self.uid,target,self.now))
                self.db.execute('DELETE FROM social_follows WHERE (user_id=? AND author_id=?) OR (user_id=? AND author_id=?)',(self.uid,target,target,self.uid))
                self.db.execute('DELETE FROM social_notices WHERE (user_id=? AND actor=?) OR (user_id=? AND actor=?)',(self.uid,target,target,self.uid))
            else: self.db.execute('DELETE FROM social_blocks WHERE user_id=? AND target_id=?',(self.uid,target))
            return {'blocked':desired}
        if self.path=='preferences':
            if self.method not in ('GET','PUT'): fail('方法不支持',405)
            if self.method=='PUT':
                for key in ('comments_public','following_public','notifications'):
                    if key in self.body:
                        if not isinstance(self.body[key],bool): fail('设置格式不正确')
                        self.db.execute('UPDATE social_members SET '+key+'=? WHERE user_id=?',(int(self.body[key]),self.uid))
                if 'bio' in self.body: self.db.execute('UPDATE social_members SET bio=? WHERE user_id=?',(string(self.body['bio'],300),self.uid))
            return self.one('SELECT bio,comments_public,following_public,notifications FROM social_members WHERE user_id=?',(self.uid,))
        if self.path=='notifications':
            if self.method=='PUT':
                ids=self.body.get('ids',[])
                if self.body.get('all') is True: self.db.execute('UPDATE social_notices SET read_at=? WHERE user_id=?',(self.now,self.uid))
                elif isinstance(ids,list) and len(ids)<=100:
                    for nid in ids: self.db.execute('UPDATE social_notices SET read_at=? WHERE id=? AND user_id=?',(self.now,integer(nid),self.uid))
                return {'updated':True}
            if self.method=='DELETE':
                for nid in self.body.get('ids',[])[:100]: self.db.execute('DELETE FROM social_notices WHERE id=? AND user_id=?',(integer(nid),self.uid))
                return {'deleted':True}
            conditions=['user_id=?']; args=[self.uid]
            kind=self.q('kind')
            if kind: conditions.append('kind=?'); args.append(kind)
            if self.q('cursor'): conditions.append('id<?'); args.append(integer(self.q('cursor')))
            items=self.rows('SELECT * FROM social_notices WHERE '+' AND '.join(conditions)+' ORDER BY id DESC LIMIT 41',args)
            more=len(items)>40; items=items[:40]
            for item in items:
                if item['post_id']:
                    try: self.object('post',item['post_id'])
                    except Rejected: item['post_id']=''; item['title']='相关内容已不可查看'
            return {'list':items,'has_more':more,'next_cursor':items[-1]['id'] if more else '',
                    'unread':self.count('SELECT count(*) FROM social_notices WHERE user_id=? AND read_at=0',(self.uid,))}
        if self.path=='search':
            query=string(self.q('q'),100); typ=self.q('type','posts')
            if typ=='posts': return self.feed()
            if typ=='topics': return {'list':self.rows('SELECT name,description FROM social_topics WHERE enabled=1 AND instr(name,?) ORDER BY position LIMIT 40',(query,))}
            return {'list':self.rows('SELECT user_id,name,avatar,bio FROM social_members WHERE (instr(name,?) OR user_id=?) AND '+self.block_sql('user_id')+' LIMIT 40',(query,query,self.uid,self.uid))}
        match=re.fullmatch(r'users/([A-Za-z0-9_-]+)(?:/(comments|following|followers))?',self.path)
        if match:
            target=match[1]
            if self.blocked(target): fail('该用户暂不可查看',404)
            profile=self.one('SELECT * FROM social_members WHERE user_id=?',(target,))
            if not profile: fail('用户暂不可查看',404)
            action=match[2]
            if action=='comments':
                if target!=self.uid and not profile['comments_public']: return {'list':[],'private':True}
                items=self.rows("SELECT c.* FROM social_comments c JOIN social_posts p ON p.id=c.post_id WHERE c.user_id=? AND c.deleted=0 AND p.deleted=0 AND c.status='published' AND p.status='published' AND "+self.block_sql('p.user_id')+' ORDER BY c.id DESC LIMIT 40',(target,self.uid,self.uid))
                return {'list':[self.comment_payload(c) for c in items]}
            if action in ('following','followers'):
                if target!=self.uid and not profile['following_public']: return {'list':[],'private':True}
                join='f.author_id=m.user_id' if action=='following' else 'f.user_id=m.user_id'
                where='f.user_id=?' if action=='following' else 'f.author_id=?'
                return {'list':self.rows('SELECT m.user_id,m.name,m.avatar FROM social_follows f JOIN social_members m ON '+join+' WHERE '+where+' AND '+self.block_sql('m.user_id')+' LIMIT 100',(target,self.uid,self.uid))}
            profile.pop('last_active',None); profile.pop('notifications',None)
            profile['posts']=self.count("SELECT count(*) FROM social_posts WHERE user_id=? AND deleted=0 AND status='published'",(target,))
            profile['likes']=self.count("SELECT count(*) FROM social_likes l JOIN social_posts p ON p.id=l.post_id WHERE p.user_id=? AND p.deleted=0 AND p.status='published'",(target,))
            profile['following_count']=self.count('SELECT count(*) FROM social_follows WHERE user_id=?',(target,))
            profile['followers_count']=self.count('SELECT count(*) FROM social_follows WHERE author_id=?',(target,))
            profile['following']=bool(self.one('SELECT 1 FROM social_follows WHERE user_id=? AND author_id=?',(self.uid,target)))
            days=self.count('SELECT count(*) FROM social_activity WHERE user_id=?',(target,))
            profile['badge']='持续参与' if days>=7 else '新朋友'
            return profile
        fail('接口不存在',404)

    def manage(self,path):
        # Existing host is_admin is the authority. No client role/preview parameter is trusted.
        b=self.body; method=self.method; limit=max(1,min(integer(self.q('limit'),40),100)); offset=integer(self.q('offset'))
        if path=='config':
            if method not in ('GET','PUT'): fail('方法不支持',405)
            if method=='PUT':
                mode=b.get('mode')
                if mode not in ('closed','internal','open'): fail('开放状态不正确')
                testers=b.get('testers',[])
                if not isinstance(testers,list) or len(testers)>100: fail('测试账号列表不正确')
                testers=[string(x,160,True) for x in testers]
                before={'mode':self.config('mode'),'testers':self.config('testers')}
                self.db.execute('INSERT OR REPLACE INTO social_config VALUES(?,?)',('mode',mode))
                self.db.execute('INSERT OR REPLACE INTO social_config VALUES(?,?)',('testers',json.dumps(testers)))
                self.audit('configure','community','mode',string(b.get('reason','开放配置调整'),500),before,{'mode':mode,'testers':testers})
            return {'mode':self.config('mode'),'testers':json.loads(self.config('testers','[]')),'categories':CATEGORIES,'version':VERSION}
        if path=='rules/import' and method=='POST':
            rules=b.get('rules')
            if not isinstance(rules,list) or len(rules)>1000: fail('词库最多 1000 条')
            for rule in rules:
                if not isinstance(rule,dict): fail('词库格式不正确')
                term=string(rule.get('term'),100,True); category=self.validate_category(rule.get('category'))
                action=rule.get('action','review')
                if action not in ('review','block','warn'): fail('处理方式不正确')
                self.db.execute('INSERT INTO social_rules(term,category,action,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(term,category) DO UPDATE SET action=excluded.action,enabled=excluded.enabled,updated_at=excluded.updated_at',
                    (term,category,action,int(rule.get('enabled',True) in (True,1)),self.now))
            self.audit('import','rules','', '导入关键词规则',after={'count':len(rules)})
            return {'count':len(rules)}
        if path=='reports' and method=='GET':
            clauses=['1=1']; args=[]
            for key in ('state','category','object_type'):
                if self.q(key): clauses.append(key+'=?'); args.append(str(self.q(key)))
            for key,op in (('from','>='),('to','<=')):
                if self.q(key): clauses.append('created_at'+op+'?'); args.append(integer(self.q(key)))
            rows=self.rows('SELECT * FROM social_cases WHERE '+' AND '.join(clauses)+' ORDER BY CASE category WHEN \'privacy\' THEN 0 WHEN \'phishing\' THEN 0 ELSE 1 END,id DESC LIMIT ? OFFSET ?',args+[limit,offset])
            for r in rows:
                r['snapshot']=json.loads(r['snapshot'])
                r['context']=self.object(r['object_type'],r['object_id'],True)
                if r['object_type']=='comment': r['post']=self.object('post',r['context']['post_id'],True)
            return {'list':rows}
        match=re.fullmatch(r'reports/(\d+)',path)
        if match and method=='PATCH':
            case=self.one('SELECT * FROM social_cases WHERE id=?',(integer(match[1]),))
            if not case: fail('举报不存在',404)
            if case['state'] not in ('pending','processing'): fail('举报已处理，请刷新',409)
            action=b.get('action'); reason=string(b.get('reason'),500,True)
            if action not in ('delete','ignore','claim'): fail('处理方式不正确')
            if action=='delete': self.remove(case['object_type'],case['object_id'],reason)
            state={'delete':'resolved','ignore':'ignored','claim':'processing'}[action]
            if case['actor'] and case['actor']!=self.uid and case['state']=='processing': fail('该举报正在由其他管理员处理',409)
            self.db.execute('UPDATE social_cases SET state=?,resolution=?,actor=?,updated_at=? WHERE id=?',(state,reason,self.uid,self.now,case['id']))
            self.audit(action,'report',case['id'],reason,{'state':case['state']},{'state':state})
            if action!='claim': self.notify(case['reporter'],'report','举报已处理：'+reason,key='report:'+str(case['id']),actor='')
            return {'state':state}
        if path=='content':
            typ=self.q('type','post'); table='social_posts' if typ=='post' else 'social_comments'
            clauses=['1=1']; args=[]
            for key in ('status','user_id'):
                if self.q(key): clauses.append(key+'=?'); args.append(str(self.q(key)))
            if self.q('q'): clauses.append('instr(content,?)>0'); args.append(string(self.q('q'),100))
            if typ=='post' and self.q('topic'): clauses.append('topic=?'); args.append(str(self.q('topic')))
            rows=self.rows('SELECT * FROM '+table+' WHERE '+' AND '.join(clauses)+' ORDER BY id DESC LIMIT ? OFFSET ?',args+[limit,offset])
            for row in rows:
                row.pop('client_id',None)
                if typ=='post': row['pending_versions']=self.rows("SELECT version,data FROM social_versions WHERE post_id=? AND status='pending' ORDER BY version DESC",(row['id'],))
            return {'list':rows}
        match=re.fullmatch(r'content/(post|comment)/(\d+)',path)
        if match and method=='PATCH':
            typ,oid=match[1],integer(match[2]); row=self.object(typ,oid,True); reason=string(b.get('reason'),500,True); action=b.get('action')
            table='social_posts' if typ=='post' else 'social_comments'
            if action=='delete': self.remove(typ,oid,reason)
            elif action in ('approve','reject','restore'):
                status='rejected' if action=='reject' else 'published'
                if typ=='post':
                    version=integer(b.get('version'))
                    if version!=row['version']: fail('内容版本已变化，请重新审核',409)
                    record=self.one('SELECT * FROM social_versions WHERE post_id=? AND version=?',(oid,version))
                    if record:
                        data=json.loads(record['data']); data['status']=status
                        self.db.execute('UPDATE social_versions SET status=? WHERE post_id=? AND version=?',(status,oid,version))
                        if action!='reject' or row['status']!='published': self.apply_version(oid,version,data)
                    else: self.db.execute('UPDATE social_posts SET status=? WHERE id=?',(status,oid))
                else: self.db.execute('UPDATE social_comments SET status=? WHERE id=?',(status,oid))
                if action=='restore': self.db.execute('UPDATE '+table+' SET deleted=0 WHERE id=?',(oid,))
                self.audit(action,typ,oid,reason,{'status':row['status']},{'status':status})
                self.notify(row['user_id'],'system','内容处理结果：'+reason,key=f'review:{typ}:{oid}:{self.now}',actor='')
            elif typ=='post' and action in ('pinned','featured','locked'):
                if not isinstance(b.get('enabled'),bool): fail('状态不正确')
                self.db.execute('UPDATE social_posts SET '+action+'=? WHERE id=?',(int(b['enabled']),oid))
                self.audit(action,typ,oid,reason,{action:row[action]},{action:b['enabled']})
            else: fail('操作不正确')
            return {'updated':True}
        if path=='users' and method=='GET':
            q=string(self.q('q'),100)
            rows=self.rows('SELECT * FROM social_members WHERE instr(name,?) OR instr(user_id,?) ORDER BY last_active DESC LIMIT ? OFFSET ?',(q,q,limit,offset))
            for row in rows:
                row['sanctions']=self.rows('SELECT * FROM social_sanctions WHERE user_id=? ORDER BY id DESC',(row['user_id'],))
                row['recent_posts']=self.rows('SELECT id,title,content,status FROM social_posts WHERE user_id=? ORDER BY id DESC LIMIT 10',(row['user_id'],))
            return {'list':rows}
        if path=='sanctions' and method=='POST':
            target=string(b.get('user_id'),160,True); kind=b.get('kind','mute'); reason=string(b.get('reason'),500,True); category=self.validate_category(b.get('category'))
            if kind not in ('mute','ban','warning'): fail('处罚类型不正确')
            if not self.one('SELECT 1 FROM social_members WHERE user_id=?',(target,)): fail('用户不存在',404)
            days=integer(b.get('days'))
            if days>3650: fail('请输入合理天数')
            until=self.now+days*86400000 if days else 0
            cur=self.db.execute('INSERT INTO social_sanctions(user_id,kind,until_at,category,reason,actor,created_at,revoked) VALUES(?,?,?,?,?,?,?,?)',(target,kind,until,category,reason,self.uid,self.now,1 if kind=='warning' else 0))
            self.audit('sanction','user',target,reason,after={'id':cur.lastrowid,'kind':kind,'until_at':until})
            self.notify(target,'system','账号状态更新：'+reason,key='sanction:'+str(cur.lastrowid),actor='')
            return {'id':cur.lastrowid}
        match=re.fullmatch(r'sanctions/(\d+)/revoke',path)
        if match and method=='POST':
            row=self.one('SELECT * FROM social_sanctions WHERE id=?',(integer(match[1]),)); reason=string(b.get('reason'),500,True)
            if not row: fail('记录不存在',404)
            self.db.execute('UPDATE social_sanctions SET revoked=1 WHERE id=?',(row['id'],)); self.audit('revoke','sanction',row['id'],reason)
            self.notify(row['user_id'],'system','限制已解除：'+reason,key='revoke:'+str(row['id']),actor=''); return {'revoked':True}
        if path=='appeals' and method=='GET': return {'list':self.rows('SELECT * FROM social_appeals ORDER BY id DESC LIMIT ? OFFSET ?',(limit,offset))}
        match=re.fullmatch(r'appeals/(\d+)',path)
        if match and method=='PATCH':
            row=self.one('SELECT * FROM social_appeals WHERE id=?',(integer(match[1]),)); reason=string(b.get('reason'),500,True)
            if not row or row['state']!='pending': fail('申诉已处理或不存在',409)
            state=b.get('state')
            if state not in ('accepted','rejected'): fail('结果不正确')
            self.db.execute('UPDATE social_appeals SET state=?,resolution=?,actor=? WHERE id=?',(state,reason,self.uid,row['id']))
            if state=='accepted': self.db.execute('UPDATE social_sanctions SET revoked=1 WHERE id=?',(row['sanction_id'],))
            self.audit('appeal','appeal',row['id'],reason,after={'state':state})
            self.notify(row['user_id'],'appeal','申诉结果：'+reason,key='appeal:'+str(row['id']),actor=''); return {'state':state}
        if path in ('rules','topics','announcements') or re.fullmatch(r'(rules|topics|announcements)/\d+',path):
            return self.manage_resources(path)
        if path=='logs' and method=='GET':
            clauses=['1=1']; args=[]
            for key in ('actor','action','object_type','object_id'):
                if self.q(key): clauses.append(key+'=?'); args.append(str(self.q(key)))
            rows=self.rows('SELECT * FROM social_audit WHERE '+' AND '.join(clauses)+' ORDER BY id DESC LIMIT ? OFFSET ?',args+[limit,offset])
            if self.q('export')=='csv':
                rows=self.rows('SELECT * FROM social_audit WHERE '+' AND '.join(clauses)+' ORDER BY id DESC',args)
                stream=io.StringIO(); writer=csv.writer(stream); writer.writerow(['操作人','操作','对象类型','对象ID','原因','时间'])
                for row in rows:
                    writer.writerow(["'"+str(row[k]) if str(row[k]).startswith(('=','+','-','@','\t','\r')) else row[k] for k in ('actor','action','object_type','object_id','reason','created_at')])
                self.audit('export','logs','', '导出操作日志'); return {'csv':stream.getvalue()}
            return {'list':rows}
        if path=='stats':
            since=integer(self.q('since'),self.now-30*86400000)
            return {'activity':self.rows('SELECT day,count(*) users FROM social_activity GROUP BY day ORDER BY day DESC LIMIT 30'),
                'posts':self.rows('SELECT status,count(*) count FROM social_posts WHERE created_at>=? GROUP BY status',(since,)),
                'comments':self.rows('SELECT status,count(*) count FROM social_comments WHERE created_at>=? GROUP BY status',(since,)),
                'reports':self.rows('SELECT state,count(*) count FROM social_cases WHERE created_at>=? GROUP BY state',(since,)),
                'violations':self.rows("SELECT category,count(*) count FROM social_cases WHERE state='resolved' AND updated_at>=? GROUP BY category",(since,)),
                'muted':self.count("SELECT count(DISTINCT user_id) FROM social_sanctions WHERE kind='mute' AND revoked=0 AND (until_at=0 OR until_at>?)",(self.now,))}
        fail('管理接口不存在',404)

    def manage_resources(self,path):
        parts=path.split('/'); resource=parts[0]; oid=integer(parts[1]) if len(parts)>1 else 0; b=self.body
        table={'rules':'social_rules','topics':'social_topics','announcements':'social_announcements'}[resource]
        if self.method=='GET': return {'list':self.rows('SELECT * FROM '+table+' ORDER BY id DESC LIMIT 1000')}
        if self.method not in ('POST','PATCH','DELETE'): fail('方法不支持',405)
        reason=string(b.get('reason','配置调整'),500,True)
        if self.method=='DELETE':
            self.db.execute('DELETE FROM '+table+' WHERE id=?',(oid,)); self.audit('delete',resource,oid,reason); return {'deleted':True}
        if resource=='rules':
            values={'term':string(b.get('term'),100,True),'category':self.validate_category(b.get('category')),
                    'action':b.get('action'),'enabled':int(b.get('enabled',True) is True),'updated_at':self.now}
            if values['action'] not in ('review','block','warn'): fail('处理方式不正确')
        elif resource=='topics': values={'name':string(b.get('name'),40,True),'description':string(b.get('description',''),500),'enabled':int(b.get('enabled',True) is True),'position':integer(b.get('position'))}
        else:
            values={'title':string(b.get('title'),80,True),'content':string(b.get('content'),5000,True),'start_at':integer(b.get('start_at'),self.now),'end_at':integer(b.get('end_at')),'enabled':int(b.get('enabled',True) is True)}
            if values['end_at'] and values['end_at']<=values['start_at']: fail('结束时间必须晚于开始时间')
        if oid:
            before=self.one('SELECT * FROM '+table+' WHERE id=?',(oid,))
            if not before: fail('记录不存在',404)
            self.db.execute('UPDATE '+table+' SET '+','.join(k+'=?' for k in values)+' WHERE id=?',list(values.values())+[oid])
        else:
            before={}; cur=self.db.execute('INSERT INTO '+table+'('+','.join(values)+') VALUES('+','.join('?'*len(values))+')',list(values.values())); oid=cur.lastrowid
        self.audit('update',resource,oid,reason,before,values)
        return {'id':oid}


def handle(method,path,query,body,ctx):
    import sqlite3
    prefix='console/api/web/social/'
    path=path.lstrip('/')
    if not path.startswith(prefix): return None
    with ctx['lock']:
        ctx['conn'].execute('SAVEPOINT community_request')
        try:
            result=Community(ctx,method,path[len(prefix):].strip('/'),query,body).dispatch()
            ctx['conn'].execute('RELEASE community_request')
            return {'code':0,'data':result,'message':'ok'}
        except (Rejected,sqlite3.IntegrityError) as exc:
            ctx['conn'].execute('ROLLBACK TO community_request'); ctx['conn'].execute('RELEASE community_request')
            status=getattr(exc,'status',409)
            return {'code':status,'__http__':status,'kind':getattr(exc,'kind','conflict'),'message':str(exc) if isinstance(exc,Rejected) else '记录已存在或已变化，请刷新后重试'}
        except Exception:
            ctx['conn'].execute('ROLLBACK TO community_request'); ctx['conn'].execute('RELEASE community_request')
            raise
