// Read/operate the installed debug app; credentials never enter output.
const endpoint = process.env.HOMER_TEST_CDP || 'http://127.0.0.1:9335';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function targets() { return (await (await fetch(endpoint + '/json')).json()).filter(t => t.type === 'page'); }
async function wait(fn, limit = 30000) { const end = Date.now()+limit; while(Date.now()<end) { const value=await fn(); if(value)return value; await delay(100); } throw Error('WebView condition timed out'); }
async function connect(target, onEvent = () => {}) {
 const ws=new WebSocket(target.webSocketDebuggerUrl), calls=new Map(); let seq=0;
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.onmessage=event=>{const m=JSON.parse(event.data),c=calls.get(m.id);if(!c){onEvent(m);return;}calls.delete(m.id);clearTimeout(c.timer);m.error?c.reject(Error(m.error.message)):c.resolve(m.result);};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{calls.delete(id);reject(Error(method+' timeout'));},30000);calls.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 return {call,evaluate,target,close:()=>ws.close()};
}
async function visible(part='') { return (await targets()).find(t=>JSON.parse(t.description||'{}').visible&&t.url.includes(part)); }
async function navigate(client,url) {await client.evaluate(`location.assign(${JSON.stringify(url)})`);return connect(await wait(()=>visible(url.split('?')[0])));}
module.exports={targets,wait,connect,visible,navigate,delay};
