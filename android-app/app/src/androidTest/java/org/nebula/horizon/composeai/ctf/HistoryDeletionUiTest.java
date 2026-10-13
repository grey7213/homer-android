package org.nebula.horizon.composeai.ctf;

import android.app.*;
import android.content.*;
import android.database.sqlite.SQLiteDatabase;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

/** Final APK resources in a real Android WebView. Unique HTTPS origin and DB:
 * no production cookies, accounts, private histories or model calls. */
public final class HistoryDeletionUiTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private static final String OWNER = "qa-delete-owner";
    private final String origin = "https://history-delete-qa-" + java.util.UUID.randomUUID() + ".invalid";
    private WebView view;
    private final AtomicInteger deletes = new AtomicInteger();
    private final AtomicInteger assetErrors = new AtomicInteger();
    private final AtomicInteger pageLoads = new AtomicInteger();
    public static final class NativeAdapter {
        final HomerCacheDatabase db;
        NativeAdapter(HomerCacheDatabase db) { this.db = db; }
        @JavascriptInterface public boolean setAccountScope(String owner) { return db.setAccountScope(owner); }
        @JavascriptInterface public boolean deleteConversationSnapshots(String owner, String ids) { return db.deleteConversationSnapshots(owner, ids); }
    }
    private String evaluate(String js) throws Exception {
        CountDownLatch done=new CountDownLatch(1); String[] value={null};
        test.runOnMainSync(()->view.evaluateJavascript(js, result->{value[0]=result;done.countDown();}));
        assertTrue("WebView evaluation completed",done.await(10,TimeUnit.SECONDS)); return value[0];
    }
    private void waitFor(String js) throws Exception {
        long end=SystemClock.uptimeMillis()+20000;
        while(SystemClock.uptimeMillis()<end){if("true".equals(evaluate(js)))return;Thread.sleep(30);}
        fail("Expected packaged UI state missing: "+js+"; fixture="+evaluate("JSON.stringify({errors:window.qaErrors,prepare:window.qaPrepareError,secure:isSecureContext,ready:document.readyState,rows:document.querySelectorAll('.history-row').length,resources:performance.getEntriesByType('resource').map(e=>({path:new URL(e.name).pathname,duration:e.duration})),dialog:!!document.querySelector('.homer-action-dialog[open]'),disabled:document.querySelector('.history-batch__delete')?.disabled,checked:document.querySelectorAll('.history-select input:checked').length})"));
    }
    private void tap(String selector) throws Exception {
        waitFor("(()=>{const e="+selector+";if(!e||e.disabled)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})()");
        evaluate("(()=>{const e="+selector+";e.scrollIntoView({block:'center'});return true;})()");
        // HTML dialog entry/exit is animated. A pre-animation coordinate can
        // hit the checkbox beneath it instead of the visible modal button.
        Thread.sleep(350);
        String position=evaluate("(()=>{const e="+selector+";if(!e)throw Error('No control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,innerWidth]})()");
        JSONArray xy=new JSONArray(position); float scale=view.getWidth()/(float)xy.getDouble(2);
        float x=(float)xy.getDouble(0)*scale,y=(float)xy.getDouble(1)*scale;
        test.runOnMainSync(()->{long now=SystemClock.uptimeMillis();MotionEvent a=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),b=MotionEvent.obtain(now,now+40,MotionEvent.ACTION_UP,x,y,0);view.dispatchTouchEvent(a);view.dispatchTouchEvent(b);a.recycle();b.recycle();});
    }
    private WebResourceResponse response(String mime, byte[] bytes) {
        return new WebResourceResponse(mime,"UTF-8",new ByteArrayInputStream(bytes));
    }
    @Test public void batchCancelDeleteRestartOfflineAndCloudRetry() throws Exception {
        Context isolated=new ContextWrapper(test.getTargetContext()) {
            @Override public File getDatabasePath(String name){return super.getDatabasePath("delete_ui_"+name);}
            @Override public SQLiteDatabase openOrCreateDatabase(String name,int mode,SQLiteDatabase.CursorFactory factory){return super.openOrCreateDatabase("delete_ui_"+name,mode,factory);}
            @Override public SQLiteDatabase openOrCreateDatabase(String name,int mode,SQLiteDatabase.CursorFactory factory,android.database.DatabaseErrorHandler h){return super.openOrCreateDatabase("delete_ui_"+name,mode,factory,h);}
            @Override public boolean deleteDatabase(String name){return super.deleteDatabase("delete_ui_"+name);}
        };
        isolated.deleteDatabase("homer-local-cache.db");
        HomerCacheDatabase db=new HomerCacheDatabase(isolated);db.setAccountScope(OWNER);
        for(int i=0;i<3;i++)assertTrue(db.saveConversationSnapshot("{\"conversation_id\":\"qa-"+i+"\",\"app_id\":\"qa-card\",\"messages\":[{\"content\":\"test\"}]}"));
        // This gate owns a synthetic WebView and NativeAdapter. Booting the
        // ordinary account activity as well races a second runtime and can
        // contact production; it adds neither coverage nor valid isolation.
        QaWebViewActivity activity=(QaWebViewActivity)test.startActivitySync(new Intent(test.getTargetContext(),QaWebViewActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            test.runOnMainSync(()->{
                view=new WebView(activity);view.getSettings().setJavaScriptEnabled(true);view.getSettings().setDomStorageEnabled(true);
                view.addJavascriptInterface(new NativeAdapter(db),"HomerNative");
                view.setWebViewClient(new WebViewClient(){
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request){
                        String path=request.getUrl().getPath();
                        try {
                            if(path.endsWith("/delete")) {deletes.incrementAndGet();return response("application/json","{\"data\":{\"deleted\":true}}".getBytes(StandardCharsets.UTF_8));}
                            if(path.equals("/console/api/web/conversations")){String list="{\"data\":{\"list\":[";for(int i=0;i<8;i++)list+=(i>0?",":"")+"{\"id\":\"qa-"+i+"\",\"app_id\":\"qa-card\",\"app_name\":\"QA "+i+"\"}";return response("application/json",(list+"]}}").getBytes(StandardCharsets.UTF_8));}
                            if(path.endsWith("/profile"))return response("application/json","{\"data\":{\"id\":\"qa-delete-owner\",\"name\":\"QA\"}}".getBytes(StandardCharsets.UTF_8));
                            if(path.contains("/api/"))return response("application/json","{\"data\":{},\"points\":0}".getBytes(StandardCharsets.UTF_8));
                            String asset=ClientAssetRoutes.assetPath(path);
                            if(asset==null)return response("text/plain",new byte[0]);
                            byte[] raw;try(InputStream stream=test.getTargetContext().getAssets().open(asset)){raw=stream.readAllBytes();}
                            String mime=path.endsWith(".css")?"text/css":path.endsWith(".html")?"text/html":path.endsWith(".js")||path.endsWith(".mjs")?"text/javascript":path.endsWith(".svg")?"image/svg+xml":path.endsWith(".webp")?"image/webp":"image/png";
                            if(path.endsWith("histories.html")) {
                                String init="<script>window.qaPage="+pageLoads.incrementAndGet()+";localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:'qa-delete-owner',name:'QA'}));window.qaErrors=[];addEventListener('error',e=>qaErrors.push(e.message+' at '+e.filename+':'+e.lineno));addEventListener('unhandledrejection',e=>qaErrors.push(String(e.reason)));window.qaOffline=true;Object.defineProperty(navigator,'onLine',{get:()=>!qaOffline});</script>";
                                raw=new String(raw,StandardCharsets.UTF_8).replace("<head>","<head>"+init).getBytes(StandardCharsets.UTF_8);
                            }
                            return response(mime,raw);
                        }catch(Exception error){assetErrors.incrementAndGet();return response("text/plain","fixture asset error".getBytes(StandardCharsets.UTF_8));}
                    }
                });
                activity.setContentView(view);view.loadUrl(origin+"/app/histories.html");
            });
            waitFor("document.querySelectorAll('.history-row').length===8");
            evaluate("(async()=>{try{const {createChatOutbox}=await import(new URL('/scripts/homer-chat-outbox.mjs',location.href).href);window.qaOutbox=createChatOutbox();for(let i=0;i<2;i++)await qaOutbox.prepare({scope:JSON.stringify(['qa-delete-owner','qa-card','qa-'+i]),body:JSON.stringify({app_id:'qa-card',conversation_id:'qa-'+i,messages:Array.from({length:1200},()=>({mes:'test'.repeat(200)}))})});window.qaPrepared=true;}catch(e){window.qaPrepareError=String(e);}})()");
            waitFor("window.qaPrepared===true");
            tap("document.querySelector('.history-manage')");
            tap("document.querySelectorAll('.history-select input')[0]");tap("document.querySelectorAll('.history-select input')[1]");
            tap("document.querySelector('.history-batch__delete')");waitFor("!!document.querySelector('.homer-action-dialog[open]')");
            tap("document.querySelector('.homer-action-cancel')");
            waitFor("!document.querySelector('.homer-action-dialog[open]')&& !document.querySelector('.history-batch__delete').disabled");
            assertEquals("8",evaluate("document.querySelectorAll('.history-row').length"));
            tap("document.querySelector('.history-batch__delete')");
            waitFor("!!document.querySelector('.homer-action-dialog[open]')");
            long start=SystemClock.uptimeMillis();tap("document.querySelector('.homer-action-confirm')");
            waitFor("document.querySelectorAll('.history-row').length===6");
            long elapsed=SystemClock.uptimeMillis()-start;assertTrue("Local deletion must not wait cloud: "+elapsed,elapsed<2000);
            waitFor("document.querySelector('.history-delete-notice').textContent.includes('已在本机删除 2 段会话')");
            assertEquals(0,deletes.get());assertEquals(1,new JSONArray(db.readConversationHistory()).length());
            assertFalse(db.saveConversationSnapshot("{\"conversation_id\":\"qa-0\",\"messages\":[]}"));
            int expectedPage=pageLoads.get()+1;
            test.runOnMainSync(view::reload);
            waitFor("window.qaPage==="+expectedPage+"&&document.querySelectorAll('.history-row').length===6");
            waitFor("!!document.querySelector('.history-sync-status')&&document.querySelector('.history-sync-status').style.display!=='none'");
            evaluate("qaOffline=false;window.dispatchEvent(new Event('online'));true");
            long syncDeadline=SystemClock.uptimeMillis()+20000;
            while(deletes.get()<2 && SystemClock.uptimeMillis()<syncDeadline)Thread.sleep(30);
            waitFor("document.querySelector('.history-sync-status')?.style.display==='none'");
            assertEquals(2,deletes.get());assertEquals(evaluate("JSON.stringify(qaErrors)"),"0",evaluate("qaErrors.length"));
            assertEquals("All packaged assets must load",0,assetErrors.get());
            assertFalse(Boolean.parseBoolean(evaluate("document.documentElement.scrollWidth>innerWidth")));
            System.out.println("NATIVE_DELETE_MS="+elapsed+"; OFFLINE_RESTART_CLOUD_RETRY=PASS");
        } finally {
            test.runOnMainSync(()->{if(view!=null){view.loadUrl("about:blank");view.destroy();}activity.finish();});
            db.close();isolated.deleteDatabase("homer-local-cache.db");
        }
    }
}
