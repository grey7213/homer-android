const {visible,connect,wait}=require('./webview-cdp.cjs');
(async()=>{let parsed,pause;const c=await connect(await visible(),event=>{
 if(event.method==='Debugger.scriptParsed'&&event.params.url.includes('/app/assets/js/chat.js'))parsed=event.params;
 if(event.method==='Debugger.paused')pause=event.params;
});
try{
 await c.call('Debugger.enable');await wait(()=>parsed);
 const {scriptSource}=await c.call('Debugger.getScriptSource',{scriptId:parsed.scriptId});
 const lines=scriptSource.split('\n'),line=lines.findIndex(s=>s.includes('if (navigationPending || pendingDraft'));
 console.log({hasCurrentHandler:line>=0});
 await c.call('Debugger.setBreakpoint',{location:{scriptId:parsed.scriptId,lineNumber:line}});
 const action=c.evaluate(`!window.dispatchEvent(new CustomEvent('homer:navigate-conversation',{cancelable:true,detail:{url:location.origin+'/app/chat.html?app_id=user-22e4621af8f64f28'}}))`);
 await wait(()=>pause);
 const r=await c.call('Debugger.evaluateOnCallFrame',{callFrameId:pause.callFrames[0].callFrameId,expression:'({navigationPending,pendingDraft:!!pendingDraft,generating:runtimeState?.generating,runtimeReady,appId,conversationId,activeAppId,activeConversationId})',returnByValue:true});
 console.log(r.result.value);await c.call('Debugger.resume');await action;
}finally{await c.call('Debugger.disable');c.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
