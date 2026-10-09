"""Loopback QA only: actual archive route body and SQLite, synthetic identity.
No production login, histories, model requests or public media redistribution.
"""
import argparse
import json
import sqlite3
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote
from http.server import ThreadingHTTPServer

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from export_archive_server import transform_server
from homer_archive_storage import read_games, write_game, ArchiveStorageError
from chatarchive_browser_fixture import Handler as BaseHandler


def route(source):
    transformed=transform_server(source)
    start=transformed.index('        if normalized == "console/api/web/archive/saves":')
    end=transformed.index('        if normalized in (\n            "console/api/web/dialogue/runtime-state",',start)
    block=transformed[start:end]
    scope=dict(read_games=read_games,write_game=write_game,ArchiveStorageError=ArchiveStorageError,
        parse_query_str=lambda q,k,d:parse_qs(q).get(k,[d])[0],
        parse_query_int=lambda q,k,d,lo,hi:max(lo,min(hi,int(parse_qs(q).get(k,[d])[0]))),
        ok_response=lambda data:{'data':data},error_response=lambda message,code:{'result':'failure','message':message,'code':code})
    exec('def actual_route(self, normalized, body, query):\n'+block,scope)
    return scope['actual_route']


class Handler(BaseHandler):
    def authenticated_token_user(self):
        # Test-only identity channel. Production still derives owner from its
        # existing token/HttpOnly login and never accepts this QA header.
        value=self.headers.get('X-QA-Account','')
        return {'id':value} if value.startswith('synthetic-game-owner-') else None

    @property
    def store(self):
        return self.server.store

    def do_GET(self):
        url=urlsplit(self.path)
        if url.path=='/r361-fixture':
            html=Path(__file__).with_name('chatarchive_game_fixture.html').read_text(encoding='utf-8')
            html=html.replace("const store = createGameStore();", "const baseStore=createGameStore(); const {createSyncedGameStore}=await import('/app/assets/js/visual-novel-game-sync.mjs'); const store=createSyncedGameStore({store:baseStore,client:window.cloudClient,isCurrent:()=>true});")
            inject='''<script>
            window.cloudClient={archiveSaves:async params=>window.cloudRequest('GET',params),saveArchiveGame:async body=>window.cloudRequest('POST',body)};
            window.cloudRequest=async(method,value)=>{
              const owner='synthetic-game-owner-'+(new URLSearchParams(location.search).get('slot')||'main');
              const response=await fetch('/console/api/web/archive/saves'+(method==='GET'?'?'+new URLSearchParams(value):''),{method,headers:{'X-QA-Account':owner,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify(value):undefined});
              const data=await response.json();if(!response.ok)throw Object.assign(Error('QA HTTP failure'),{status:response.status});return data;
            };
            </script>'''
            html=html.replace('<script type="module">',inject+'<script type="module">',1)
            html=html.replace("const store=createSyncedGameStore({store:baseStore,client:window.cloudClient,isCurrent:()=>true});", "const store=createSyncedGameStore({store:baseStore,client:window.cloudClient,isCurrent:()=>true}); await store.pull(owner);")
            html=html.replace('gameStore:createGameStore(),', 'gameStore:createSyncedGameStore({store:createGameStore(),client:window.cloudClient,isCurrent:()=>true}),')
            html=html.replace("return {data:{app_id:payload.app_id,conversation_id:'dedicated-'+payload.app_id+'-'+calls.length}};", "const conversation_id='dedicated-'+payload.app_id+'-'+calls.length;await fetch('/qa/bind',{method:'POST',headers:{'X-QA-Account':owner,'Content-Type':'application/json'},body:JSON.stringify({id:conversation_id,app:payload.app_id})});return {data:{app_id:payload.app_id,conversation_id}};")
            # A native catalog shim represents installed data only. The parser
            # and the real APK's media interceptor have independent native tests.
            catalog=self.server.workshop_catalog if not parse_qs(url.query).get('missing') else {'roles':[]}
            html=html.replace('const query = new URLSearchParams(location.search);', 'window.HomerNative={getArchiveMediaStatus:()=>\'{"packs":[]}\',getArchiveWorkshopCatalog:()=>'+json.dumps(json.dumps(catalog,ensure_ascii=False))+'};\nconst query = new URLSearchParams(location.search);')
            return self.send_bytes(html.encode(),'text/html; charset=utf-8')
        prefix='/media-cache/card-assets/ready/archive-workshop/'
        if url.path.startswith(prefix):
            relative=unquote(url.path[len(prefix):]);path=(self.server.workshop/relative).resolve()
            if self.server.workshop not in path.parents or not path.is_file():return self.send_error(404)
            mime={'.png':'image/png','.skel':'application/octet-stream','.atlas':'text/plain'}.get(path.suffix,'.bin')
            return self.send_bytes(path.read_bytes(),mime)
        if url.path=='/console/api/web/archive/saves':return self.archive_route({},url.query)
        super().do_GET()

    def do_POST(self):
        url=urlsplit(self.path)
        if url.path in ('/console/api/web/archive/saves','/qa/bind'):
            length=int(self.headers.get('Content-Length','0'))
            if length>32*1024*1024:return self.send_error(413)
            body=json.loads(self.rfile.read(length) or '{}')
            if url.path=='/qa/bind':
                user=self.authenticated_token_user()
                if not user:return self.send_error(401)
                with self.store.lock:
                    self.store.conn.execute('INSERT INTO conversations VALUES(?,?,?)',(body['id'],user['id'],body['app']));self.store.conn.commit()
                return self.send_bytes(b'{}','application/json')
            return self.archive_route(body,url.query)
        super().do_POST()

    def archive_route(self,body,query):
        data=self.server.route(self,'console/api/web/archive/saves',body,query)
        code=int(data.get('code',200));raw=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)


class LocalQAServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can route to an older, still-running fixture. Fail
    # binding instead of producing apparently current evidence from stale code.
    allow_reuse_address=False

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8801);parser.add_argument('--workshop',type=Path,required=True);parser.add_argument('--source',type=Path,required=True);args=parser.parse_args()
    server=LocalQAServer(('127.0.0.1',args.port),Handler)
    server.route=route(args.source.read_text(encoding='utf-8-sig'))
    server.workshop=args.workshop.resolve();server.workshop_catalog=json.loads((server.workshop/'catalog.json').read_text(encoding='utf-8'))
    server.store=type('SyntheticStore',(),{})();server.store.lock=threading.RLock();server.store.conn=sqlite3.connect(':memory:',check_same_thread=False);server.store.conn.row_factory=sqlite3.Row
    server.store.conn.execute('CREATE TABLE conversations(id TEXT,user_id TEXT,app_id TEXT)');server.store.conn.commit()
    server.serve_forever()
