package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONTokener;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Native rotation/lifecycle only, with synthetic HTML and no player data. */
public final class ArchiveOrientationTest {
    @Test public void retainedDocumentBridgeRotatesAndRestoresWithoutReloadingItsState() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Intent intent=new Intent(instrumentation.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        HomerActivity activity=(HomerActivity)instrumentation.startActivitySync(intent);
        try{
            instrumentation.runOnMainSync(()->activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitOrientation(activity,Configuration.ORIENTATION_PORTRAIT);
            Field field=HomerActivity.class.getDeclaredField("liveView");field.setAccessible(true);
            WebView view=(WebView)field.get(activity);assertNotNull(view);
            String chat=BuildConfig.SERVER_BASE_URL+"app/chat.html?app_id=synthetic&conversation_id=synthetic";
            instrumentation.runOnMainSync(()->{
                installSyntheticResponse(view,chat,page("普通会话")+
                        "<script>window.__archiveRotationSentinel={revision:64};</script>");
                view.loadUrl(chat);
            });
            long deadline=System.currentTimeMillis()+10000;
            while(!"64".equals(evaluate(instrumentation,view,"window.__archiveRotationSentinel?.revision"))
                    &&System.currentTimeMillis()<deadline)Thread.sleep(100);
            assertEquals("64",evaluate(instrumentation,view,"window.__archiveRotationSentinel?.revision"));
            // Calling from the current document with a stale URL must not rotate it.
            assertEquals("true",evaluate(instrumentation,view,"HomerNative.refreshArchiveOrientation(location.origin+'/app/visual-novel.html');true"));
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,activity.getRequestedOrientation());
            assertEquals("true",evaluate(instrumentation,view,"history.replaceState(null,'',location.href+'&presentation=archive_vn&vn_game=synthetic-game');HomerNative.refreshArchiveOrientation(location.href);true"));
            String visibleUrl=(String)new JSONTokener(evaluate(instrumentation,view,"location.href")).nextValue();
            assertTrue("Synthetic game URL: "+visibleUrl,ArchiveOrientationPolicy.isGameUrl(BuildConfig.SERVER_BASE_URL,visibleUrl));
            waitOrientation(activity,Configuration.ORIENTATION_LANDSCAPE);
            String[] nativeUrl={null};boolean[] currentDocument={false};
            instrumentation.runOnMainSync(()->{nativeUrl[0]=view.getUrl();currentDocument[0]=activity.historyPreparationDocumentToken(view)!=null;});
            assertEquals("Native retained URL must follow the actual History API",visibleUrl,nativeUrl[0]);
            assertTrue("Current live document is registered",currentDocument[0]);
            assertEquals("64",evaluate(instrumentation,view,"window.__archiveRotationSentinel.revision"));
            assertSame(view,field.get(activity));assertFalse(activity.isDestroyed());
            assertEquals("true",evaluate(instrumentation,view,"HomerNative.requestOrientation('default');true"));
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,activity.getRequestedOrientation());
            assertEquals("true",evaluate(instrumentation,view,"const u=new URL(location.href);['presentation','vn_game'].forEach(k=>u.searchParams.delete(k));history.replaceState(null,'',u.href);HomerNative.refreshArchiveOrientation(location.href);true"));
            waitOrientation(activity,Configuration.ORIENTATION_PORTRAIT);
            assertEquals("64",evaluate(instrumentation,view,"window.__archiveRotationSentinel.revision"));
            assertSame(view,field.get(activity));assertFalse(activity.isDestroyed());
        }finally{instrumentation.runOnMainSync(activity::finish);}
    }
    @Test public void gameRotatesWithoutRecreatingActivityAndExitRestoresPortrait() throws Exception {
        Instrumentation instrumentation=InstrumentationRegistry.getInstrumentation();
        Intent intent=new Intent(instrumentation.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        HomerActivity activity=(HomerActivity)instrumentation.startActivitySync(intent);
        try{
            instrumentation.runOnMainSync(()->activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            waitOrientation(activity,Configuration.ORIENTATION_PORTRAIT);
            Field field=HomerActivity.class.getDeclaredField("liveView");field.setAccessible(true);
            WebView view=(WebView)field.get(activity);assertNotNull(view);
            String base=BuildConfig.SERVER_BASE_URL;
            instrumentation.runOnMainSync(()->view.loadDataWithBaseURL(base+"app/visual-novel.html",page("游戏大厅"),"text/html","UTF-8",base+"app/visual-novel.html"));
            waitOrientation(activity,Configuration.ORIENTATION_LANDSCAPE);
            assertFalse(activity.isDestroyed());assertSame(view,field.get(activity));
            instrumentation.runOnMainSync(()->activity.requestOrientation(view,activity.historyPreparationDocumentToken(view),"default"));
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,activity.getRequestedOrientation());
            String stage=base+"app/chat.html?app_id=synthetic&conversation_id=synthetic&presentation=archive_vn&vn_game=synthetic-game";
            instrumentation.runOnMainSync(()->view.loadDataWithBaseURL(stage,page("游戏舞台"),"text/html","UTF-8",stage));
            waitOrientation(activity,Configuration.ORIENTATION_LANDSCAPE);
            assertSame(view,field.get(activity));
            // A hidden/unregistered old document cannot rotate the live page.
            instrumentation.runOnMainSync(()->{
                WebView hidden=new WebView(activity);
                activity.requestOrientation(hidden,new Object(),"default");hidden.destroy();
            });
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,activity.getRequestedOrientation());
            instrumentation.runOnMainSync(()->view.loadDataWithBaseURL(base+"app/me.html",page("普通个人中心"),"text/html","UTF-8",base+"app/me.html"));
            waitOrientation(activity,Configuration.ORIENTATION_PORTRAIT);
            assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,activity.getRequestedOrientation());
            assertFalse(activity.isDestroyed());assertSame(view,field.get(activity));
        }finally{instrumentation.runOnMainSync(activity::finish);}
    }
    private static String page(String title){return "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>合成方向验收</title><body style='margin:0;background:#203744;color:white'><h1>"+title+"</h1><p>仅验证方向与原生生命周期，不读取任何账号或故事。</p>";}
    private static void installSyntheticResponse(WebView view,String url,String html){
        // A real loadUrl navigation is essential: loadDataWithBaseURL uses a
        // virtual history URL which does not track subsequent replaceState.
        // Only this exact synthetic document is intercepted in the test APK.
        WebViewClient product=view.getWebViewClient();
        view.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView owner,WebResourceRequest request){
                if(url.equals(request.getUrl().toString()))return new WebResourceResponse("text/html","UTF-8",
                        new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                return product.shouldInterceptRequest(owner,request);
            }
            @Override public void onPageStarted(WebView owner,String value,Bitmap icon){product.onPageStarted(owner,value,icon);}
            @Override public void onPageFinished(WebView owner,String value){product.onPageFinished(owner,value);}
            @Override public void doUpdateVisitedHistory(WebView owner,String value,boolean reload){product.doUpdateVisitedHistory(owner,value,reload);}
        });
    }
    private static String evaluate(Instrumentation instrumentation,WebView view,String script) throws Exception{
        CountDownLatch ready=new CountDownLatch(1);String[] result={null};
        instrumentation.runOnMainSync(()->view.evaluateJavascript(script,value->{result[0]=value;ready.countDown();}));
        assertTrue("WebView evaluation completed",ready.await(10,TimeUnit.SECONDS));return result[0];
    }
    private static void waitOrientation(HomerActivity activity,int expected) throws Exception{
        long deadline=System.currentTimeMillis()+10000;
        while(System.currentTimeMillis()<deadline){
            if(activity.getResources().getConfiguration().orientation==expected)return;
            Thread.sleep(100);
        }
        assertEquals(expected,activity.getResources().getConfiguration().orientation);
    }
}
