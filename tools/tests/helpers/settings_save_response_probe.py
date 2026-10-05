"""Opt-in settings-save response diagnostics; never a product behavior fix."""

INSTALL_SETTINGS_RESPONSE_PROBE = r"""mode=>{
  if(!['observe','drain'].includes(mode)||location.origin!=='http://127.0.0.1:8191'
    ||!location.pathname.startsWith('/module/dialogue/'))return false;
  if(window.__r37SettingsSaveResponseProbe)return false;
  const nativeFetch=window.fetch,responseIds=new WeakMap(),statuses=[];
  const counts={started:0,resolved:0,rejected:0,observer_failed:0,
    drain_started:0,drain_complete:0,drain_rejected:0,drain_start_failed:0};
  const targeted=(input,init)=>{
    const raw=input&&typeof input==='object'&&typeof input.url==='string'?input.url:String(input);
    const url=new URL(raw,location.href),method=String(init?.method||input?.method||'GET').toUpperCase();
    return method==='POST'&&url.origin===location.origin
      &&['/api/settings/save','/module/dialogue/api/settings/save'].includes(url.pathname);
  };
  window.fetch=function(...args){
    // Preserve the original call, Promise, synchronous throw, await result and
    // rejected value. Observation and opt-in drain are independent side work.
    const originalPromise=Reflect.apply(nativeFetch,this,args);
    let matches=false;try{matches=targeted(...args);}catch{counts.observer_failed++;}
    if(!matches)return originalPromise;
    counts.started++;
    try{
      originalPromise.then(response=>{
        counts.resolved++;
        if(!responseIds.has(response)){
          responseIds.set(response,counts.resolved);
          if(statuses.length<32)statuses.push(Number(response.status));
        }
        if(mode!=='drain')return;
        try{
          // Diagnostic only: consume a clone, not the returned Response.
          // No body value, token, URL, request or headers enter the snapshot.
          const clone=response.clone();counts.drain_started++;
          clone.text().then(()=>{counts.drain_complete++;},()=>{counts.drain_rejected++;})
            .catch(()=>{counts.observer_failed++;});
        }catch{counts.drain_start_failed++;}
      },()=>{counts.rejected++;}).catch(()=>{counts.observer_failed++;});
    }catch{counts.observer_failed++;}
    return originalPromise;
  };
  window.__r37SettingsSaveResponseProbe=Object.freeze({read:()=>({installed:true,mode,
    body_logged:false,returned_promise_unchanged:true,returned_response_unchanged:true,
    response_status_limit:32,response_statuses:statuses.slice(),counts:{...counts}})});
  return true;
}"""

READ_SETTINGS_RESPONSE_PROBE = r"""()=>window.__r37SettingsSaveResponseProbe?.read()
  ||{installed:false,mode:'off',body_logged:false}"""
