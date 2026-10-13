"""Synthetic local-first integration: shipping session/upload/mutation functions.
Actual IndexedDB + isolated transactional SQLite. No real account/model requests.
"""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent))
import r354_browser_fixture as fixture
from http.server import HTTPServer
from urllib.parse import urlparse, parse_qs

bridge = fixture.bridge
def section(start, end):
    return bridge[bridge.index(start):bridge.index(end, bridge.index(start))]
driver = r'''
import {createChatOutbox} from '/outbox.mjs';
import {createLocalSessionStore} from '/local-session.mjs';
import {captureCloudSync,createCloudSyncQueue} from '/cloud.mjs';
const chatOutbox=createChatOutbox({databaseName:'r354-phone-browser'}),localSessions=createLocalSessionStore();
const MODULE_ID='synthetic',sessionReadFences=new WeakMap(),acknowledgedPromptTickets=new WeakMap(),storageAckStamps=new Map(),storageRequests=new Set();
let storageAccountEpoch=0,verifiedStorageOwner='',storageOwner='owner',session=null,launch=null,chat=[],offline=false,uploadWork=Promise.resolve();
let generationBusy=false,loadingLaunch=false,rollbackBusy=false,suppressSync=false,dialogueEventLogMuted=0;
const cardPreparations={clear(){}},sessionPrefetchCache=new Map(),scopeDrafts=new Map();let sessionPrefetchPeer=null,preparedAdminLaunch=null;
const clearCardTransportMemory=()=>{},cloneJsonValue=x=>JSON.parse(JSON.stringify(x));
const prepareAcknowledgedPromptStates=()=>[],isGenerating=()=>false;
localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'owner'}));
const queryString=(a,c)=>new URLSearchParams({app_id:a,conversation_id:c}).toString();
const requestSessionCard=(path,{request})=>request(path);
const cloudSyncScope=()=>JSON.stringify(['owner','card',launch.conversation_id]);
const serializeChat=()=>cloneJsonValue(chat);
const captureCurrentChatStorage=()=>({...captureCloudSync(cloudSyncScope(),{app_id:'card',conversation_id:launch.conversation_id,title:'Test',messages:serializeChat()}),storageVersion:launch.storage.version});
const resolveMessageMenuTarget=t=>chat[t.messageIndex]?{messageIndex:t.messageIndex,message:chat[t.messageIndex]}:null;
const cloudHomerMessageId=m=>String(m?.extra?.homer_message_id||'');
const showHostNotice=text=>document.querySelector('#status').textContent=text;
const updateRuntimeStatus=()=>{},queueMessageMenuRender=()=>{},closeMessageMenu=()=>{},logDialogueEvent=async()=>{};
const event_types={MESSAGE_DELETED:'delete',CHAT_LOADED:'loaded'},eventSource={emit:async()=>{}};
const getContext=()=>({chat,chatId:'local',saveChat:async()=>{},printMessages:async()=>render()});
const confirmHomerAction=async()=>true,confirmRollback=async()=>true;
async function requestJson(path,options={}){
 if(offline)throw Error('synthetic offline');
 const response=await fetch(path,{headers:{'Content-Type':'application/json'},...options}),data=await response.json();
 if(!response.ok){const e=Error(data.error);e.status=response.status;throw e;}return data;
}
function fromCloud(rows){return rows.map(x=>({mes:x.content,is_user:x.role==='user',extra:{homer_message_id:x.id,homer_sync_id:x.id,homer_created_at:x.created_at}}));}
function render(){document.querySelector('#count').textContent=chat.length;document.querySelector('#last').textContent=chat.at(-1)?.mes||'';}
'''
product = section('function storageAckKey(', 'const extensionSyncQueue =') + '\n' + section('async function preferLocalSession(', '\nfunction sessionCacheKey(')
product += '\n' + section('async function rollbackToMessage(', '\nasync function loadRuntimeState(')
product += '\n' + section('async function deleteCloudMessage(', '\nasync function handleMessageMenuAction(')
tail = r'''
const cloudSyncQueue=createCloudSyncQueue(async snapshot=>{
 const result=await requestScopedStorage(snapshot,'chat');await acknowledgeStorage(snapshot.committed,result);return result;
});
async function syncCloudChat(){const snap=captureCurrentChatStorage();snap.committed=await chatOutbox.prepare(snap);launch.local_pending=true;
 uploadWork=cloudSyncQueue.enqueue(snap).then(ack=>{launch.storage=ack.response.storage;launch.local_pending=false;}).catch(()=>{});return true;}
async function open(){session=await fetchSession('card','conv');launch=session.launch;
 chat=Array.isArray(launch.local_chat)?cloneJsonValue(launch.local_chat):fromCloud(launch.messages);
 if(!launch.local_session&&!launch.local_pending){const snap=captureCurrentChatStorage();await chatOutbox.rememberRemote(snap,{messages:launch.messages,storage:launch.storage},await chatOutbox.fence(snap.scope));}
 render();}
async function edit(text){chat.push({mes:text,is_user:true,extra:{}});await syncCloudChat();render();}
window.fixture={open,edit,setOffline:x=>offline=x,getLaunch:()=>launch,flush:()=>uploadWork,
 rollback:index=>rollbackToMessage({messageIndex:index},{askConfirmation:false}),delete:index=>deleteCloudMessage({messageIndex:index},true),
 pending:async()=>(await chatOutbox.read(cloudSyncScope())).pending};
await open();window.fixtureReady=true;
'''
SCRIPT = driver + '\n' + product + '\n' + tail
PAGE = '''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
<style>body{background:#202024;color:#ededf1;font:16px sans-serif;margin:24px}main{max-width:680px;margin:auto}#last{overflow-wrap:anywhere}</style>
<main><h1>本机优先存档验收</h1><p>仅合成数据，不连接正式账号</p><output id="status"></output><p>消息数 <span id="count"></span></p><p id="last"></p></main>
<script type="module" src="/local-first.mjs"></script>'''

class Handler(fixture.Handler):
    def do_GET(self):
        path=urlparse(self.path);query=parse_qs(path.query)
        if path.path=='/':return self.reply(PAGE,mime='text/html')
        if path.path=='/local-first.mjs':return self.reply(SCRIPT,mime='text/javascript')
        if path.path=='/local-session.mjs':return self.reply((fixture.WEB/'homer-local-session.mjs').read_text(),mime='text/javascript')
        if path.path=='/api/homer/session':
            stored=fixture.read_chat(fixture.store,'owner','card',query.get('conversation_id',['conv'])[0],query.get('chat_version',[''])[0])
            return self.reply({'user':{'id':'owner','name':'Synthetic'},'runtime':{},'launch':{'app_id':'card','conversation_id':'conv','card':{'data':{'name':'Test'}},'bridge_token':True,**stored}})
        if path.path=='/backups':return self.reply({'count':fixture.store.conn.execute('SELECT COUNT(*) FROM homer_chat_backups').fetchone()[0]})
        return super().do_GET()

if __name__=='__main__':HTTPServer(('127.0.0.1',8794),Handler).serve_forever()
