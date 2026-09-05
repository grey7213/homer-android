// Smoke test for the isolated .audit APK. Forward its WebView CDP socket first.
// Node built-ins only; never reads credentials or logs request headers.
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const targets = await (await fetch('http://127.0.0.1:18222/json/list')).json();
  const target = targets.find(t => t.url.includes('/app/login.html'));
  if (!target) throw Error('Expected a signed-out audit APK login page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(Error(message.error.message));
    else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', reject, {once:true});
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {pending.delete(id);reject(Error('CDP timeout'));}, 10000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  try {
    const result = await call('Runtime.evaluate', {returnByValue:true, expression:`(() => {
      if (localStorage.getItem('ai_xingyue_logged_in') === '1'
          || localStorage.getItem('ai_xingyue_user')) throw Error('Refusing signed-in page');
      if (typeof HomerNative.setAccountScope !== 'function') throw Error('Missing new native bridge');
      try {
        HomerNative.setAccountScope('audit-smoke-A');
        HomerNative.saveConversationSnapshot(JSON.stringify({conversation_id:'audit-smoke',
          app_id:'audit-card',messages:[{role:'assistant',content:'test only'}]}));
        const read=JSON.parse(HomerNative.readConversationSnapshot('audit-smoke'));
        const history=JSON.parse(HomerNative.readConversationHistory());
        HomerNative.setAccountScope('audit-smoke-B');
        return {app_visit:typeof HomerNative.getAppVisitId()==='string' && HomerNative.getAppVisitId().length>0,
          native_receiver:read.messages?.[0]?.content==='test only',
          summary:history[0]?.last_message==='test only',
          isolated:HomerNative.readConversationHistory()==='[]',
          overflow:document.documentElement.scrollWidth > innerWidth+1};
      } finally {HomerNative.setAccountScope('');}
    })()`});
    if (result.exceptionDetails) throw Error('Native bridge evaluation failed');
    const actual = result.result.value;
    if (!actual.app_visit || !actual.native_receiver || !actual.summary || !actual.isolated || actual.overflow) {
      throw Error(JSON.stringify(actual));
    }
    const out = path.resolve(__dirname, '../output/local-audit-20260905/android');
    fs.mkdirSync(out, {recursive:true});
    const screenshot = await call('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out, 'login.png'), Buffer.from(screenshot.data, 'base64'));
    fs.writeFileSync(path.join(out, 'smoke.json'), JSON.stringify(actual, null, 2));
    process.stdout.write(JSON.stringify(actual) + '\n');
  } finally {
    socket.close();
  }
})().catch(error => {console.error(error.message);process.exitCode=1;});
