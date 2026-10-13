package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

/** Ordinary shipping Activity/clients/bridges; synthetic loopback service only.
 * No replacement WebView, suppressed handler or privileged ready-state bypass. */
public final class ModReturnRuntimeTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private WebView view;
    private HomerActivity host;
    private static final String BASE = "http://127.0.0.1:8817";
    private static final String FRAME = "document.querySelector('#dialogue-frame')";
    private static final String DOC = FRAME + ".contentDocument";
    private Object field(String name) throws Exception {
        Field f=HomerActivity.class.getDeclaredField(name);f.setAccessible(true);return f.get(host);
    }
    private String evaluate(String script) throws Exception {
        CountDownLatch latch=new CountDownLatch(1);String[] value={null};
        test.runOnMainSync(()->{
            if(host!=null)try{view=(WebView)field("liveView");}catch(Exception e){throw new AssertionError(e);}
            view.evaluateJavascript(script,result->{value[0]=result;latch.countDown();});
        });
        assertTrue("Evaluation completed",latch.await(10,TimeUnit.SECONDS));return value[0];
    }
    private void waitFor(String condition,int seconds) throws Exception {
        long end=SystemClock.uptimeMillis()+seconds*1000L;
        do{if("true".equals(evaluate(condition)))return;Thread.sleep(40);}while(SystemClock.uptimeMillis()<end);
        fail("Timed out: "+condition+"; diagnostics="+evaluate("JSON.stringify((()=>{const f=document.querySelector('#dialogue-frame'),d=f?.contentDocument,w=d?.defaultView;return {route:location.pathname,host:document.body?.className,frame:f?new URL(f.src).pathname:null,child:d?.documentElement?.className,messageCount:w?.SillyTavern?.getContext?.().chat?.length,gate:d?.querySelector('#homer-runtime-gate')?.textContent,marks:w?.performance.getEntriesByType('mark').filter(m=>/^homer-(bootstrap|switch|session|card|prewarm)/.test(m.name)).map(m=>({name:m.name,ms:Math.round(m.startTime)}))}})())"));
    }
    private void touch(String element,String offset,int holdMs) throws Exception {
        waitFor("(()=>{const e="+element+";return !!e&&!e.disabled&&e.getBoundingClientRect().width>0})()",15);
        evaluate("("+element+").scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})");
        waitFor("(()=>{const e="+element+",r=e.getBoundingClientRect(),d=e.ownerDocument,w=d.defaultView,x=r.x+r.width/2,y=r.y+r.height/2,h=d.elementFromPoint(x,y);return x>=0&&y>=0&&x<w.innerWidth&&y<w.innerHeight&&!!h&&(h===e||e.contains(h))})()",15);
        waitFor("(()=>{let e="+element+";for(;e;e=e.parentElement)if(e.getAnimations().some(a=>a.playState==='running'&&a.effect.getComputedTiming().iterations!==Infinity))return false;return true})()",10);
        // Native smooth scrolling is not a Web Animation. Confirm the actual
        // rectangle stopped moving before deriving screen coordinates.
        evaluate("window.r371TouchRectangle=null");
        waitFor("(()=>{const r=("+element+").getBoundingClientRect(),p=window.r371TouchRectangle;window.r371TouchRectangle={x:r.x,y:r.y,w:r.width,h:r.height};return !!p&&Math.abs(p.x-r.x)<1&&Math.abs(p.y-r.y)<1&&p.w===r.width&&p.h===r.height})()",10);
        JSONArray point=new JSONArray(evaluate("(()=>{const r=("+element+").getBoundingClientRect(),o="+offset+";return [r.x+r.width/2+o.x,r.y+r.height/2+o.y,innerWidth]})()"));
        float scale=view.getWidth()/(float)point.getDouble(2),x=(float)point.getDouble(0)*scale,y=(float)point.getDouble(1)*scale;
        int[] screen=new int[2];test.runOnMainSync(()->view.getLocationOnScreen(screen));
        long now=SystemClock.uptimeMillis();
        MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x+screen[0],y+screen[1],0);
        test.sendPointerSync(down);down.recycle();
        if(holdMs>0)Thread.sleep(holdMs);
        MotionEvent up=MotionEvent.obtain(now,SystemClock.uptimeMillis(),MotionEvent.ACTION_UP,x+screen[0],y+screen[1],0);
        test.sendPointerSync(up);up.recycle();
    }
    private void tap(String element) throws Exception {touch(element,"({x:0,y:0})",40);}
    private void runtimeTap(String selector) throws Exception {touch(DOC+".querySelector("+org.json.JSONObject.quote(selector)+")",FRAME+".getBoundingClientRect()",40);}
    @Test public void actualModWorkshopBackRetainsChatAndRichMessageActions() throws Exception {
        org.junit.Assume.assumeTrue(BuildConfig.APPLICATION_ID.endsWith(".returnqa"));
        assertEquals(BASE+"/",BuildConfig.SERVER_BASE_URL);
        QaWebViewActivity stage=(QaWebViewActivity)test.startActivitySync(new Intent(test.getTargetContext(),QaWebViewActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try{
            test.runOnMainSync(()->{view=new WebView(stage);view.getSettings().setJavaScriptEnabled(true);view.getSettings().setDomStorageEnabled(true);stage.setContentView(view);view.loadUrl(BASE+"/qa/setup");});
            waitFor("!!document.querySelector('#qa-seeded')",30);
            HomerCacheDatabase db=new HomerCacheDatabase(test.getTargetContext());
            try{db.setAccountScope("activity-cold-synthetic-owner");}finally{db.close();}
        }finally{test.runOnMainSync(()->{view.destroy();stage.finish();});}
        host=(HomerActivity)test.startActivitySync(new Intent(test.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try{
            waitFor("location.pathname==='/app/community.html'&&!!document.querySelector('a[href=\"/app/histories.html\"]')",40);
            // Use the real anchor action to select the fixture archive page.
            // Mod/Back and rich-message holds below use actual native input.
            evaluate("document.querySelector('a[href=\"/app/histories.html\"]').click()");
            waitFor("location.pathname==='/app/histories.html'&&!!document.querySelector('.history-row__main')",40);
            evaluate("document.querySelector('.history-row__main').click()");
            waitFor("document.body.classList.contains('is-ready')&&"+FRAME+"?.contentWindow?.SillyTavern?.getContext?.().chat?.length===1",90);
            WebView retained=view;
            String origin=evaluate(FRAME+".contentWindow.performance.timeOrigin");
            String initial=evaluate(FRAME+".contentWindow.SillyTavern.getContext().chat[0].mes");
            // Repeated complete real Mod → native retained workshop → Android Back.
            for(int iteration=0;iteration<5;iteration++){
                tap("document.querySelector('#preview-settings')");
                tap("document.querySelector('[data-runtime-section=mod]')");
                waitFor(DOC+".querySelector('#homer-mod-dialog')?.open",20);
                runtimeTap("#homer-mod-dialog .homer-mod-library-link");
                waitFor("location.pathname==='/app/workshop.html'",40);
                test.runOnMainSync(()->host.onBackPressed());
                waitFor("location.pathname==='/app/chat.html'&&document.body.classList.contains('is-ready')",20);
                assertSame("Same native chat WebView",retained,view);
                assertEquals("Same runtime document",origin,evaluate(FRAME+".contentWindow.performance.timeOrigin"));
                assertEquals("Opening retained",initial,evaluate(FRAME+".contentWindow.SillyTavern.getContext().chat[0].mes"));
                assertFalse("No Mod dialog left open","true".equals(evaluate(DOC+".querySelector('#homer-mod-dialog').open")));
                View snapshot=(View)field("snapshotView");assertNotEquals("No startup snapshot revealed",View.VISIBLE,snapshot.getVisibility());
            }
            System.out.println("R368_NATIVE_MOD_RETURN_LOOPS=5; RETAINED_DOCUMENT=true");
            System.out.println("R368_RENDER_DIAGNOSTIC="+evaluate("JSON.stringify((()=>{const w="+FRAME+".contentWindow,c=w.SillyTavern.getContext();return {text:c.chat[0]?.mes.slice(0,40),card:c.characters[c.characterId]?.data?.name,regex:c.characters[c.characterId]?.data?.extensions?.regex_scripts?.map(r=>({id:r.id,disabled:r.disabled})),renderer:c.extensionSettings?.tavern_helper?.render,frames:"+DOC+".querySelectorAll('#chat iframe').length}})())"));
            waitFor(DOC+".querySelector('#chat iframe[id^=TH-message]')?.contentDocument?.querySelector('#r368-text')!=null",15);
            String rich=DOC+".querySelector('#chat iframe[id^=TH-message]')";
            touch(rich+".contentDocument.querySelector('#r368-text')","(()=>{const a="+FRAME+".getBoundingClientRect(),b="+rich+".getBoundingClientRect();return {x:a.x+b.x,y:a.y+b.y}})()",650);
            waitFor(DOC+".querySelector('#homer-message-menu-dialog')?.open",20);
            assertEquals("Native long-press did not select text","0",evaluate(rich+".contentWindow.getSelection().toString().length"));
            assertEquals("Rollback enabled","false",evaluate(DOC+".querySelector('[data-homer-message-menu-action=rollback]').disabled"));
            System.out.println("R368_NATIVE_MOD_RETURN_LOOPS=5; RETAINED_DOCUMENT=true; RICH_LONG_PRESS_MENU=true; ROLLBACK_ENABLED=true");
            runtimeTap("[data-homer-message-menu-action=rollback]");
            waitFor(DOC+".querySelector('#homer-rollback-dialog')?.open",15);
            runtimeTap("#homer-rollback-dialog button[value=cancel]");
            waitFor("!"+DOC+".querySelector('#homer-rollback-dialog')",15);
            assertEquals("Cancel preserves opening",initial,evaluate(FRAME+".contentWindow.SillyTavern.getContext().chat[0].mes"));
            // Complete A/B/A with actual supplied Daoyuan, measuring final HTML,
            // not just an internal bridge-ready flag. No production account.
            for(String target:new String[]{"qa-b","qa-a","qa-b","qa-a"}){
                tap("document.querySelector('#preview-menu')");
                waitFor("document.querySelector('[data-conversation-id=\""+target+"\"]')!=null",15);
                evaluate("(()=>{window.r371ClickAt=0;const button=document.querySelector('[data-conversation-id=\""+target+"\"]');button.addEventListener('click',()=>{window.r371ClickAt=performance.now()},{capture:true,once:true})})()");
                long started=SystemClock.uptimeMillis();
                tap("document.querySelector('[data-conversation-id=\""+target+"\"]')");
                waitFor("!"+DOC+".body.classList.contains('homer-switching-chat')&&"+FRAME+".contentWindow.SillyTavern.getContext().chatMetadata.homer_bridge.conversation_id==='"+target+"'",45);
                waitFor("(()=>{const f="+DOC+".querySelector('#chat iframe[id^=TH-message]');return f?.contentDocument?.readyState==='complete'&&f.contentDocument.body?.textContent.trim().length>0&&f.getBoundingClientRect().height>100})()",45);
                System.out.println("R371_NATIVE_FINAL_CARD="+target+"; MS="+(SystemClock.uptimeMillis()-started));
                System.out.println("R371_NATIVE_CLICK_TO_OBSERVED_FRAME="+target+"; MS="+evaluate("Math.round(performance.now()-window.r371ClickAt)"));
                System.out.println("R371_NATIVE_RESOURCE_TIMING="+evaluate("JSON.stringify((()=>{const w="+FRAME+".contentWindow,d="+DOC+";return {marks:w.performance.getEntriesByType('mark').filter(m=>m.name.startsWith('homer-switch')).slice(-5).map(m=>({name:m.name,ms:Math.round(m.startTime)})),frames:[...d.querySelectorAll('#chat iframe')].map(f=>({state:f.contentDocument?.readyState,resources:f.contentWindow?.performance.getEntriesByType('resource').filter(r=>r.duration>400).map(r=>({host:new URL(r.name,w.location.href).hostname,path:new URL(r.name,w.location.href).pathname,ms:Math.round(r.duration)}))}))}})())"));
                assertEquals("No engine reload on card switch",origin,evaluate(FRAME+".contentWindow.performance.timeOrigin"));
                if (target.equals("qa-b")) {
                    String cardFrame=DOC+".querySelector('#chat iframe[id^=TH-message]')";
                    evaluate("(()=>{const d="+cardFrame+".contentDocument;d.defaultView.r371PassiveText=[...d.querySelectorAll('p,h1,h2,h3,span')].find(e=>e.textContent.trim()&&!e.closest('button,a,input,textarea,select,[role=button],[onclick]')&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)})()");
                    waitFor(cardFrame+".contentWindow.r371PassiveText!=null",10);
                    String sourceBefore=evaluate(FRAME+".contentWindow.SillyTavern.getContext().chat[0].mes");
                    touch(cardFrame+".contentWindow.r371PassiveText","(()=>{const a="+FRAME+".getBoundingClientRect(),b="+cardFrame+".getBoundingClientRect();return {x:a.x+b.x,y:a.y+b.y}})()",650);
                    waitFor(DOC+".querySelector('#homer-message-menu-dialog')?.open",15);
                    assertEquals("Daoyuan body does not select native text","0",evaluate(cardFrame+".contentWindow.getSelection().toString().length"));
                    runtimeTap("[data-homer-message-menu-action=rollback]");
                    waitFor(DOC+".querySelector('#homer-rollback-dialog')?.open",15);
                    runtimeTap("#homer-rollback-dialog button[value=cancel]");
                    waitFor("!"+DOC+".querySelector('#homer-rollback-dialog')",15);
                    assertTrue("Cancel preserves the real card opening",sourceBefore.equals(evaluate(FRAME+".contentWindow.SillyTavern.getContext().chat[0].mes")));
                    System.out.println("R371_NATIVE_DAOYUAN_BODY_HOLD_AND_ROLLBACK_CANCEL=true");
                }
            }
            rich=DOC+".querySelector('#chat iframe[id^=TH-message]')";
            touch(rich+".contentDocument.querySelector('#r368-text')","(()=>{const a="+FRAME+".getBoundingClientRect(),b="+rich+".getBoundingClientRect();return {x:a.x+b.x,y:a.y+b.y}})()",650);
            waitFor(DOC+".querySelector('#homer-message-menu-dialog')?.open",15);
            runtimeTap("[data-homer-message-menu-action=rollback]");
            waitFor(DOC+".querySelector('#homer-rollback-dialog')?.open",15);
            runtimeTap("#homer-rollback-dialog button[value=confirm]");
            waitFor(FRAME+".contentWindow.SillyTavern.getContext().chat.length===0&&!"+DOC+".body.classList.contains('homer-rollback-busy')",30);
            System.out.println("R371_NATIVE_ROLLBACK_CANCEL=true; COMMIT=true; EMPTY_CANONICAL_CHAT=true");
        }finally{test.runOnMainSync(host::finish);}
    }
}
