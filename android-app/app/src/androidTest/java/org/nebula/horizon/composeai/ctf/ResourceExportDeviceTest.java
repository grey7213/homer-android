package org.nebula.horizon.composeai.ctf;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.Application;
import android.content.ContentValues;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Synthetic export only: no API, credentials, account DB, or role scripts.
 * SAF is intercepted at the user-choice boundary. Only the exact test-owned
 * MediaStore URI is written/read/deleted; the actual production bridge handles
 * document/account checks, UTF-8 write, close, and the saved/cancelled ACK. */
public final class ResourceExportDeviceTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private WebView view;
    private HomerActivity fixtureActivity;
    private Object fixtureToken;

    private HomerActivity startIsolatedHost() {
        Application application=(Application)instrumentation.getTargetContext().getApplicationContext();
        Application.ActivityLifecycleCallbacks isolate=new Application.ActivityLifecycleCallbacks(){
            @Override public void onActivityCreated(Activity activity,Bundle state){
                if(!(activity instanceof HomerActivity))return;
                try {
                    fixtureActivity=(HomerActivity)activity;
                    // onCreate posts ordinary account startup; cancel it before
                    // the main loop runs it. No formal server/profile competes
                    // with this private export fixture. No operation is pending.
                    ((Handler)readField("readinessHandler")).removeCallbacksAndMessages(null);
                    for(String name:new String[]{"liveView","snapshotView"}){
                        WebView original=(WebView)readField(name);
                        if(original==null)continue;
                        original.stopLoading();original.removeJavascriptInterface("HomerNative");
                        original.setWebViewClient(new WebViewClient(){
                            @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request){
                                return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
                            }
                        });
                    }
                } catch(Exception error){throw new RuntimeException(error);}
            }
            @Override public void onActivityStarted(Activity activity){}
            @Override public void onActivityResumed(Activity activity){}
            @Override public void onActivityPaused(Activity activity){}
            @Override public void onActivityStopped(Activity activity){}
            @Override public void onActivitySaveInstanceState(Activity activity,Bundle state){}
            @Override public void onActivityDestroyed(Activity activity){}
        };
        application.registerActivityLifecycleCallbacks(isolate);
        try{return (HomerActivity)instrumentation.startActivitySync(new Intent(instrumentation.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
        finally{application.unregisterActivityLifecycleCallbacks(isolate);}
    }

    private void field(HomerActivity activity, String name, Object value) throws Exception {
        Field field=HomerActivity.class.getDeclaredField(name);field.setAccessible(true);field.set(activity,value);
    }
    @SuppressWarnings("unchecked")
    private void authorizeFixture(HomerActivity activity) throws Exception {
        field(activity,"liveView",view);field(activity,"accountAvailable",true);field(activity,"availableAccountOwner","qa-resource-export");
        Field tokens=HomerActivity.class.getDeclaredField("liveDocumentTokens");tokens.setAccessible(true);
        fixtureToken=new Object();
        ((Map<WebView,Object>)tokens.get(activity)).put(view,fixtureToken);
    }
    private Object readField(String name) throws Exception {
        Field field=HomerActivity.class.getDeclaredField(name);field.setAccessible(true);return field.get(fixtureActivity);
    }
    private String nativeGuardDiagnostics() throws Exception {
        String[] result={"unavailable"};
        instrumentation.runOnMainSync(()->{
            try {
                Map<?,?> tokens=(Map<?,?>)readField("liveDocumentTokens");
                result[0]=new JSONObject().put("ownerMatches","qa-resource-export".equals(readField("availableAccountOwner")))
                        .put("accountAvailable",readField("accountAvailable")).put("liveMatches",view==readField("liveView"))
                        .put("tokenMatches",fixtureToken==tokens.get(view)).put("pending",readField("pendingResourceExport")!=null)
                        .put("finishing",fixtureActivity.isFinishing()).put("destroyed",fixtureActivity.isDestroyed()).toString();
            } catch(Exception error){throw new RuntimeException(error);}
        });
        return result[0];
    }
    private String evaluate(String expression) throws Exception {
        CountDownLatch done=new CountDownLatch(1);String[] value={null};
        instrumentation.runOnMainSync(()->view.evaluateJavascript(expression,result->{value[0]=result;done.countDown();}));
        assertTrue("JS callback",done.await(10,TimeUnit.SECONDS));return value[0];
    }
    private void waitFor(String condition) throws Exception {
        long end=SystemClock.uptimeMillis()+15000;
        while(SystemClock.uptimeMillis()<end){if("true".equals(evaluate(condition)))return;Thread.sleep(30);}
        fail("Expected export state: "+condition+"; "+evaluate("JSON.stringify({state:window.qaState,error:window.qaError,url:location.href})")
                +"; guards="+nativeGuardDiagnostics());
    }
    private Instrumentation.ActivityMonitor picker(int result, Uri uri) {
        Intent data=uri==null?null:new Intent().setData(uri);
        IntentFilter filter=new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE);
        try{filter.addDataType("application/json");}
        catch(IntentFilter.MalformedMimeTypeException impossible){throw new AssertionError(impossible);}
        // Instrumentation matches categories and MIME as well as action. An
        // action-only filter does not intercept this SAF request: it launches
        // a real picker and never supplies the synthetic cancellation result.
        Intent expected=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json");
        assertTrue("Monitor must match the actual bounded SAF intent",filter.match(expected.getAction(),expected.getType(),
                expected.getScheme(),expected.getData(),expected.getCategories(),"ResourceExportQA")>=0);
        return instrumentation.addMonitor(filter,new Instrumentation.ActivityResult(result,data),true);
    }
    private void waitForPicker(Instrumentation.ActivityMonitor monitor) throws Exception {
        long end=SystemClock.uptimeMillis()+5000;
        while(monitor.getHits()==0&&SystemClock.uptimeMillis()<end)Thread.sleep(30);
        assertEquals("Exactly one real SAF request must reach the test user-choice boundary",1,monitor.getHits());
    }
    private void trigger(String content, String filename) throws Exception {
        JSONObject payload=new JSONObject().put("requestId","qa-export-"+java.util.UUID.randomUUID()).put("filename",filename)
                .put("mime","application/json").put("content",content);
        evaluate("window.qaState=null;HomerNative.exportWorkshopResource("+JSONObject.quote(payload.toString())+");true");
    }

    @Test public void cancellationWriteAckPayloadAndUntrustedPage() throws Exception {
        assumeTrue("MediaStore test document requires API 29+",Build.VERSION.SDK_INT>=29);
        HomerActivity activity=startIsolatedHost();
        fixtureActivity=activity;
        Uri document=null;Instrumentation.ActivityMonitor monitor=null;
        try {
            String editor=BuildConfig.SERVER_BASE_URL.replaceAll("/$","")+"/app/workshop-resource-editor.html";
            instrumentation.runOnMainSync(()->{
                view=new WebView(activity);view.getSettings().setJavaScriptEnabled(true);
                view.setWebViewClient(new WebViewClient(){
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web,WebResourceRequest request){
                        return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
                    }
                });
                view.addJavascriptInterface(new LiveBridge(activity,null,view),"HomerNative");activity.setContentView(view);
                view.loadDataWithBaseURL(editor,"<!doctype html><meta name=viewport content='width=device-width'><script>window.qaReady=true;window.qaState=null;addEventListener('homer-resource-export-result',e=>window.qaState=e.detail);</script>","text/html","UTF-8",editor);
                try{authorizeFixture(activity);}catch(Exception error){throw new RuntimeException(error);}
            });
            waitFor("window.qaReady===true");
            monitor=picker(Activity.RESULT_CANCELED,null);trigger("{\"prompts\":[{\"content\":\"合成导出\"}]}","QA.json");
            waitForPicker(monitor);
            waitFor("window.qaState?.state==='cancelled'");assertEquals(1,monitor.getHits());
            instrumentation.removeMonitor(monitor);monitor=null;
            ContentValues values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,"Homer-QA-export-"+java.util.UUID.randomUUID()+".json");
            values.put(MediaStore.Downloads.MIME_TYPE,"application/json");values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/Homer-QA");
            document=activity.getContentResolver().insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),values);
            assertNotNull("Test-owned document",document);
            monitor=picker(Activity.RESULT_OK,document);String content="{\"prompts\":[{\"identifier\":\"qa\",\"content\":\"合成导出\",\"enabled\":false}]}";
            trigger(content,"QA.json");waitForPicker(monitor);waitFor("window.qaState?.state==='saved'");assertEquals(1,monitor.getHits());
            try(InputStream stream=activity.getContentResolver().openInputStream(document)){assertNotNull(stream);assertEquals(content,new String(stream.readAllBytes(),StandardCharsets.UTF_8));}
            instrumentation.removeMonitor(monitor);monitor=null;
            // A valid request ID with invalid filename must fail, never invoke SAF.
            monitor=picker(Activity.RESULT_OK,document);trigger(content,"../secret.json");waitFor("window.qaState?.state==='failed'");assertEquals(0,monitor.getHits());
            instrumentation.removeMonitor(monitor);monitor=null;
            // Role/chat documents are not authorized to write any phone file.
            String chat=BuildConfig.SERVER_BASE_URL.replaceAll("/$","")+"/app/chat.html";
            instrumentation.runOnMainSync(()->view.loadDataWithBaseURL(chat,"<script>qaReady=true;qaState=null;addEventListener('homer-resource-export-result',e=>qaState=e.detail)</script>","text/html","UTF-8",chat));
            waitFor("window.qaReady===true");monitor=picker(Activity.RESULT_OK,document);trigger(content,"QA.json");Thread.sleep(300);
            assertEquals(0,monitor.getHits());assertEquals("null",evaluate("window.qaState"));
        }finally{
            if(monitor!=null)instrumentation.removeMonitor(monitor);
            if(document!=null)activity.getContentResolver().delete(document,null,null);
            instrumentation.runOnMainSync(()->activity.finish());
        }
    }

    @Test public void readinessRestartCannotCancelOperationCompletion() throws Exception {
        HomerActivity activity=startIsolatedHost();
        try {
            CountDownLatch completion=new CountDownLatch(1),poll=new CountDownLatch(1);
            Handler operations=(Handler)readField("handler"),readiness=(Handler)readField("readinessHandler");
            assertNotSame("Page startup/poll cancellation must not own export completion",operations,readiness);
            instrumentation.runOnMainSync(()->{
                operations.postDelayed(completion::countDown,50);
                readiness.postDelayed(poll::countDown,50);
                readiness.removeCallbacksAndMessages(null);
            });
            assertTrue("Operation callback survives readiness restart",completion.await(5,TimeUnit.SECONDS));
            assertEquals("Old page poll was cancelled",1,poll.getCount());
        } finally {instrumentation.runOnMainSync(activity::finish);}
    }
}
