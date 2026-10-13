package org.nebula.horizon.composeai.ctf;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.webkit.*;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

/** Final APK static assets and genuine engine/Memory Books in Android WebView.
 * Run the isolated memory_private_runtime_server.py with adb reverse tcp:8802.
 * Only synthetic users/cards/messages, one provider stub, no paid/real calls.
 * Cloud launch is deliberately not mounted: this verifies the memory workflow,
 * not formal authorization, full host entry latency, or cloud-uninstall restore. */
public final class MemoryBindingsUiTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private final String base = "http://127.0.0.1:8802";
    private final String owner = "synthetic-native-" + UUID.randomUUID();
    private final List<String> errors = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger packaged = new AtomicInteger();
    private WebView view;

    private String evaluate(String js) throws Exception {
        CountDownLatch ready = new CountDownLatch(1); String[] value = {null};
        test.runOnMainSync(() -> view.evaluateJavascript(js, result -> { value[0] = result; ready.countDown(); }));
        assertTrue("Native evaluation callback", ready.await(10, TimeUnit.SECONDS)); return value[0];
    }
    private void waitFor(String js, int seconds) throws Exception {
        long end = SystemClock.uptimeMillis() + seconds * 1000L;
        while (SystemClock.uptimeMillis() < end) {
            if ("true".equals(evaluate(js))) return;
            Thread.sleep(30);
        }
        fail("Expected actual packaged memory state: " + js + "; details=" + evaluate("JSON.stringify({step:qaStep,error:qaFailure,secure:isSecureContext,ready:!!window.SillyTavern?.getContext,pending:document.documentElement.className,dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.textContent.slice(0,500))})") + "; errors=" + errors);
    }
    private WebResourceResponse response(String type, String text) {
        return new WebResourceResponse(type, "UTF-8", new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }
    private void startFixture(String js) throws Exception {
        evaluate("window.qaDone=false;window.qaFailure='';(async()=>{try{" + js + ";window.qaDone=true}catch(e){window.qaFailure=String(e?.stack||e)}})();true");
        // Functional gate on a heavily loaded emulator, not an instant-entry
        // benchmark. Preserve real settings/core readiness and every journey
        // assertion; report startup separately rather than lowering the gate.
        waitFor("window.qaDone===true || !!window.qaFailure", 180);
        assertEquals("No actual workflow failure; " + evaluate("JSON.stringify({ready:qaRuntimeReady,step:qaStep,ticks:qaTicks,pending:[...qaPending.values()],visibility:document.visibilityState,dialogs:[...document.querySelectorAll('dialog[open]')].map(e=>e.textContent.slice(0,500)),marks:performance.getEntriesByType('mark').map(e=>e.name)})") + "; native errors=" + errors, "\"\"", evaluate("qaFailure"));
    }

    @Test public void actualMemoryRangeSaveToggleInjectAndDocumentRestart() throws Exception {
        // Do not boot the ordinary account/browser alongside this isolated
        // engine; that would touch the formal server and race two runtimes.
        QaWebViewActivity activity = (QaWebViewActivity) test.startActivitySync(new Intent(test.getTargetContext(), QaWebViewActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        String fixture;
        try (InputStream stream = test.getContext().getAssets().open("memory-private-fixture.js")) {
            fixture = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
        final String qaScript = fixture;
        try {
            test.runOnMainSync(() -> {
                view = new WebView(activity);
                view.getSettings().setJavaScriptEnabled(true);
                view.getSettings().setDomStorageEnabled(true);
                view.setWebChromeClient(new WebChromeClient() {
                    @Override public boolean onConsoleMessage(ConsoleMessage message) {
                        if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) errors.add(message.message());
                        return true;
                    }
                });
                view.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                        if (!base.equals(request.getUrl().getScheme() + "://" + request.getUrl().getAuthority())) {
                            errors.add("Unexpected external request"); return response("text/plain", "blocked fixture request");
                        }
                        String path = request.getUrl().getPath();
                        if (path.startsWith("/module/dialogue/")) path = path.substring("/module/dialogue".length());
                        if (path.equals("/qa-memory-fixture.js")) return response("text/javascript", qaScript);
                        if (path.equals("/css/user.css")) return response("text/css", "/* Synthetic profile has no custom stylesheet. */");
                        // Synthetic service endpoints use only the isolated loopback service.
                        if (path.startsWith("/api/") || path.equals("/csrf-token") || path.equals("/version") || path.equals("/css/user.css") ||
                                path.equals("/scripts/extensions/third-party/st-yuzi-phone/manifest.json") ||
                                path.startsWith("/characters/") || path.startsWith("/thumbnail") || path.startsWith("/backgrounds/") || path.startsWith("/user/")) return null;
                        if (path.endsWith("/scripts/extensions/homer-bridge/index.js")) return response("text/javascript", "// Isolated test does not mount cloud-launch host.");
                        if (path.endsWith("/scripts/extensions/third-party/dialogue-memory-books/index.build.js")) {
                            return response("text/javascript", "import '/module/dialogue/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js';");
                        }
                        String asset = path.equals("/") ? "client/runtime/index.html" : ClientAssetRoutes.assetPath(path);
                        if (asset == null && path.startsWith("/img/")) asset = "client/runtime" + path;
                        if (asset == null) { errors.add("Unmapped fixture asset: " + path); return response("text/plain", "unmapped fixture asset"); }
                        try (InputStream stream = test.getTargetContext().getAssets().open(asset)) {
                            byte[] raw = stream.readAllBytes();
                            if (path.equals("/")) {
                                // Match the shipping embedded startup, not the standalone
                                // library's all-extension/onboarding boot. Memory is promised
                                // at real core-ready while optional services continue warming.
                                String init = "<script>window.qaDocumentToken=" + JSONObject.quote(UUID.randomUUID().toString()) + ";window.qaStep='boot';window.qaFailure='';window.qaDone=false;window.qaRuntimeReady=false;window.qaTicks=0;setInterval(()=>qaTicks++,100);window.qaPending=new Map();"
                                        // Loopback APIs live at root; immutable assets keep
                                        // shipping mounted URLs/canonical module identity.
                                        + "const qaApiUrl=v=>{const u=new URL(v,location.href);if(u.origin===location.origin&&/^\\/module\\/dialogue\\/(api\\/|csrf-token$|version$|user\\/|characters\\/|thumbnail|backgrounds\\/)/.test(u.pathname))u.pathname=u.pathname.slice('/module/dialogue'.length);return u.href};"
                                        // The test service is HTTP/1.1, which cannot
                                        // accept a browser streaming upload. Buffer only
                                        // its synthetic request body; preserve real app
                                        // Request/mount behavior and all semantic fields.
                                        + "const qaFetch=window.fetch;window.fetch=async function(r,o){const k={};const u=qaApiUrl(r instanceof Request?r.url:r);qaPending.set(k,{method:o?.method||(r instanceof Request?r.method:'GET'),path:new URL(u).pathname});try{let next=r;if(r instanceof Request&&u!==r.url){const b=['GET','HEAD'].includes(r.method)?undefined:await r.clone().arrayBuffer();next=new Request(u,{method:r.method,headers:r.headers,body:b,mode:r.mode,credentials:r.credentials,cache:r.cache,redirect:r.redirect,referrer:r.referrer,referrerPolicy:r.referrerPolicy,integrity:r.integrity,keepalive:r.keepalive,signal:r.signal})}else if(!(r instanceof Request))next=u;return await qaFetch.call(this,next,o)}finally{qaPending.delete(k)}};"
                                        + "const qaOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){return qaOpen.call(this,m,qaApiUrl(u),...a)};"
                                        + "localStorage.setItem('ai_xingyue_logged_in','1');localStorage.setItem('ai_xingyue_user',JSON.stringify({id:" + JSONObject.quote(owner) + "}));"
                                        + "addEventListener('homer:runtime-core-ready',()=>{window.qaRuntimeReady=true});addEventListener('error',e=>{window.qaFailure ||= e.message});</script>";
                                raw = new String(raw, StandardCharsets.UTF_8).replace("<head>", "<head>" + init).getBytes(StandardCharsets.UTF_8);
                            }
                            packaged.incrementAndGet();
                            String mime = path.endsWith(".mjs") || path.endsWith(".js") ? "text/javascript" :
                                    path.endsWith(".css") ? "text/css" : path.equals("/") || path.endsWith(".html") ? "text/html" :
                                    path.endsWith(".json") ? "application/json" : path.endsWith(".svg") ? "image/svg+xml" :
                                    path.endsWith(".woff2") ? "font/woff2" : path.endsWith(".webp") ? "image/webp" : "image/png";
                            return new WebResourceResponse(mime, "UTF-8", new ByteArrayInputStream(raw));
                        } catch (Exception error) {
                            errors.add("Packaged asset unavailable: " + path); return response("text/plain", "fixture asset failure");
                        }
                    }
                });
                activity.setContentView(view); view.loadUrl(base + "/module/dialogue/?homer_embed=1&homer_prewarm=1&native-memory-qa=" + UUID.randomUUID());
            });
            waitFor("!!window.SillyTavern?.getContext && !document.querySelector('#loader')", 60);
            assertEquals("Localhost origin must be a secure context for actual durable IDs", "true", evaluate("isSecureContext"));
            evaluate("(()=>{const s=document.createElement('script');s.src='/qa-memory-fixture.js';document.head.append(s)})();true");
            waitFor("!!window.HomerMemoryQaFixture", 10);
            startFixture("qaStep='setup';await HomerMemoryQaFixture.setup({isolated:true,providerStub:true,owner:" + JSONObject.quote(owner) + "});qaStep='journey';window.qaResult=await HomerMemoryQaFixture.runJourney();qaStep='complete'");
            assertTrue(packaged.get() > 50);
            assertEquals("true", evaluate("qaResult.previewNoAutosave && qaResult.editToggleRealInjection && qaResult.abaIsolation && qaResult.providerStubRequests===1 && qaResult.savedEntries===1"));
            System.out.println("NATIVE_MEMORY_JOURNEY=" + evaluate("JSON.stringify(qaResult)"));
            // A real new document reloads the packaged module graph. No records
            // are re-seeded: the same owner must retain edited local memory.
            String oldDocument = evaluate("window.qaDocumentToken");
            test.runOnMainSync(view::reload);
            // reload() returns before navigation starts. Never accept the old
            // document's already-true readiness/fixture flags or start work in
            // a document which is about to be destroyed.
            waitFor("typeof window.qaDocumentToken==='string' && window.qaDocumentToken !== " + oldDocument, 60);
            waitFor("!!window.SillyTavern?.getContext && !document.querySelector('#loader')", 60);
            evaluate("(()=>{const s=document.createElement('script');s.src='/qa-memory-fixture.js';document.head.append(s)})();true");
            waitFor("!!window.HomerMemoryQaFixture", 10);
            startFixture("qaStep='cold-setup';await HomerMemoryQaFixture.setup({isolated:true,providerStub:true,owner:" + JSONObject.quote(owner) + "});window.qaCold=await HomerMemoryQaFixture.verifyColdReopen();qaStep='cold-complete'");
            assertEquals("true", evaluate("qaCold.documentColdReopenDurable && HomerMemoryQaFixture.providerRequests().length===0"));
            assertTrue("No packaged, script, or external request errors: " + errors, errors.isEmpty());
            System.out.println("NATIVE_MEMORY_REOPEN=" + evaluate("JSON.stringify(qaCold)"));
        } finally {
            test.runOnMainSync(() -> { if (view != null) { view.loadUrl("about:blank"); view.destroy(); } activity.finish(); });
        }
    }
}
