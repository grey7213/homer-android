package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.webkit.WebView;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.lang.reflect.Field;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;

/** The genuine Activity's lifecycle and packaged runtime, private synthetic
 * services. Seed first, force-stop `.coldqa`, then run the cold method alone.
 * No handler cancellation, replacement WebView/client or ready-state bypass. */
public final class ActivityRuntimeColdTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private static final String BASE = "http://127.0.0.1:8817";
    private WebView view;
    private HomerActivity host;
    private String evaluate(String script) throws Exception {
        CountDownLatch ready = new CountDownLatch(1); String[] result = {null};
        test.runOnMainSync(() -> {
            if (host != null) try {
                Field live = HomerActivity.class.getDeclaredField("liveView"); live.setAccessible(true); view = (WebView) live.get(host);
            } catch (Exception error) { throw new AssertionError(error); }
            view.evaluateJavascript(script, value -> { result[0] = value; ready.countDown(); });
        });
        assertTrue("Evaluation completed", ready.await(10, TimeUnit.SECONDS)); return result[0];
    }
    private void waitFor(String condition, int seconds) throws Exception {
        long end = SystemClock.uptimeMillis() + seconds * 1000L;
        while (SystemClock.uptimeMillis() < end) {
            if ("true".equals(evaluate(condition))) return;
            Thread.sleep(30);
        }
        fail("Actual Activity failed: " + condition + "; diagnostics=" + evaluate(diagnostics()));
    }
    private void isolate() {
        org.junit.Assume.assumeTrue("Opt-in isolated Activity benchmark only", BuildConfig.APPLICATION_ID.endsWith(".coldqa"));
        assertEquals(BASE + "/", BuildConfig.SERVER_BASE_URL);
    }
    private String diagnostics() {
        return "JSON.stringify((()=>{const d=document.querySelector('#dialogue-frame')?.contentDocument;const w=d?.defaultView;return {url:location.pathname,host:document.body?.className,child:d?.documentElement?.className,count:w?.SillyTavern?.getContext?.().chat?.length,marks:w?.performance.getEntriesByType('mark').filter(e=>/^homer-(native|prewarm|bootstrap|session|card|switch|settings)/.test(e.name)).map(e=>({name:e.name,ms:Math.round(e.startTime)})),error:d?.querySelector('#homer-runtime-gate')?.textContent}})())";
    }
    @Test public void seedPrivateScopeForSeparateColdProcess() throws Exception {
        isolate();
        QaWebViewActivity stage = (QaWebViewActivity) test.startActivitySync(new Intent(test.getTargetContext(), QaWebViewActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            test.runOnMainSync(() -> {
                view = new WebView(stage); view.getSettings().setJavaScriptEnabled(true); view.getSettings().setDomStorageEnabled(true);
                stage.setContentView(view); view.loadUrl(BASE + "/qa/setup");
            });
            waitFor("!!document.querySelector('#qa-seeded')", 20);
            HomerCacheDatabase db = new HomerCacheDatabase(test.getTargetContext());
            try {
                assertTrue(db.setAccountScope("activity-cold-synthetic-owner"));
                db.saveLastUrl(BASE + "/app/chat.html?app_id=qa-card-a&conversation_id=qa-a");
            } finally { db.close(); }
        } finally { test.runOnMainSync(() -> { view.destroy(); stage.finish(); }); }
    }
    private long tap(String selector) throws Exception {
        waitFor("(()=>{const e=" + selector + ";if(!e||e.disabled)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'})()", 10);
        // Drawer transitions change coordinates after its button becomes
        // visible. Wait for the real finite ancestor animation, not a fixed
        // sleep and never finish/disable product animations for the test.
        waitFor("(()=>{let e="+selector+";for(;e;e=e.parentElement){if(e.getAnimations().some(a=>a.playState==='running'&&a.effect.getComputedTiming().iterations!==Infinity))return false;}return true})()",10);
        JSONArray xy = new JSONArray(evaluate("(()=>{const e=" + selector + ";const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,innerWidth]})()"));
        float scale = view.getWidth() / (float) xy.getDouble(2), x = (float) xy.getDouble(0) * scale, y = (float) xy.getDouble(1) * scale;
        long[] started={0};
        test.runOnMainSync(() -> { long now = started[0] = SystemClock.uptimeMillis(); MotionEvent down = MotionEvent.obtain(now,now,0,x,y,0), up = MotionEvent.obtain(now,now+40,1,x,y,0); view.dispatchTouchEvent(down); view.dispatchTouchEvent(up); down.recycle(); up.recycle(); });
        return started[0];
    }
    @Test public void coldActivityRetainedHistoryAndMemory() throws Exception {
        isolate();
        long begin = SystemClock.uptimeMillis();
        HomerActivity activity = (HomerActivity) test.startActivitySync(new Intent(test.getTargetContext(), HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        host = activity;
        JSONObject metrics = new JSONObject();
        try {
            Field live = HomerActivity.class.getDeclaredField("liveView"); live.setAccessible(true); view = (WebView) live.get(activity);
            waitFor("location.pathname==='/app/community.html' && !!document.querySelector('a[href=\"/app/histories.html\"]')", 30);
            System.out.println("ACTIVITY_HOME_MS=" + (SystemClock.uptimeMillis()-begin));
            metrics.put("home_from_activity_launch_ms",SystemClock.uptimeMillis()-begin);
            tap("document.querySelector('a[href=\"/app/histories.html\"]')");
            waitFor("location.pathname==='/app/histories.html' && document.querySelectorAll('.history-row').length===3", 30);
            long chatBegin=tap("document.querySelector('.history-row__main')");
            String ready = "document.body?.classList.contains('is-ready') && document.querySelector('#dialogue-frame')?.contentWindow?.SillyTavern?.getContext?.().chat?.length===1101";
            waitFor(ready, 90);
            long cold = SystemClock.uptimeMillis() - begin;
            long firstChat=SystemClock.uptimeMillis()-chatBegin;
            System.out.println("ACTIVITY_COLD_MS=" + cold + "; FIRST_CHAT_MS=" + firstChat + "; DIAGNOSTICS=" + evaluate(diagnostics()));
            metrics.put("first_history_click_to_ready_ms",firstChat);
            metrics.put("whole_launch_home_history_chat_ms",cold);
            metrics.put("initial_diagnostics",new JSONObject(new JSONArray("["+evaluate(diagnostics())+"]").getString(0)));
            WebView retained=view;
            JSONArray switches=new JSONArray();metrics.put("switches",switches);
            for (String conv : new String[]{"qa-b", "qa-c", "qa-a"}) {
                tap("document.querySelector('#preview-menu')");
                String selector = "document.querySelector('.preview-history-button[data-conversation-id=\"" + conv + "\"]')";
                waitFor(selector + "!=null", 10);
                long switchBegin = tap(selector);
                waitFor("(()=>{const d=document.querySelector('#dialogue-frame')?.contentDocument;return document.body.classList.contains('is-ready') && !d?.body.classList.contains('homer-switching-chat') && d?.defaultView.SillyTavern?.getContext().chat.at(-1)?.mes===" + JSONObject.quote(conv + "-R1100")+" && d.querySelector('#chat .mes:last-child .mes_text')?.textContent.includes("+JSONObject.quote(conv+"-R1100")+")})()", 30);
                System.out.println("ACTIVITY_SWITCH_" + conv + "_MS=" + (SystemClock.uptimeMillis()-switchBegin));
                switches.put(new JSONObject().put("conversation",conv).put("click_to_ready_ms",SystemClock.uptimeMillis()-switchBegin));
                assertSame("Native conversation WebView retained",retained,view);
                assertEquals("No new runtime per card","1",evaluate("document.querySelector('#dialogue-frame').contentWindow.performance.getEntriesByName('homer-native-init-start').length"));
                System.out.println("ACTIVITY_SWITCH_MARKS="+evaluate("JSON.stringify(document.querySelector('#dialogue-frame').contentWindow.performance.getEntriesByType('mark').filter(e=>e.name.startsWith('homer-switch-')).slice(-8).map(e=>({name:e.name,ms:Math.round(e.startTime)})))"));
            }
            tap("document.querySelector('#preview-settings')");
            long memoryBegin=tap("document.querySelector('[data-runtime-section=memory]')");
            waitFor("(()=>{const d=document.querySelector('#dialogue-frame').contentDocument;return !!d.querySelector('dialog[open] .homer-memory-home')})()", 15);
            System.out.println("ACTIVITY_MEMORY_MS="+(SystemClock.uptimeMillis()-memoryBegin));
            metrics.put("memory_click_to_home_ms",SystemClock.uptimeMillis()-memoryBegin);
            try(OutputStream stream=test.getTargetContext().openFileOutput("activity-runtime-metrics.json",android.content.Context.MODE_PRIVATE)) {
                stream.write(metrics.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } finally { test.runOnMainSync(activity::finish); }
    }
}
