package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONTokener;
import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** Actual app assets, native private media, touch and IME; synthetic providers only. */
public final class ArchiveLandscapeUiTest {
    @Test public void landscapeStageAndPrivateComposerRemainUsableWithNativeKeyboard() throws Exception {
        Instrumentation test=InstrumentationRegistry.getInstrumentation();
        Intent intent=new Intent(test.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        HomerActivity activity=(HomerActivity)test.startActivitySync(intent);
        try {
            test.runOnMainSync(()->activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            Field field=HomerActivity.class.getDeclaredField("liveView");field.setAccessible(true);
            WebView view=(WebView)field.get(activity);
            String html;
            try(InputStream input=test.getContext().getAssets().open("chatarchive_game_fixture.html")) {
                html=new String(input.readAllBytes(),StandardCharsets.UTF_8);
            }
            String fixture=BuildConfig.SERVER_BASE_URL+"app/visual-novel.html?archive=1&native=1&slot=native-"+UUID.randomUUID();
            final String page=html;
            test.runOnMainSync(()->{
                WebViewClient product=view.getWebViewClient();
                view.setWebViewClient(new WebViewClient(){
                    @Override public WebResourceResponse shouldInterceptRequest(WebView owner,WebResourceRequest request){
                        if(fixture.equals(request.getUrl().toString()))return new WebResourceResponse("text/html","UTF-8",
                                new ByteArrayInputStream(page.getBytes(StandardCharsets.UTF_8)));
                        return product.shouldInterceptRequest(owner,request);
                    }
                    @Override public void onPageStarted(WebView owner,String url,Bitmap icon){product.onPageStarted(owner,url,icon);}
                    @Override public void onPageFinished(WebView owner,String url){product.onPageFinished(owner,url);}
                    @Override public void doUpdateVisitedHistory(WebView owner,String url,boolean reload){product.doUpdateVisitedHistory(owner,url,reload);}
                });
                view.loadUrl(fixture);
            });
            waitFor(test,view,"!!window.gameFixtureReady",30000);
            assertEquals(Configuration.ORIENTATION_LANDSCAPE,activity.getResources().getConfiguration().orientation);
            tap(test,view,"document.querySelector('[data-game-new]')");
            waitFor(test,view,"document.querySelectorAll('[data-game-roles] button').length>0",10000);
            evaluate(test,view,"const q=document.querySelector('[data-game-role-query]');q.value='早濑优香';q.dispatchEvent(new Event('input',{bubbles:true}));true");
            tap(test,view,"document.querySelector('[data-game-role-search]')");
            waitFor(test,view,"[...document.querySelectorAll('[data-game-roles] button')].some(n=>n.textContent.trim()==='早濑优香')",10000);
            tap(test,view,"[...document.querySelectorAll('[data-game-roles] button')].find(n=>n.textContent.trim()==='早濑优香')");
            waitFor(test,view,"!document.querySelector('[data-game-create]').disabled",10000);
            tap(test,view,"document.querySelector('[data-game-create]')");
            waitFor(test,view,"!!gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length",30000);
            stateEvidence(test,activity,view,"stage-initial-state");
            mediaEvidence(test,activity,view);
            waitFor(test,view,"gameFixture.reader.shadow.querySelector('.background').naturalWidth>1000",10000);
            evaluate(test,view,"new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
            assertEquals("true",evaluate(test,view,"JSON.parse(HomerNative.getArchiveMediaStatus()).packs.includes('yuuka')"));
            assertEquals("0",evaluate(test,view,"gameFixture.calls.filter(c=>c.kind==='generation').length"));
            assertEquals("true",evaluate(test,view,"document.querySelector('#reader').getBoundingClientRect().y===0"));
            screenshot(test,activity,"stage-landscape");
            tapReader(test,view,"私聊");
            waitFor(test,view,"gameFixture.reader.mode==='talk' && !!gameFixture.reader.talkInput",10000);
            int before=((Number)new JSONTokener(evaluate(test,view,"innerHeight")).nextValue()).intValue();
            tap(test,view,"gameFixture.reader.talkInput");
            waitFor(test,view,"innerHeight<"+(before-60),10000);
            waitViewportStable(test,view,before-60);
            stateEvidence(test,activity,view,"private-keyboard-state");
            assertEquals("true",evaluate(test,view,"(()=>{const r=gameFixture.reader.talkInput.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight+1})()"));
            assertEquals("true",evaluate(test,view,"(()=>{const r=gameFixture.reader.talkSend.getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight+1})()"));
            screenshot(test,activity,"private-native-keyboard");
            test.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor(test,view,"innerHeight>="+before,10000);
            waitViewportStable(test,view,Integer.MAX_VALUE);
            assertEquals("talk",new JSONTokener(evaluate(test,view,"gameFixture.reader.mode")).nextValue());
            tapReader(test,view,"剧情");
            waitFor(test,view,"gameFixture.reader.mode==='stage'",10000);
            tapReader(test,view,"输入");
            waitFor(test,view,"!!gameFixture.reader.panel",10000);
            // The product focuses this field when opening. Re-tapping during
            // the native resize animation can hit the backdrop instead.
            assertEquals("true",evaluate(test,view,"gameFixture.reader.shadow.activeElement===gameFixture.reader.panel.body.querySelector('textarea')"));
            waitFor(test,view,"innerHeight<"+(before-60),10000);
            waitViewportStable(test,view,before-60);
            stateEvidence(test,activity,view,"stage-keyboard-state");
            assertEquals("true",evaluate(test,view,"(()=>{const r=gameFixture.reader.panel.body.querySelector('textarea').getBoundingClientRect();return r.y>=0&&r.bottom<=innerHeight+1})()"));
            assertEquals("Textarea must not be clipped by its scrolling body or action footer","true",evaluate(test,view,"(()=>{const p=gameFixture.reader.panel,r=p.body.querySelector('textarea').getBoundingClientRect(),b=p.body.getBoundingClientRect(),f=p.sheet.querySelector('footer').getBoundingClientRect();return r.height>=44&&r.y>=b.y&&r.bottom<=b.bottom+1&&r.bottom<=f.top+1&&f.bottom<=innerHeight+1})()"));
            screenshot(test,activity,"stage-native-keyboard");
            assertEquals("Keyboard must remain open through screenshot capture","true",evaluate(test,view,"innerHeight<"+(before-60)));
            test.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor(test,view,"innerHeight>="+before,10000);
            test.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor(test,view,"!gameFixture.reader.panel",10000);
            assertSame(view,field.get(activity));assertFalse(activity.isDestroyed());
            assertEquals("0",evaluate(test,view,"gameFixture.calls.filter(c=>c.kind==='generation').length"));
        } catch(Exception|AssertionError error) {
            try{screenshot(test,activity,"failure");}catch(Exception evidenceError){error.addSuppressed(evidenceError);}
            throw error;
        } finally { test.runOnMainSync(activity::finish); }
    }
    static void tapReader(Instrumentation test,WebView view,String label) throws Exception {
        tap(test,view,"[...gameFixture.reader.shadow.querySelectorAll('button')].find(n=>n.textContent.trim()==="+org.json.JSONObject.quote(label)+")");
    }
    static void tap(Instrumentation test,WebView view,String expression) throws Exception {
        String pointJson=evaluate(test,view,"(()=>{try{const n="+expression+";if(!n||n.disabled)throw Error('Control unavailable');const r=n.getBoundingClientRect();if(r.width<=0||r.height<=0||r.y<0||r.bottom>innerHeight+1)throw Error('Control outside viewport '+JSON.stringify(r.toJSON())+' viewport '+innerWidth+'x'+innerHeight);return [r.x+r.width/2,r.y+r.height/2,innerWidth,innerHeight]}catch(error){return {error:String(error.message)}}})()");
        assertTrue("Native touch geometry for "+expression+": "+pointJson,pointJson!=null&&pointJson.startsWith("["));
        JSONArray point=new JSONArray(pointJson);
        int[] origin=new int[2],size=new int[2];
        test.runOnMainSync(()->{view.getLocationOnScreen(origin);size[0]=view.getWidth();size[1]=view.getHeight();});
        float x=(float)(origin[0]+point.getDouble(0)*size[0]/point.getDouble(2));
        float y=(float)(origin[1]+point.getDouble(1)*size[1]/point.getDouble(3));
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0);
        MotionEvent up=MotionEvent.obtain(now,now+40,MotionEvent.ACTION_UP,x,y,0);
        try { test.sendPointerSync(down);test.sendPointerSync(up); } finally {down.recycle();up.recycle();}
    }
    static String evaluate(Instrumentation test,WebView view,String script) throws Exception {
        CountDownLatch done=new CountDownLatch(1);String[] value={null};
        test.runOnMainSync(()->view.evaluateJavascript(script,result->{value[0]=result;done.countDown();}));
        assertTrue("WebView response",done.await(10,TimeUnit.SECONDS));return value[0];
    }
    static void waitFor(Instrumentation test,WebView view,String condition,long timeout) throws Exception {
        long deadline=SystemClock.uptimeMillis()+timeout;
        do {if("true".equals(evaluate(test,view,condition)))return;Thread.sleep(100);}while(SystemClock.uptimeMillis()<deadline);
        fail("Native UI condition not met: "+condition);
    }
    private static void waitViewportStable(Instrumentation test,WebView view,int maximumHeight) throws Exception {
        String last="";int stable=0;long deadline=SystemClock.uptimeMillis()+5000;
        while(SystemClock.uptimeMillis()<deadline){
            String value=evaluate(test,view,"[innerHeight,visualViewport?.height,visualViewport?.offsetTop]");
            int height=((Number)new JSONTokener(evaluate(test,view,"innerHeight")).nextValue()).intValue();
            stable=height<=maximumHeight&&value.equals(last)?stable+1:0;last=value;if(stable>=4)return;Thread.sleep(100);
        }
        fail("Native keyboard viewport did not settle");
    }
    static void screenshot(Instrumentation test,HomerActivity activity,String name) throws Exception {
        File directory=new File(activity.getExternalFilesDir(null),"archive-landscape-evidence");
        assertTrue(directory.isDirectory()||directory.mkdirs());
        Bitmap bitmap=test.getUiAutomation().takeScreenshot();assertNotNull(bitmap);
        try(FileOutputStream output=new FileOutputStream(new File(directory,name+".png"))){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,output));}
        finally{bitmap.recycle();}
    }
    private static void stateEvidence(Instrumentation test,HomerActivity activity,WebView view,String name) throws Exception {
        String state=evaluate(test,view,"(()=>{const r=gameFixture.reader,b=r.shadow.querySelector('.background'),c=r.spine?.canvas;return {viewport:[innerWidth,innerHeight,devicePixelRatio,visualViewport?.height,visualViewport?.offsetTop],background:{url:b?.getAttribute('src'),width:b?.naturalWidth,hidden:b?.hidden},spine:{rect:c?.getBoundingClientRect().toJSON(),opacity:c?.style.opacity,hidden:r.spine?.hidden,lost:r.spine?.contextLost},status:r.status?.textContent,input:(r.talkInput||r.panel?.body.querySelector('textarea'))?.getBoundingClientRect().toJSON()}})()");
        int[] size=new int[2];test.runOnMainSync(()->{size[0]=view.getWidth();size[1]=view.getHeight();});
        File directory=new File(activity.getExternalFilesDir(null),"archive-landscape-evidence");
        assertTrue(directory.isDirectory()||directory.mkdirs());
        try(FileOutputStream output=new FileOutputStream(new File(directory,name+".json"))){
            output.write(("{\"nativeSize\":["+size[0]+","+size[1]+"],\"dom\":"+state+"}").getBytes(StandardCharsets.UTF_8));
        }
    }
    private static void mediaEvidence(Instrumentation test,HomerActivity activity,WebView view) throws Exception {
        evaluate(test,view,"window.archiveMediaProbe=null;void(async()=>{const r=gameFixture.reader,s=r.resolveArchiveScene({},r.card.name),a=s?.background;const result=await r.assetCache.resolve(a);const response=await fetch(a.url);window.archiveMediaProbe={secure:isSecureContext,digest:typeof crypto?.subtle?.digest,asset:a,result,response:{status:response.status,type:response.headers.get('content-type'),bytes:(await response.arrayBuffer()).byteLength}};r.assetCache.release(result.url)})();true");
        waitFor(test,view,"!!window.archiveMediaProbe",10000);
        String state=evaluate(test,view,"window.archiveMediaProbe");
        File directory=new File(activity.getExternalFilesDir(null),"archive-landscape-evidence");
        assertTrue(directory.isDirectory()||directory.mkdirs());
        try(FileOutputStream output=new FileOutputStream(new File(directory,"media-probe.json"))){
            output.write(state.getBytes(StandardCharsets.UTF_8));
        }
    }
}
