import assert from 'node:assert/strict';
import { apiText } from '../frontend/assets/js/api-transport.js';
let calls=0;
const recovered=await apiText('/test',{}, {fetchImpl:async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return new Response('real result');}});
assert.equal(calls,2);assert.equal(recovered.text,'real result');
for(const method of ['POST','PUT','PATCH','DELETE']){
 calls=0;await assert.rejects(apiText('/test',{method},{fetchImpl:async()=>{calls++;throw new TypeError('Failed to fetch');}}),e=>e.name==='ApiConnectionError');assert.equal(calls,1);
}
calls=0;const denied=await apiText('/test',{}, {fetchImpl:async()=>{calls++;return new Response('unauthorized',{status:401});}});assert.equal(denied.response.status,401);assert.equal(calls,1);
const caller=new AbortController();caller.abort();calls=0;
await assert.rejects(apiText('/test',{signal:caller.signal},{fetchImpl:async()=>{calls++;}}),e=>e.name==='AbortError');assert.equal(calls,0);
await assert.rejects(apiText('/test',{}, {timeoutMs:20,fetchImpl:async(_,{signal})=>({text:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})}),e=>e.reason==='timeout');
console.log('PASS: dropped read recovery; no write/401 replay; cancellation; body deadline');
