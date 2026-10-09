package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.*;
import org.junit.*;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;
import static org.nebula.horizon.composeai.ctf.ArchiveLandscapeUiTest.*;

/** Private downloaded media, shipping native bridge and real Spine WebView.
 * The normal workshop login/download is separate; game providers here are synthetic.
 */
public final class ArchiveWorkshopUiTest {
    @Test public void downloadedCharacterRendersAllAnimationsWithoutPrebundledAssets() throws Exception {
        Instrumentation test=InstrumentationRegistry.getInstrumentation();
        InputStream sample;
        try{sample=test.getContext().getAssets().open("archive-workshop-qa.zip");}
        catch(IOException missing){Assume.assumeTrue("optional authorized local sample is not shipped in tests",false);return;}
        File temporary=File.createTempFile("archive-workshop-qa-",".zip",test.getTargetContext().getCacheDir());
        try(InputStream input=sample;FileOutputStream output=new FileOutputStream(temporary)){input.transferTo(output);}
        JSONObject descriptor=new JSONObject().put("resource_id","608761ee-d235-437d-90f7-aa22d97786d8")
            .put("revision_id","d7c8d252-8f12-433c-acb2-f8d02daa6963").put("size",13494935)
            .put("sha256","3092b83304b64e7367274adb5379598e1b21f61daf93599d06ab1f97819033f2");
        try{new ArchiveWorkshopStore(test.getTargetContext()).install(temporary,descriptor);}finally{temporary.delete();}
        HomerActivity activity=(HomerActivity)test.startActivitySync(new Intent(test.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try{
            Field field=HomerActivity.class.getDeclaredField("liveView");field.setAccessible(true);WebView view=(WebView)field.get(activity);
            String html;try(InputStream input=test.getContext().getAssets().open("chatarchive_game_fixture.html")){html=new String(input.readAllBytes(),StandardCharsets.UTF_8);}
            String fixture=BuildConfig.SERVER_BASE_URL+"app/visual-novel.html?native=1&slot=workshop-native-"+UUID.randomUUID();
            final String page=html;
            test.runOnMainSync(()->{WebViewClient product=view.getWebViewClient();view.setWebViewClient(new WebViewClient(){
                @Override public WebResourceResponse shouldInterceptRequest(WebView owner,WebResourceRequest request){
                    if(fixture.equals(request.getUrl().toString()))return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream(page.getBytes(StandardCharsets.UTF_8)));
                    return product.shouldInterceptRequest(owner,request);
                }
                @Override public void onPageStarted(WebView owner,String url,Bitmap icon){product.onPageStarted(owner,url,icon);}
                @Override public void onPageFinished(WebView owner,String url){product.onPageFinished(owner,url);}
                @Override public void doUpdateVisitedHistory(WebView owner,String url,boolean reload){product.doUpdateVisitedHistory(owner,url,reload);}
            });view.loadUrl(fixture);});
            waitFor(test,view,"!!window.gameFixtureReady",30000);
            assertEquals(Configuration.ORIENTATION_LANDSCAPE,activity.getResources().getConfiguration().orientation);
            assertEquals("1",evaluate(test,view,"JSON.parse(HomerNative.getArchiveWorkshopCatalog()).roles.length"));
            tap(test,view,"document.querySelector('[data-game-new]')");
            evaluate(test,view,"var source=document.querySelector('[data-game-role-source]');source.value='workshop';source.dispatchEvent(new Event('change',{bubbles:true}));true");
            waitFor(test,view,"document.querySelectorAll('[data-game-roles] button').length===1",10000);
            tap(test,view,"document.querySelector('[data-game-roles] button')");tap(test,view,"document.querySelector('[data-game-create]')");
            waitFor(test,view,"gameFixture.reader?.spine?.renderState?.skeleton?.data?.animations.length===39",30000);
            waitFor(test,view,"gameFixture.reader.background.naturalWidth>0&&!gameFixture.reader.background.hidden",10000);
            waitFor(test,view,"(()=>{const c=gameFixture.reader.spine?.canvas;return c&&c.width>0&&c.height>0&&getComputedStyle(c).opacity==='1';})()",10000);
            // Ready skeleton data can precede actual compositor presentation.
            evaluate(test,view,"window.workshopPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{window.workshopPainted=true}));true");
            waitFor(test,view,"window.workshopPainted===true",10000);
            assertEquals("0",evaluate(test,view,"gameFixture.calls.filter(c=>c.kind==='generation').length"));
            screenshot(test,activity,"workshop-native-stage");
            tapReader(test,view,"立绘 / 场景");
            waitFor(test,view,"!!gameFixture.reader.panel",10000);
            assertEquals("39",evaluate(test,view,"gameFixture.reader.panel.body.querySelector('[aria-label=\"表情 / 动作（原资源编号）\"]').options.length"));
            evaluate(test,view,"gameFixture.reader.closeTopOverlay();true");tapReader(test,view,"私聊");
            waitFor(test,view,"gameFixture.reader.mode==='talk'&&!!gameFixture.reader.thread&&gameFixture.reader.textPanel.hidden",10000);
            evaluate(test,view,"window.workshopPainted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>{window.workshopPainted=true}));true");
            waitFor(test,view,"window.workshopPainted===true",10000);
            CountDownLatch presented=new CountDownLatch(1);
            test.runOnMainSync(()->view.postVisualStateCallback(1,new WebView.VisualStateCallback(){
                @Override public void onComplete(long requestId){presented.countDown();}
            }));
            assertTrue("Private DOM reached the native visual compositor",presented.await(10,TimeUnit.SECONDS));
            test.waitForIdleSync();Thread.sleep(500);screenshot(test,activity,"workshop-native-private");
            assertEquals("0",evaluate(test,view,"gameFixture.calls.filter(c=>c.kind==='generation').length"));
        }catch(Exception|AssertionError error){
            Field field=HomerActivity.class.getDeclaredField("liveView");field.setAccessible(true);
            try{screenshot(test,activity,"workshop-native-failure");}catch(Exception evidence){error.addSuppressed(evidence);}throw error;
        }finally{test.runOnMainSync(activity::finish);}
    }
}
