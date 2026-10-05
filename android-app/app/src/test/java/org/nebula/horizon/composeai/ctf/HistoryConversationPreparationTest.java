package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.*;
import android.content.Context;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Pure JVM shipping-method checks; no WebView browser, network, account or device. */
public final class HistoryConversationPreparationTest {
    private static final String BASE = BuildConfig.SERVER_BASE_URL.replaceAll("/$", "");
    private static final String OWNER = "synthetic-owner";
    private static final String TARGETS = "[{\"app_id\":\"card-a\",\"conversation_id\":\"chat-a\"},{\"app_id\":\"card-b\",\"conversation_id\":\"chat-b\"}]";

    private static final class FakeWebView extends WebView {
        String url;
        final List<String> scripts = new ArrayList<>();
        FakeWebView(Context context, String url) { super(context); this.url = url; }
        @Override public String getUrl() { return url; }
        @Override public void evaluateJavascript(String script, ValueCallback<String> callback) { scripts.add(script); }
        @Override public void loadUrl(String url) { fail("Preparation must never navigate"); }
        @Override public void reload() { fail("Preparation must never reload"); }
        @Override public void clearCache(boolean disk) { fail("Preparation must not clear data"); }
    }

    private static Field field(String name) throws Exception {
        Field field = HomerActivity.class.getDeclaredField(name); field.setAccessible(true); return field;
    }
    @SuppressWarnings("unchecked") private static <T> T value(HomerActivity activity, String name) throws Exception {
        return (T) field(name).get(activity);
    }
    private static void set(HomerActivity activity, String name, Object value) throws Exception { field(name).set(activity, value); }

    private static final class Fixture {
        final HomerActivity activity = new HomerActivity();
        final FakeWebView source = new FakeWebView(activity, BASE + "/app/histories.html");
        final FakeWebView destination = new FakeWebView(activity, BASE + "/app/chat.html?prewarm=1");
        final long expires = System.currentTimeMillis() + HistoryConversationPreparation.TTL_MS;
        Fixture(boolean ready) throws Exception {
            set(activity, "liveView", source); set(activity, "activePersistentPage", "histories");
            set(activity, "accountAvailable", true); set(activity, "availableAccountOwner", OWNER);
            Map<String, WebView> pages = value(activity, "persistentPages"); pages.put("histories", source); pages.put("chat", destination);
            ((Set<WebView>) value(activity, "preparedDialogueHosts")).add(destination);
            if (ready) ((Set<WebView>) value(activity, "readyConversationHosts")).add(destination);
            activity.resetLiveDocumentToken(source); activity.resetLiveDocumentToken(destination);
        }
        void request() { request(activity.historyPreparationDocumentToken(source), source.url, OWNER, TARGETS, expires); }
        void request(Object token, String document, String owner, String targets, long deadline) {
            activity.prepareHistoryConversations(source, token, document, owner, targets, deadline);
        }
        void ready() { activity.onLiveShellReady(destination, destination.url, activity.historyPreparationDocumentToken(destination)); }
        Object pending() throws Exception { return value(activity, "pendingHistoryPreparation"); }
    }

    @Test public void exactTwoIdsHaveNoContentAndKeepOriginalExpiry() throws Exception {
        HistoryConversationPreparation batch = HistoryConversationPreparation.parse(OWNER, TARGETS, 30_100, 100);
        assertNotNull(batch); assertEquals(2, new JSONArray(batch.targetsJson).length());
        assertTrue(batch.eventScript().contains("homer:prepare-history-conversations"));
        assertTrue(batch.eventScript().contains("expires_at:30100"));
        assertFalse(batch.current(OWNER, 30_100)); assertFalse(batch.current("other", 100));
        assertFalse(batch.eventScript().contains("navigate-conversation"));
    }

    @Test public void rejectsUnboundedMalformedOrExtraFieldTargets() {
        for (String input : new String[]{"null", "{}", "[]", "[1]", "[null]", "[{}]", "[" + TARGETS.substring(1, TARGETS.length()-1) + ",{\"app_id\":\"c\",\"conversation_id\":\"d\"}]",
                "[{\"app_id\":\"a\",\"conversation_id\":\"b\",\"token\":\"not-allowed\"}]", "[{\"app_id\":5,\"conversation_id\":\"b\"}]"}) {
            assertNull(input, HistoryConversationPreparation.parse(OWNER, input, 200, 100));
        }
        for (String id : new String[]{"", " ", " leading", "trailing ", "a\nb", "x".repeat(161)}) {
            assertFalse(HistoryConversationPreparation.validId(id));
        }
        assertNull(HistoryConversationPreparation.parse(OWNER, TARGETS, 100, 100));
        assertNull(HistoryConversationPreparation.parse(OWNER, TARGETS, 30_101, 100));
        assertNull(HistoryConversationPreparation.parse(" padded ", TARGETS, 200, 100));
    }

    @Test public void duplicatePairsCollapseAndScriptStringsAreQuoted() throws Exception {
        String id = "quote\"\\unicode中";
        JSONObject item = new JSONObject().put("app_id", id).put("conversation_id", "safe");
        HistoryConversationPreparation batch = HistoryConversationPreparation.parse(OWNER,
                new JSONArray().put(item).put(item).toString(), 200, 100);
        assertEquals(1, new JSONArray(batch.targetsJson).length());
        assertEquals(id, new JSONArray(batch.targetsJson).getJSONObject(0).getString("app_id"));
    }

    @Test public void routesMustBeExactTrustedHistoryAndEmptyCapabilityOnlyChat() {
        String history = BASE + "/app/histories.html";
        assertTrue(HistoryConversationPreparation.validHistorySource(BASE + "/", history, history));
        for (String other : new String[]{BASE + "/app/me.html", "https://other.invalid/app/histories.html", history + "?new=1", null}) {
            assertFalse(HistoryConversationPreparation.validHistorySource(BASE + "/", history, other));
        }
        for (String selected : new String[]{BASE + "/app/chat.html", BASE + "/app/chat.html?prewarm=1&app_id=a",
                BASE + "/app/chat.html?prewarm=1&admin_preview=1", "https://other.invalid/app/chat.html?prewarm=1"}) {
            assertFalse(HistoryConversationPreparation.emptyPreparedDestination(BASE + "/", selected));
        }
    }

    @Test public void actualShippingActivityDispatchesOnlyBoundedEventToHiddenReadyHost() throws Exception {
        Fixture f = new Fixture(true); f.request();
        assertEquals(1, f.destination.scripts.size()); assertTrue(f.source.scripts.isEmpty());
        assertTrue(f.destination.scripts.get(0).contains("expires_at:" + f.expires));
        assertNull(f.pending());
    }

    @Test public void shellReadyDrainsOnceWithoutRenewingDeadline() throws Exception {
        Fixture f = new Fixture(false); f.request();
        assertNotNull(f.pending()); assertTrue(f.destination.scripts.isEmpty());
        f.ready(); f.ready();
        assertEquals(1, f.destination.scripts.size()); assertTrue(f.destination.scripts.get(0).contains("expires_at:" + f.expires));
        assertNull(f.pending());
    }

    @Test public void sourceAndDestinationSameUrlReloadInvalidatePendingAndCapturedCallback() throws Exception {
        for (boolean source : new boolean[]{true, false}) {
            Fixture f = new Fixture(false); Object oldToken = f.activity.historyPreparationDocumentToken(f.source); f.request();
            f.activity.resetLiveDocumentToken(source ? f.source : f.destination);
            assertNull(f.pending()); f.ready(); assertTrue(f.destination.scripts.isEmpty());
            if (source) {
                f.request(oldToken, f.source.url, OWNER, TARGETS, f.expires);
                assertTrue(f.destination.scripts.isEmpty());
            }
        }
    }

    @Test public void hiddenOrUnregisteredHistoryCannotDispatch() throws Exception {
        for (int mode = 0; mode < 3; mode++) {
            Fixture f = new Fixture(true);
            if (mode == 0) set(f.activity, "liveView", f.destination);
            if (mode == 1) ((Map<String, WebView>) value(f.activity, "persistentPages")).remove("histories");
            if (mode == 2) set(f.activity, "activePersistentPage", "me");
            f.request(); assertTrue(f.destination.scripts.isEmpty()); assertNull(f.pending());
        }
    }

    @Test public void accountMismatchLogoutReloginAndExpiredCallbackCannotPrepare() throws Exception {
        Fixture f = new Fixture(true); Object oldToken = f.activity.historyPreparationDocumentToken(f.source);
        f.request(oldToken, f.source.url, "other", TARGETS, f.expires); assertTrue(f.destination.scripts.isEmpty());
        f.activity.onAccountAvailable(""); set(f.activity, "availableAccountOwner", OWNER); set(f.activity, "accountAvailable", true);
        f.request(oldToken, f.source.url, OWNER, TARGETS, f.expires); assertTrue(f.destination.scripts.isEmpty());
        f.request(f.activity.historyPreparationDocumentToken(f.source), f.source.url, OWNER, TARGETS, System.currentTimeMillis()-1);
        assertTrue(f.destination.scripts.isEmpty());
    }

    @Test public void selectedChatExplicitNavigationAndAdminPreparationTakePriority() throws Exception {
        for (int mode = 0; mode < 3; mode++) {
            Fixture f = new Fixture(true);
            if (mode == 0) f.destination.url = BASE + "/app/chat.html?app_id=a&conversation_id=b";
            if (mode == 1) ((Map<WebView, String>) value(f.activity, "pendingConversationNavigations")).put(f.destination, "selected");
            if (mode == 2) ((Map<WebView, String>) value(f.activity, "pendingAdminPreparation")).put(f.destination, "admin");
            f.request(); assertTrue(f.destination.scripts.isEmpty()); assertNull(f.pending());
        }
    }

    @Test public void leavingHistoryAndReplacingDestinationDiscardPending() throws Exception {
        Fixture f = new Fixture(false); f.request(); f.activity.setWebViewVisibility(f.source, View.GONE); assertNull(f.pending());
        f.request(); ((Map<String, WebView>) value(f.activity, "persistentPages")).remove("chat");
        Method drain = HomerActivity.class.getDeclaredMethod("drainHistoryPreparation"); drain.setAccessible(true); drain.invoke(f.activity);
        assertNull(f.pending()); assertTrue(f.destination.scripts.isEmpty());
    }

    @Test public void queuedRequestIsRevalidatedAgainstCurrentSourceAndOwner() throws Exception {
        for (boolean account : new boolean[]{true, false}) {
            Fixture f = new Fixture(false); f.request();
            if (account) set(f.activity, "availableAccountOwner", "other");
            else f.source.url = BASE + "/app/histories.html?replacement=1";
            f.ready(); assertTrue(f.destination.scripts.isEmpty()); assertNull(f.pending());
        }
    }

    @Test public void laterExplicitNavigationWinsAtShellReadyAndNeverSendsPreparation() throws Exception {
        Fixture f = new Fixture(false); f.request();
        ((Map<WebView, String>) value(f.activity, "pendingConversationNavigations")).put(f.destination,
                BASE + "/app/chat.html?app_id=selected&conversation_id=selected-chat");
        f.ready();
        assertNull(f.pending()); assertEquals(1, f.destination.scripts.size());
        assertTrue(f.destination.scripts.get(0).contains("homer:navigate-conversation"));
        assertFalse(f.destination.scripts.get(0).contains("homer:prepare-history-conversations"));
    }

    @Test public void bridgeMethodHasOnlyTheExplicitThreeStringArguments() throws Exception {
        Method bridge = LiveBridge.class.getMethod("prepareHistoryConversations", String.class, String.class, String.class);
        assertNotNull(bridge.getAnnotation(android.webkit.JavascriptInterface.class));
        assertEquals(void.class, bridge.getReturnType());
    }

    @Test public void oldSameUrlReadyAcknowledgementCannotDrainReplacementDocumentBatch() throws Exception {
        Fixture f = new Fixture(false);
        Object oldReadyToken = f.activity.historyPreparationDocumentToken(f.destination);
        f.activity.resetLiveDocumentToken(f.destination);
        f.request(); assertNotNull(f.pending());
        f.activity.onLiveShellReady(f.destination, f.destination.url, oldReadyToken);
        assertFalse(((Set<WebView>) value(f.activity, "readyConversationHosts")).contains(f.destination));
        assertTrue(f.destination.scripts.isEmpty()); assertNotNull(f.pending());
        f.activity.onLiveShellReady(f.destination, f.destination.url, null);
        assertTrue(f.destination.scripts.isEmpty());
        f.ready();
        assertEquals(1, f.destination.scripts.size()); assertNull(f.pending());
        assertTrue(f.destination.scripts.get(0).contains("expires_at:" + f.expires));
    }
}
