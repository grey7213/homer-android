"""Actual host UI with a deliberately broken synthetic child protocol.

No real runtime/provider or account: proves the host refuses late empty frames,
not that a synthetic child is a working conversation engine.
"""
from http.server import ThreadingHTTPServer
from history_delete_browser_fixture import Handler as AssetHandler
from urllib.parse import urlparse

CHILD = b'''<!doctype html><meta charset="utf-8"><body><main id="message">Synthetic child</main>
<script>
document.documentElement.dataset.homerBootstrapDocument='qa-document';
const token=window.name.replace('homer-bootstrap:','');
let scope={app_id:'qa-card',conversation_id:'qa-chat',admin_preview:false,owner_id:'qa-owner'};
let binding='';
const send=(type,payload={})=>parent.postMessage({channel:'homer:dialogue-host:v1',version:1,type,...scope,...payload},location.origin);
const state=overrides=>send('state',{state:{...scope,messages_ready:true,messages:[{id:'qa-message',role:'assistant',content:'Recovered complete QA body'}],
models:[],conversations:[],model_settings:{},generating:false,draft:'',overlay_active:false,...overrides}});
window.qaPublish=state;
window.qaBind=()=>send('core-ready',{engine_token:token,document_token:'qa-document'});
window.qaReady=()=>send('ready',{bootstrap_token:binding,state_scheduled:true});
window.addEventListener('message',e=>{
if(e.origin!==location.origin||e.source!==parent)return;
const data=e.data;if(data?.channel!=='homer:dialogue-host:v1')return;
if(data.type==='bind-conversation'||data.type==='switch-conversation'){
scope.app_id=data.app_id;scope.conversation_id=data.conversation_id;binding=data.bootstrap_token;
window.qaReceived=true;
}
if(data.type==='request-state')state();
});
window.qaFixtureReady=true;
</script>'''

class Handler(AssetHandler):
    def do_GET(self):
        p=urlparse(self.path).path
        if p=='/module/dialogue/':return self.send(CHILD,mime='text/html')
        if p=='/console/api/web/conversations':
            return self.send({'data':{'list':[{'id':'qa-chat','app_id':'qa-card','app_name':'QA role'}]}})
        if p.endswith('/messages'):
            return self.send({'data':{'conversation':{'id':'qa-chat','app_id':'qa-card'},'messages':[{'id':'qa-message','role':'assistant','content':'Complete cached QA body'}]}})
        if p.endswith('/profile'):return self.send({'data':{'id':'qa-owner','name':'QA'}})
        return super().do_GET()

if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8806),Handler).serve_forever()
