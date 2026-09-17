"""Bounded, account-owned community uploads. Construct once at host startup.

The host streams ``read_file`` results after its ordinary authentication. Paths
returned by read_file are internal and MUST NOT be serialized in API responses.
"""
import base64
import hashlib
import json
from pathlib import Path
import re
import time
import uuid
from community_service import fail, integer, Community, Rejected

class CommunityMediaStore:
    CHUNK = 512 * 1024
    def __init__(self, conn, lock, directory):
        self.db,self.lock=conn,lock
        self.directory=Path(directory).resolve()
        self.directory.mkdir(parents=True,exist_ok=True)
        with lock:
            conn.executescript('''
            CREATE TABLE IF NOT EXISTS social_uploads (
              id TEXT PRIMARY KEY,user_id TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,
              written INTEGER NOT NULL DEFAULT 0,next_chunk INTEGER NOT NULL DEFAULT 0,
              previous_hash TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'uploading',created_at INTEGER NOT NULL);
            ''')
            conn.commit()

    def row(self,uid,oid):
        if not isinstance(oid,str) or not re.fullmatch('[a-f0-9]{32}',oid): fail('上传标识不正确')
        cur=self.db.execute('SELECT * FROM social_uploads WHERE id=? AND user_id=?',(oid,uid))
        value=cur.fetchone()
        if not value: fail('上传记录不存在',404)
        return dict(zip([c[0] for c in cur.description],value))

    def handle(self,path,method,body,uid):
        now=int(time.time()*1000)
        if method!='POST': fail('方法不支持',405)
        if path=='init':
            mime=body.get('mime'); size=integer(body.get('size'))
            maximum=100*1024*1024 if mime=='video/mp4' else 8*1024*1024
            if mime not in ('video/mp4','image/png','image/jpeg','image/webp') or size<1 or size>maximum: fail('媒体类型或大小不符合要求')
            used=self.db.execute('SELECT coalesce(sum(size),0) FROM social_uploads WHERE user_id=? AND created_at>?',(uid,now-86400000)).fetchone()[0]
            if used+size>300*1024*1024: fail('今日媒体上传额度已用完，请稍后重试',429)
            oid=uuid.uuid4().hex
            self.db.execute('INSERT INTO social_uploads(id,user_id,mime,size,created_at) VALUES(?,?,?,?,?)',(oid,uid,mime,size,now))
            return {'id':oid,'chunk_size':self.CHUNK}
        oid=body.get('id');row=self.row(uid,oid);file=self.directory/(oid+'.media')
        if path=='finalize' and row['status']=='ready': return {'url':'/console/api/web/social-media/'+oid}
        if row['status']!='uploading' or now-row['created_at']>86400000: fail('上传已结束或过期',409)
        if path=='chunk':
            encoded=body.get('data','')
            if not isinstance(encoded,str) or len(encoded)>4*((self.CHUNK+2)//3): fail('分片过大')
            try: payload=base64.b64decode(encoded,validate=True)
            except (ValueError,TypeError): fail('分片格式不正确')
            index=integer(body.get('index'));digest=hashlib.sha256(payload).hexdigest()
            if index==row['next_chunk']-1 and digest==row['previous_hash']: return {'next_chunk':row['next_chunk']}
            if index!=row['next_chunk'] or not payload or row['written']+len(payload)>row['size']: fail('分片顺序或长度不正确',409)
            # A request rolled back after writing can leave bytes beyond written;
            # truncate only this exact upload file to its committed byte offset.
            with file.open('r+b' if file.exists() else 'w+b') as stream:
                stream.truncate(row['written']);stream.seek(row['written']);stream.write(payload);stream.flush()
            self.db.execute('UPDATE social_uploads SET written=written+?,next_chunk=next_chunk+1,previous_hash=? WHERE id=?',(len(payload),digest,oid))
            return {'next_chunk':index+1}
        if path=='finalize':
            if row['written']!=row['size'] or not file.exists(): fail('媒体尚未上传完整',409)
            with file.open('rb') as stream: magic=stream.read(32)
            valid={'video/mp4':magic[4:8]==b'ftyp','image/png':magic.startswith(b'\x89PNG\r\n\x1a\n'),
                   'image/jpeg':magic.startswith(b'\xff\xd8\xff'),'image/webp':magic.startswith(b'RIFF') and magic[8:12]==b'WEBP'}[row['mime']]
            if not valid: fail('文件内容与媒体类型不符',422)
            self.db.execute("UPDATE social_uploads SET status='ready' WHERE id=?",(oid,))
            return {'url':'/console/api/web/social-media/'+oid}
        fail('上传操作不存在',404)

    def read_file(self,oid,ctx):
        """Return (internal Path, MIME) for an authorized HTTP streaming handler.

        Keep ordinary CSRF/authentication. Send private,no-store and nosniff;
        implement standard Range requests for MP4 seeking in the host server.
        """
        if not re.fullmatch('[a-f0-9]{32}',str(oid)): fail('媒体不存在',404)
        with self.lock:
            service=Community(ctx,'GET','',{},{});uid=service.uid
            if not uid: fail('请先登录',401)
            if not service.enabled() or not service.consented() or any(s['kind']=='ban' for s in service.sanctions()): fail('媒体暂不可查看',403)
            cur=self.db.execute("SELECT user_id,mime FROM social_uploads WHERE id=? AND status='ready'",(oid,));row=cur.fetchone()
            if not row: fail('媒体不存在',404)
            allowed=row[0]==uid or service.admin
            url='/console/api/web/social-media/'+oid
            if not allowed:
                for typ,table in [('post','social_posts'),('comment','social_comments')]:
                    candidates=self.db.execute('SELECT id FROM '+table+' WHERE instr(images,?)>0'+(' OR video=?' if typ=='post' else ''),(url,url) if typ=='post' else (url,)).fetchall()
                    for candidate in candidates:
                        try:
                            content=service.object(typ,candidate[0])
                            if content['user_id']==row[0] and (url in json.loads(content['images']) or content.get('video')==url): allowed=True;break
                        except Rejected: pass
                    if allowed:break
            if not allowed: fail('媒体不存在或暂不可查看',404)
            path=self.directory/(oid+'.media')
            if not path.is_file(): fail('媒体文件缺失',404)
            return path,row[1]
