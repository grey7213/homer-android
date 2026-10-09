package org.nebula.horizon.composeai.ctf;

import android.app.*;
import android.content.*;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.*;
import android.net.Uri;
import android.view.*;
import android.webkit.*;
import androidx.core.graphics.Insets;
import androidx.core.view.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import static org.junit.Assert.*;

/** Actual embedded host; synthetic error/lifecycle tests are distinct from live site. */
public final class ArchiveWorkshopHostTest {
    private final Instrumentation test=InstrumentationRegistry.getInstrumentation();
    private static final String ID="11111111-2222-3333-4444-555555555555",REV="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    private ArchiveWorkshopActivity open(boolean dark){return (ArchiveWorkshopActivity)test.startActivitySync(new Intent(test.getTargetContext(),ArchiveWorkshopActivity.class).putExtra("dark",dark).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
    private View tagged(Activity a,String tag){final View[] result={null};test.runOnMainSync(()->result[0]=a.getWindow().getDecorView().findViewWithTag(tag));return result[0];}
    private WebView web(Activity a){return (WebView)tagged(a,"workshop-webview");}
    private String eval(WebView web,String js)throws Exception{CountDownLatch latch=new CountDownLatch(1);String[] value={null};test.runOnMainSync(()->web.evaluateJavascript(js,result->{value[0]=result;latch.countDown();}));assertTrue(latch.await(5,TimeUnit.SECONDS));return value[0];}
    private void waitDom(Activity a,String predicate)throws Exception{long end=System.currentTimeMillis()+25000;while(System.currentTimeMillis()<end){if("true".equals(eval(web(a),predicate)))return;Thread.sleep(100);}shot(a,"embedded-dom-failure");fail("expected rendered site controls not present");}
    private void ready(Activity a)throws Exception{long end=System.currentTimeMillis()+25000;while(System.currentTimeMillis()<end){final boolean[] done={false};test.runOnMainSync(()->done[0]=taggedOnMain(a,"workshop-feedback").getVisibility()==View.GONE);if(done[0])return;Thread.sleep(100);}shot(a,"embedded-not-ready");fail("site content was not rendered");}
    private View taggedOnMain(Activity a,String tag){return a.getWindow().getDecorView().findViewWithTag(tag);}
    private void fixture(WebView web,String url,String html,int status){fixture(web,url,html,status,true);}
    private void fixture(WebView web,String url,String html,int status,boolean load){test.runOnMainSync(()->{
        WebViewClient product=web.getWebViewClient();web.setWebViewClient(new WebViewClient(){
            @Override public WebResourceResponse shouldInterceptRequest(WebView owner,WebResourceRequest request){if(url.equals(request.getUrl().toString()))return new WebResourceResponse("text/html","UTF-8",status,status==200?"OK":"Unavailable",java.util.Collections.emptyMap(),new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));return product.shouldInterceptRequest(owner,request);}
            @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return product.shouldOverrideUrlLoading(v,r);}
            @Override public void onPageStarted(WebView v,String u,Bitmap icon){product.onPageStarted(v,u,icon);}
            @Override public void onPageFinished(WebView v,String u){product.onPageFinished(v,u);}
            @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){product.onReceivedError(v,r,e);}
            @Override public void onReceivedHttpError(WebView v,WebResourceRequest r,WebResourceResponse e){product.onReceivedHttpError(v,r,e);}
        });if(load)web.loadUrl(url);
    });}
    private String page(String body){return "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><body style='margin:0;padding:20px;background:#edf0f4;color:#182432'><main id=content aria-busy=false><h1>合成宿主验收</h1>"+body+"</main><script>window.retained=363</script>";}
    private void assertInsets(Activity a){test.waitForIdleSync();test.runOnMainSync(()->{
        View root=taggedOnMain(a,"workshop-root"),bar=taggedOnMain(a,"workshop-toolbar");Rect rect=new Rect();bar.getGlobalVisibleRect(rect);
        WindowInsetsCompat insets=ViewCompat.getRootWindowInsets(root);assertNotNull(insets);Insets safe=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
        assertEquals(safe.top,root.getPaddingTop());assertEquals(safe.left,root.getPaddingLeft());assertEquals(safe.right,root.getPaddingRight());assertTrue(rect.top>=safe.top);assertTrue(rect.left>=safe.left);assertTrue(bar.getHeight()>=48*a.getResources().getDisplayMetrics().density);
    });}
    @Test public void embeddedDocumentAndSafeAreasSurviveBothRotationsAndThemes()throws Exception{
        for(boolean dark:new boolean[]{false,true}){ArchiveWorkshopActivity a=open(dark);try{
            WebView original=web(a);fixture(original,ArchiveWorkshopClient.ORIGIN+"/qa-embedded/",page("<input placeholder='合成输入框'><p>完整网站占据正文区域</p>"),200);ready(a);
            test.runOnMainSync(()->a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));waitOrientation(a,Configuration.ORIENTATION_PORTRAIT);assertInsets(a);shot(a,"embedded-"+(dark?"dark":"light")+"-portrait");
            test.runOnMainSync(()->a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));waitOrientation(a,Configuration.ORIENTATION_LANDSCAPE);assertInsets(a);shot(a,"embedded-"+(dark?"dark":"light")+"-landscape");
            assertSame(original,web(a));assertFalse(a.isDestroyed());assertEquals("363",eval(original,"window.retained"));assertEquals("true",eval(original,"typeof HomerNative==='undefined'"));
        }finally{test.runOnMainSync(a::finish);}}
    }
    @Test public void mainFrameFailureShowsVisibleRetryThenRecovers()throws Exception{
        ArchiveWorkshopActivity a=open(true);try{
            // Deterministic synthetic HTTP failure. An arbitrary live 404
            // route can render the site's own error page and isn't an offline test.
            String url=ArchiveWorkshopClient.ORIGIN+"/qa-offline/";
            fixture(web(a),url,"<!doctype html><main id=content aria-busy=true></main>",200);
            waitDom(a,"location.pathname==='/qa-offline/'&&!!document.querySelector('main')");
            test.runOnMainSync(()->{
                WebResourceRequest request=new WebResourceRequest(){
                    @Override public Uri getUrl(){return Uri.parse(url);}
                    @Override public boolean isForMainFrame(){return true;}
                    @Override public boolean isRedirect(){return false;}
                    @Override public boolean hasGesture(){return false;}
                    @Override public String getMethod(){return "GET";}
                    @Override public java.util.Map<String,String> getRequestHeaders(){return java.util.Collections.emptyMap();}
                };
                webOnMain(a).getWebViewClient().onReceivedHttpError(webOnMain(a),request,
                    new WebResourceResponse("text/plain","UTF-8",503,"Unavailable",java.util.Collections.emptyMap(),new ByteArrayInputStream(new byte[0])));
            });
            assertEquals(View.VISIBLE,tagged(a,"workshop-feedback").getVisibility());assertEquals(View.VISIBLE,tagged(a,"workshop-retry").getVisibility());shot(a,"embedded-offline");
            fixture(web(a),url,page("<p>恢复成功</p>"),200,false);
            test.runOnMainSync(()->taggedOnMain(a,"workshop-retry").performClick());ready(a);assertEquals("363",eval(web(a),"window.retained"));
        }finally{test.runOnMainSync(a::finish);}
    }
    @Test public void htmlFinishedDoesNotClearFeedbackBeforeSiteJavascriptRenders()throws Exception{
        ArchiveWorkshopActivity a=open(false);try{
            String html="<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><main id=content aria-busy=true></main>";
            fixture(web(a),ArchiveWorkshopClient.ORIGIN+"/qa-delayed/",html,200);Thread.sleep(500);
            assertEquals(View.VISIBLE,tagged(a,"workshop-feedback").getVisibility());
            eval(web(a),"var m=document.querySelector('main');m.innerHTML='<h1>合成内容已呈现</h1>';m.setAttribute('aria-busy','false');true");ready(a);
        }finally{test.runOnMainSync(a::finish);}
    }
    @Test public void originsAndDownloadUrlsAreStrictAndDownloadNeedsExplicitConfirmation()throws Exception{
        assertTrue(ArchiveWorkshopActivity.navigationAllowed(ArchiveWorkshopClient.ORIGIN+"/characters/#search"));
        for(String bad:new String[]{"http://chatarchivemods.org/","https://chatarchivemods.org.evil/","https://user@chatarchivemods.org/","file:///sdcard/a","javascript:alert(1)"})assertFalse(ArchiveWorkshopActivity.navigationAllowed(bad));
        String url=ArchiveWorkshopClient.ORIGIN+"/download/"+REV+"/";assertEquals(REV,ArchiveWorkshopActivity.downloadRevision(url));assertNull(ArchiveWorkshopActivity.downloadRevision(url+"?url=https://evil.example/"));
        ArchiveWorkshopActivity a=open(false);try{
            Field clientField=ArchiveWorkshopActivity.class.getDeclaredField("client");clientField.setAccessible(true);int[] requests={0};
            test.runOnMainSync(()->{try{((ArchiveWorkshopClient)clientField.get(a)).close();clientField.set(a,new ArchiveWorkshopClient(new File(a.getCacheDir(),"qa-embedded-meta"),(u,c,l)->{
                requests[0]++;assertNull(c);assertTrue(u.endsWith("/api/resources/"+ID+"/"));
                JSONObject file=new JSONObject().put("revision_id",REV).put("sha256","a".repeat(64)).put("size",100).put("name","synthetic.zip").put("extension","zip");
                return new JSONObject().put("ok",true).put("data",new JSONObject().put("id",ID).put("title","合成作品").put("category","characters").put("file",file)).toString().getBytes(StandardCharsets.UTF_8);
            }));}catch(Exception e){throw new AssertionError(e);}});
            fixture(web(a),ArchiveWorkshopClient.ORIGIN+"/mods/"+ID+"/",page("<a id=download href='"+url+"'>下载</a>"),200);ready(a);
            eval(web(a),"document.querySelector('#download').click();true");Thread.sleep(750);
            test.getUiAutomation().waitForIdle(250,3000);
            test.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);Thread.sleep(200);
            assertEquals("only public metadata, no authorized file request before confirmation",1,requests[0]);
            assertEquals(View.GONE,tagged(a,"workshop-download-bar").getVisibility());assertEquals("true",eval(web(a),"location.pathname==='/mods/"+ID+"/'"));
        }finally{test.runOnMainSync(a::finish);}
    }
    @Test public void liveWebsiteCatalogDetailLoginAndBackRenderWithoutHomerBridge()throws Exception{
        ArchiveWorkshopActivity a=open(false);try{
            waitDom(a,"location.pathname==='/characters/'&&!!document.querySelector('main#content a[href*=\"/mods/\"]')");ready(a);assertInsets(a);shotSite(a,"embedded-live-catalog");
            String detail=ArchiveWorkshopClient.ORIGIN+"/mods/608761ee-d235-437d-90f7-aa22d97786d8/";
            test.runOnMainSync(()->webOnMain(a).loadUrl(detail));
            // Anonymous users correctly see the site's login-to-download link.
            waitDom(a,"location.pathname==='/mods/608761ee-d235-437d-90f7-aa22d97786d8/'&&!!document.querySelector('main#content a[href*=\"/download/\"],main#content a[href*=\"/login/\"]')");ready(a);shotSite(a,"embedded-live-detail");
            test.runOnMainSync(()->webOnMain(a).loadUrl(ArchiveWorkshopClient.ORIGIN+"/login/"));
            waitDom(a,"location.pathname==='/login/'&&!!document.querySelector('input[type=password]')&&typeof HomerNative==='undefined'");ready(a);shotSite(a,"embedded-live-login");
            test.runOnMainSync(a::onBackPressed);waitDom(a,"location.pathname==='/mods/608761ee-d235-437d-90f7-aa22d97786d8/'&&!!document.querySelector('main#content .file-name')");ready(a);
        }finally{test.runOnMainSync(a::finish);}
    }
    private WebView webOnMain(Activity a){return (WebView)taggedOnMain(a,"workshop-webview");}
    @Test public void liveAnonymousProtectedDownloadNeverWritesPackageBytes()throws Exception{
        File temp=File.createTempFile("qa-anonymous-",".part",test.getTargetContext().getCacheDir());
        try(ArchiveWorkshopClient live=new ArchiveWorkshopClient(new File(test.getTargetContext().getCacheDir(),"qa-live-public"))){
            ArchiveWorkshopClient.Item item=live.detail("608761ee-d235-437d-90f7-aa22d97786d8");assertTrue(item.importable());
            try{live.download(item.descriptor(),null,temp,p->{});fail("protected download cannot succeed anonymously");}catch(IOException expected){assertEquals("MOD_LOGIN_REQUIRED",expected.getMessage());}
            assertEquals(0,temp.length());
        }finally{temp.delete();}
    }
    private void waitOrientation(Activity a,int value)throws Exception{
        long end=System.currentTimeMillis()+10000;int settled=0;while(System.currentTimeMillis()<end){final boolean[] laidOut={false};test.runOnMainSync(()->{View root=taggedOnMain(a,"workshop-root");laidOut[0]=a.getResources().getConfiguration().orientation==value&&root.getWidth()>0&&root.getHeight()>0&&(value==Configuration.ORIENTATION_LANDSCAPE?root.getWidth()>root.getHeight():root.getHeight()>root.getWidth());});
            if(laidOut[0])settled++;else settled=0;if(settled>=6){test.waitForIdleSync();return;}Thread.sleep(150);}fail("rotation layout did not settle");
    }
    private void shot(Activity a,String name)throws Exception{
        // A WebView visual callback precedes removing the native overlay. Wait
        // for the resulting native frames as well, not an old compositor frame.
        CountDownLatch frames=new CountDownLatch(1);test.runOnMainSync(()->{
            View decor=a.getWindow().getDecorView();decor.postOnAnimation(new Runnable(){int count;@Override public void run(){if(++count>=3)frames.countDown();else decor.postOnAnimation(this);}});
        });assertTrue(frames.await(5,TimeUnit.SECONDS));test.waitForIdleSync();Thread.sleep(650);
        Bitmap bitmap=test.getUiAutomation().takeScreenshot();assertNotNull(bitmap);File path=new File(test.getTargetContext().getExternalFilesDir(null),name+".png");try(FileOutputStream out=new FileOutputStream(path)){assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));}finally{bitmap.recycle();}
    }
    private void shotSite(Activity a,String name)throws Exception{
        // DOM visibility is not proof the platform has replaced its launch
        // snapshot. The real site's blue body/header must reach the screenshot;
        // the host's white/pink connecting overlay cannot satisfy this gate.
        long end=System.currentTimeMillis()+10000;
        do{shot(a,name);Bitmap bitmap=BitmapFactory.decodeFile(new File(test.getTargetContext().getExternalFilesDir(null),name+".png").getAbsolutePath());int blue=0;
            try{for(int y=bitmap.getHeight()/8;y<bitmap.getHeight()*7/8;y+=3)for(int x=0;x<bitmap.getWidth();x+=3){int c=bitmap.getPixel(x,y);if(Color.blue(c)>Color.red(c)+15&&Color.green(c)>Color.red(c)+10)blue++;}}
            finally{bitmap.recycle();}if(blue>500)return;Thread.sleep(300);
        }while(System.currentTimeMillis()<end);fail("actual website did not reach native pixels");
    }
}
