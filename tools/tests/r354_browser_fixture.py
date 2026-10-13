"""Loopback-only, synthetic in-memory integration fixture; no production login."""
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import json
import sys
import threading
from urllib.parse import urlparse, parse_qs

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/tests'))
from test_homer_chat_storage import Store
from homer_chat_storage import read_chat, write_chat, ChatStorageError
store=Store(1101)
WEB=ROOT/'sillytavern-runtime/public/scripts'
bridge=(WEB/'extensions/homer-bridge/index.js').read_text(encoding='utf-8')
ui=bridge[bridge.index('function confirmHomerAction('):bridge.index('function confirmRollback(')]
# These peripherals deliberately expose a synthetic test conversation, not a
# replacement application. Outbox, confirm and conflict resolver are product code.
DRIVER=r'''
import {createChatOutbox} from '/outbox.mjs';
import {captureCloudSync,canApplyCloudSync} from '/cloud.mjs';
const chatOutbox=createChatOutbox({databaseName:'synthetic-r354-browser'});
let launch=null, chat=[], storageConflictResolution=null, generationBusy=false, loadingLaunch=false;
const storageAccountEpoch=0, isGenerating=()=>false, reconcileStorageAccount=()=> 'owner';
const cloneJsonValue=x=>JSON.parse(JSON.stringify(x));
const createElement=(tag,cls='',text='')=>{const el=document.createElement(tag);el.className=cls;el.textContent=text;return el;};
const cloudSyncScope=()=>JSON.stringify(['owner',launch.app_id,launch.conversation_id]);
const serializeChat=()=>cloneJsonValue(chat);
const captureCurrentChatStorage=()=>({...captureCloudSync(cloudSyncScope(),{app_id:'card',conversation_id:launch.conversation_id,title:'Test',messages:serializeChat()}),storageVersion:launch.storage.version});
const showHostNotice=text=>{document.querySelector('#status').textContent=text;};
async function requestJson(path,options={}){const res=await fetch(path,{headers:{'Content-Type':'application/json'},...options});const data=await res.json();if(!res.ok)throw Error(data.error);return data;}
const fromCloud=rows=>rows.map(x=>({mes:x.content,is_user:x.role==='user',extra:{homer_message_id:x.id,homer_sync_id:x.id,homer_created_at:x.created_at}}));
async function read(conv=launch?.conversation_id||'conv'){
 const scope=JSON.stringify(['owner','card',conv]), fence=await chatOutbox.fence(scope);
 const result=await requestJson('/read?conv='+conv+(fence.cloudVersion&&!fence.pending?'&version='+fence.cloudVersion:''));
 const local=await chatOutbox.read(scope);launch={app_id:'card',conversation_id:conv,storage:result.storage};
 if(result.storage.unchanged){if(!local||local.pending||local.cloudVersion!==result.storage.version||local.ackPayload.messages.length!==result.storage.message_count)throw Error('bad conditional fixture');chat=cloneJsonValue(local.payload.messages);}
 else if(local?.pending){chat=cloneJsonValue(local.payload.messages);launch.storage_conflict=local.baseVersion!==result.storage.version;}
 else {chat=fromCloud(result.messages);await chatOutbox.rememberRemote(captureCurrentChatStorage(),result,fence);}
 render();return result;
}
async function switchConversation(target){await read(target.id);}
function render(){document.querySelector('#count').textContent=chat.length;document.querySelector('#last').textContent=chat.at(-1)?.mes||'';showHostNotice(launch.storage_conflict?'冲突：本机进度已保留':'已载入');}
async function save(){chat.push({mes:document.querySelector('textarea').value,is_user:true,extra:{}});const snapshot=captureCurrentChatStorage();snapshot.committed=await chatOutbox.prepare(snapshot);
 try{const result=await requestJson('/api/homer/sync',{method:'POST',body:JSON.stringify({...snapshot.payload,storage_version:snapshot.committed.baseVersion,storage_commit_id:snapshot.committed.commitId})});await chatOutbox.cloudACK(snapshot.committed,result);chat=fromCloud(result.messages);launch.storage=result.storage;render();}
 catch(error){launch.storage_conflict=true;render();} }
'''
PAGE='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css">
<style>:root{--homer-accent:#a69ac7;--homer-text:#f2f2f2;color-scheme:dark}body{background:#222;color:#eee;font:16px sans-serif;margin:16px}main{max-width:600px;margin:auto}button{min-height:44px;margin:6px;padding:8px 14px}textarea{width:90%;min-height:60px}#status{display:block;padding:16px}dialog{max-width:calc(100vw - 32px)}</style>
<main><h1>合成存档验收</h1><p>测试专用，不连接正式账号</p><button id="read">读取</button><button id="save">编辑并保存</button><button id="fork">保留两份进度</button><textarea aria-label="消息"></textarea><output id="status"></output><p>消息数 <span id="count"></span></p><p id="last"></p></main><script type="module" src="/fixture.mjs"></script>'''
SCRIPT=DRIVER+'\n'+ui+'''\nwindow.fixture={read,save,getLaunch:()=>launch};
document.querySelector('#read').onclick=()=>read();document.querySelector('#save').onclick=()=>save();document.querySelector('#fork').onclick=()=>resolveChatStorageConflict();await read();window.fixtureReady=true;'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,data,status=200,mime='application/json'):
        raw=json.dumps(data).encode() if mime=='application/json' else data.encode()
        self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        path=urlparse(self.path);query=parse_qs(path.query)
        if path.path=='/shutdown':
            self.reply({'stopped':True});threading.Thread(target=self.server.shutdown,daemon=True).start()
        elif path.path=='/read':
            try:self.reply(read_chat(store,'owner','card',query.get('conv',['conv'])[0],query.get('version',[''])[0]))
            except ChatStorageError as e:self.reply({'error':str(e)},e.status)
        elif path.path=='/fixture.mjs':self.reply(SCRIPT,mime='text/javascript')
        elif path.path=='/outbox.mjs':self.reply((WEB/'homer-chat-outbox.mjs').read_text(),mime='text/javascript')
        elif path.path=='/cloud.mjs':self.reply((WEB/'homer-cloud-sync.mjs').read_text(),mime='text/javascript')
        elif path.path=='/style.css':self.reply((WEB/'extensions/homer-bridge/style.css').read_text(encoding='utf-8'),mime='text/css')
        elif path.path=='/':self.reply(PAGE,mime='text/html')
        else:self.reply({'error':'not found'},404)
    def do_POST(self):
        if self.path!='/api/homer/sync':return self.reply({'error':'not found'},404)
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        try:self.reply(write_chat(store,'owner','card',body['conversation_id'],body['messages'],title=body.get('title',''),version=body.get('storage_version',''),commit_id=body.get('storage_commit_id',''),fork=body.get('storage_fork') is True))
        except ChatStorageError as e:self.reply({'error':str(e)},e.status)

if __name__=='__main__':HTTPServer(('127.0.0.1',8794),Handler).serve_forever()
