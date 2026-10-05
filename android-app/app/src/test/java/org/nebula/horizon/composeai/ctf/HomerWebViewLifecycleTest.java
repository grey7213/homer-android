package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/** Calls the shipping Activity; proves API balancing, not renderer/prewarm/media behavior. */
public final class HomerWebViewLifecycleTest {
    private static final class FakeWebView extends WebView {
        final List<String> calls = new ArrayList<>();
        final List<String> forbiddenOperations = new ArrayList<>();
        private int visibility;
        private float alpha = 1f;
        private String documentUrl = BuildConfig.SERVER_BASE_URL.replaceAll("/$", "") + "/app/chat.html?prewarm=1";

        FakeWebView(Context context, int initialVisibility) {
            // Use the existing Gradle mock Android jar, not allocation bypass or Robolectric.
            super(context);
            visibility = initialVisibility;
        }

        @Override public void onPause() { calls.add("pause"); }
        @Override public void onResume() { calls.add("resume"); }
        @Override public void setVisibility(int value) {
            calls.add("visibility:" + value);
            visibility = value;
        }
        @Override public int getVisibility() { return visibility; }
        @Override public void setAlpha(float value) { alpha = value; }
        @Override public float getAlpha() { return alpha; }
        @Override public String getUrl() { return documentUrl; }

        // Activity.onResume's existing app-enter notification remains allowed.
        @Override public void evaluateJavascript(String script, ValueCallback<String> callback) {}
        @Override public void pauseTimers() { forbiddenOperations.add("pauseTimers"); }
        @Override public void resumeTimers() { forbiddenOperations.add("resumeTimers"); }
        @Override public void loadUrl(String url) { forbiddenOperations.add("loadUrl"); }
        @Override public void reload() { forbiddenOperations.add("reload"); }
        @Override public void stopLoading() { forbiddenOperations.add("stopLoading"); }
        @Override public void clearCache(boolean includeDiskFiles) { forbiddenOperations.add("clearCache"); }
        @Override public void clearHistory() { forbiddenOperations.add("clearHistory"); }
        @Override public void destroy() { forbiddenOperations.add("destroy"); }

        int count(String operation) {
            int result = 0;
            for (String call : calls) if (operation.equals(call)) ++result;
            return result;
        }
    }

    private static Field field(String name) throws ReflectiveOperationException {
        Field result = HomerActivity.class.getDeclaredField(name);
        result.setAccessible(true);
        return result;
    }

    private static void install(HomerActivity activity, String name, Object value)
            throws ReflectiveOperationException {
        field(name).set(activity, value);
    }

    private static boolean resumed(HomerActivity activity) throws ReflectiveOperationException {
        return field("activityViewsResumed").getBoolean(activity);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, WebView> pages(HomerActivity activity) throws ReflectiveOperationException {
        return (Map<String, WebView>) field("persistentPages").get(activity);
    }

    @SuppressWarnings("unchecked")
    private static Map<WebView, String> preparingOwners(HomerActivity activity) throws ReflectiveOperationException {
        return (Map<WebView, String>) field("preparingDialogueOwners").get(activity);
    }

    @SuppressWarnings("unchecked")
    private static Map<WebView, String> preparingEngines(HomerActivity activity) throws ReflectiveOperationException {
        return (Map<WebView, String>) field("preparingDialogueEngines").get(activity);
    }

    private static void prepare(HomerActivity activity, FakeWebView view) throws ReflectiveOperationException {
        install(activity, "accountAvailable", true);
        install(activity, "availableAccountOwner", "unit-test-owner");
        pages(activity).put("chat", view);
        preparingOwners(activity).put(view, "unit-test-owner");
        preparingEngines(activity).put(view, "unit-engine:1");
    }

    private static void safeOnly(FakeWebView... views) {
        for (FakeWebView view : views) assertTrue(view.forbiddenOperations.toString(), view.forbiddenOperations.isEmpty());
    }

    @Test public void initialBackgroundVisibleSelectionPausesInsteadOfResuming()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView view = new FakeWebView(activity, View.GONE);
        assertFalse(resumed(activity));

        activity.setWebViewVisibility(view, View.VISIBLE);

        assertEquals(Arrays.asList("visibility:0", "pause"), view.calls);
        assertEquals(View.VISIBLE, view.getVisibility());
        assertEquals(0, view.count("resume"));
        safeOnly(view);
    }

    @Test public void foregroundResumePrecedesRevealingAnInactiveView()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        activity.onResume();
        assertTrue(resumed(activity));
        FakeWebView view = new FakeWebView(activity, View.INVISIBLE);

        activity.setWebViewVisibility(view, View.VISIBLE);

        assertEquals(Arrays.asList("resume", "visibility:0"), view.calls);
        assertEquals(View.VISIBLE, view.getVisibility());
        safeOnly(view);
    }

    @Test public void foregroundGoneAndInvisibleViewsHideBeforeTheirPerViewPause()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        activity.onResume();
        for (int hidden : new int[]{View.GONE, View.INVISIBLE}) {
            FakeWebView view = new FakeWebView(activity, View.VISIBLE);

            activity.setWebViewVisibility(view, hidden);

            assertEquals(Arrays.asList("visibility:" + hidden, "pause"), view.calls);
            assertEquals(hidden, view.getVisibility());
            assertEquals(0, view.count("resume"));
            safeOnly(view);
        }
    }

    @Test public void activityResumeIncludesIndependentLiveAndSnapshotAndDeduplicatesTheMap()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView live = new FakeWebView(activity, View.VISIBLE);
        FakeWebView snapshot = new FakeWebView(activity, View.VISIBLE);
        FakeWebView retained = new FakeWebView(activity, View.VISIBLE);
        FakeWebView hidden = new FakeWebView(activity, View.GONE);
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        install(activity, "liveView", live);
        install(activity, "snapshotView", snapshot);
        pages(activity).put("histories", retained);
        pages(activity).put("same-retained-owner", retained);
        pages(activity).put("me", hidden);
        pages(activity).put("chat", prewarm);

        activity.onResume();

        assertTrue(resumed(activity));
        for (FakeWebView visible : new FakeWebView[]{live, snapshot, retained}) {
            assertEquals(1, visible.count("resume"));
            assertEquals(0, visible.count("pause"));
            assertEquals(View.VISIBLE, visible.getVisibility());
        }
        for (FakeWebView inactive : new FakeWebView[]{hidden, prewarm}) {
            assertEquals(1, inactive.count("pause"));
            assertEquals(0, inactive.count("resume"));
        }
        assertEquals(View.GONE, hidden.getVisibility());
        assertEquals(View.INVISIBLE, prewarm.getVisibility());
        safeOnly(live, snapshot, retained, hidden, prewarm);
    }

    @Test public void activityPausePausesEveryUniqueExistingViewIncludingAnAlreadyHiddenOwner()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView live = new FakeWebView(activity, View.VISIBLE);
        FakeWebView snapshot = new FakeWebView(activity, View.VISIBLE);
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        install(activity, "liveView", live);
        install(activity, "snapshotView", snapshot);
        pages(activity).put("live-alias", live);
        pages(activity).put("another-live-alias", live);
        pages(activity).put("snapshot-alias", snapshot);
        pages(activity).put("chat", prewarm);
        activity.onResume();
        for (FakeWebView view : new FakeWebView[]{live, snapshot, prewarm}) view.calls.clear();

        activity.onPause();

        assertFalse(resumed(activity));
        for (FakeWebView view : new FakeWebView[]{live, snapshot, prewarm}) {
            assertEquals(1, view.count("pause"));
            assertEquals(0, view.count("resume"));
        }
        safeOnly(live, snapshot, prewarm);
    }

    @Test public void lateViewsCreatedAfterActivityPauseStayPausedEvenWhenTheyBecomeVisible()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        activity.onResume();
        activity.onPause();
        assertFalse(resumed(activity));
        for (int desired : new int[]{View.VISIBLE, View.INVISIBLE}) {
            FakeWebView late = new FakeWebView(activity, View.VISIBLE);

            activity.setWebViewVisibility(late, desired);

            assertEquals(Arrays.asList("visibility:" + desired, "pause"), late.calls);
            assertEquals(0, late.count("resume"));
            assertEquals(desired, late.getVisibility());
            safeOnly(late);
        }
    }

    @Test public void foregroundReturnResumesOnlyTheLatestVisibleRetainedOwner()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView previous = new FakeWebView(activity, View.VISIBLE);
        FakeWebView next = new FakeWebView(activity, View.INVISIBLE);
        FakeWebView snapshot = new FakeWebView(activity, View.GONE);
        install(activity, "liveView", previous);
        install(activity, "snapshotView", snapshot);
        pages(activity).put("histories", previous);
        pages(activity).put("chat", next);
        activity.onResume();
        activity.onPause();
        activity.setWebViewVisibility(previous, View.GONE);
        activity.setWebViewVisibility(next, View.VISIBLE);
        install(activity, "liveView", next);
        for (FakeWebView view : new FakeWebView[]{previous, next, snapshot}) view.calls.clear();

        activity.onResume();

        assertTrue(resumed(activity));
        assertEquals(1, next.count("resume"));
        assertEquals(0, next.count("pause"));
        for (FakeWebView inactive : new FakeWebView[]{previous, snapshot}) {
            assertEquals(0, inactive.count("resume"));
            assertEquals(1, inactive.count("pause"));
        }
        assertSame(next, field("liveView").get(activity));
        assertSame(previous, pages(activity).get("histories"));
        assertSame(next, pages(activity).get("chat"));
        safeOnly(previous, next, snapshot);
    }

    @Test public void coveredAlphaZeroAuthoritativeLiveViewRemainsActiveWhenVisible()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView live = new FakeWebView(activity, View.VISIBLE);
        FakeWebView snapshot = new FakeWebView(activity, View.VISIBLE);
        live.setAlpha(0f);
        install(activity, "liveView", live);
        install(activity, "snapshotView", snapshot);
        install(activity, "liveRevealed", false);

        activity.onResume();

        assertEquals(1, live.count("resume"));
        assertEquals(0, live.count("pause"));
        assertEquals(1, snapshot.count("resume"));
        assertEquals(0f, live.getAlpha(), 0f);
        assertEquals(View.VISIBLE, live.getVisibility());
        assertFalse(field("liveRevealed").getBoolean(activity));
        live.calls.clear();
        activity.setWebViewVisibility(live, View.VISIBLE);
        assertEquals(Arrays.asList("resume", "visibility:0"), live.calls);
        assertEquals(0f, live.getAlpha(), 0f);
        safeOnly(live, snapshot);
    }

    @Test public void foregroundPreparingHostResumesWithoutBeingRevealed() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);

        activity.onResume();

        assertEquals(Arrays.asList("resume", "visibility:4"), prewarm.calls);
        assertEquals(View.INVISIBLE, prewarm.getVisibility());
        assertEquals(0, prewarm.count("pause"));
        safeOnly(prewarm);
    }

    @Test public void actualCoreAckPausesOnlyHiddenPreparedOwner() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        prewarm.calls.clear();

        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:1");

        assertEquals(Arrays.asList("visibility:4", "pause"), prewarm.calls);
        assertTrue(preparingOwners(activity).isEmpty());
        assertTrue(preparingEngines(activity).isEmpty());
        assertEquals(View.INVISIBLE, prewarm.getVisibility());
        safeOnly(prewarm);
    }

    @Test public void shellAckCannotStopRealCorePreparation() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        prewarm.calls.clear();

        activity.resetLiveDocumentToken(prewarm);
        activity.onLiveShellReady(prewarm, prewarm.getUrl(), activity.historyPreparationDocumentToken(prewarm));

        assertTrue(prewarm.calls.isEmpty());
        assertEquals("unit-test-owner", preparingOwners(activity).get(prewarm));
        activity.setWebViewVisibility(prewarm, View.INVISIBLE);
        assertEquals(Arrays.asList("resume", "visibility:4"), prewarm.calls);
        safeOnly(prewarm);
    }

    @Test public void backgroundAlwaysPausesPreparationAndForegroundRestartsOnlyUntilCoreAck()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        prewarm.calls.clear();
        activity.onPause();
        assertEquals(Arrays.asList("pause"), prewarm.calls);
        prewarm.calls.clear();
        activity.onResume();
        assertEquals(Arrays.asList("resume", "visibility:4"), prewarm.calls);
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:1");
        activity.onPause();
        prewarm.calls.clear();
        activity.onResume();
        assertEquals(Arrays.asList("visibility:4", "pause"), prewarm.calls);
        safeOnly(prewarm);
    }

    @Test public void staleOwnerViewUrlAndEngineAcksCannotEndOrResumePreparation()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        FakeWebView oldView = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        prewarm.calls.clear();
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "other-owner", "unit-engine:1");
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:old");
        activity.onDialoguePreparationFinished(prewarm, "https://external.invalid/app/chat.html?prewarm=1", "unit-test-owner", "unit-engine:1");
        activity.onDialoguePreparationStarted(oldView, oldView.getUrl(), "unit-test-owner", "unit-engine:1");
        activity.onDialoguePreparationFinished(oldView, oldView.getUrl(), "unit-test-owner", "unit-engine:1");
        assertTrue(prewarm.calls.isEmpty());
        assertTrue(oldView.calls.isEmpty());
        assertEquals("unit-engine:1", preparingEngines(activity).get(prewarm));
        safeOnly(prewarm, oldView);
    }

    @Test public void freshEngineAnnouncementRejectsTheOldSameDocumentAck() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        activity.onDialoguePreparationStarted(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:2");
        prewarm.calls.clear();
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:1");
        assertTrue(prewarm.calls.isEmpty());
        assertEquals("unit-engine:2", preparingEngines(activity).get(prewarm));
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:2");
        assertEquals(Arrays.asList("visibility:4", "pause"), prewarm.calls);
        safeOnly(prewarm);
    }

    @Test public void signOutImmediatelyPausesPreparationAndRejectsLateCallbacks() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.onResume();
        prewarm.calls.clear();
        activity.onAccountAvailable("");
        assertEquals(Arrays.asList("visibility:4", "pause"), prewarm.calls);
        assertTrue(preparingOwners(activity).isEmpty());
        assertTrue(preparingEngines(activity).isEmpty());
        prewarm.calls.clear();
        activity.onDialoguePreparationStarted(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:2");
        activity.onDialoguePreparationFinished(prewarm, prewarm.getUrl(), "unit-test-owner", "unit-engine:1");
        assertTrue(prewarm.calls.isEmpty());
        safeOnly(prewarm);
    }

    @Test public void completedVisibleChatIsNeverPausedOrReloadedByCoreAck() throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView chat = new FakeWebView(activity, View.VISIBLE);
        prepare(activity, chat);
        activity.onResume();
        chat.calls.clear();
        activity.onDialoguePreparationFinished(chat, chat.getUrl(), "unit-test-owner", "unit-engine:1");
        assertEquals(Arrays.asList("resume", "visibility:0"), chat.calls);
        assertEquals(0, chat.count("pause"));
        assertTrue(preparingOwners(activity).isEmpty());
        safeOnly(chat);
    }

    @Test public void persistedIdentityHintRestoresOnlyPreparationIdentityWithoutLoadingOrGrantingAccess()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        activity.restoreDialoguePreparationHint("  cached-profile-owner  ");
        assertTrue(field("accountAvailable").getBoolean(activity));
        assertEquals("cached-profile-owner", field("availableAccountOwner").get(activity));
        assertTrue(pages(activity).isEmpty());
        assertTrue(preparingOwners(activity).isEmpty());
        assertTrue(preparingEngines(activity).isEmpty());
        assertEquals(null, field("liveView").get(activity));
        assertEquals(null, field("cacheDatabase").get(activity));
        activity.restoreDialoguePreparationHint(null);
        assertFalse(field("accountAvailable").getBoolean(activity));
        assertEquals("", field("availableAccountOwner").get(activity));
    }

    @Test public void expiredCookieAccountClearRevokesThePersistedHintWithoutCacheOrChatMutation()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView prewarm = new FakeWebView(activity, View.INVISIBLE);
        prepare(activity, prewarm);
        activity.restoreDialoguePreparationHint("unit-test-owner");
        activity.onResume();
        prewarm.calls.clear();
        activity.onAccountAvailable(null);
        assertFalse(field("accountAvailable").getBoolean(activity));
        assertEquals(Arrays.asList("visibility:4", "pause"), prewarm.calls);
        assertTrue(preparingOwners(activity).isEmpty());
        assertTrue(preparingEngines(activity).isEmpty());
        safeOnly(prewarm);
    }

    @Test public void profileOwnerChangeDisposesOldPreparationAndRetainsOnlyVisibleNonChatRouting()
            throws ReflectiveOperationException {
        HomerActivity activity = new HomerActivity();
        FakeWebView oldPrewarm = new FakeWebView(activity, View.INVISIBLE);
        FakeWebView me = new FakeWebView(activity, View.VISIBLE);
        me.documentUrl = BuildConfig.SERVER_BASE_URL.replaceAll("/$", "") + "/app/me.html";
        prepare(activity, oldPrewarm);
        install(activity, "root", new FrameLayout(activity));
        install(activity, "liveView", me);
        pages(activity).put("me", me);
        activity.onResume();
        activity.discardInactiveAccountPages();
        assertEquals(Arrays.asList("stopLoading", "destroy"), oldPrewarm.forbiddenOperations);
        assertTrue(preparingOwners(activity).isEmpty());
        assertTrue(preparingEngines(activity).isEmpty());
        assertEquals(1, pages(activity).size());
        assertSame(me, pages(activity).get("me"));
        assertEquals("me", field("activePersistentPage").get(activity));
        activity.onAccountAvailable("new-profile-owner");
        oldPrewarm.calls.clear();
        activity.onDialoguePreparationStarted(oldPrewarm, oldPrewarm.getUrl(), "unit-test-owner", "unit-engine:old");
        activity.onDialoguePreparationFinished(oldPrewarm, oldPrewarm.getUrl(), "unit-test-owner", "unit-engine:1");
        assertTrue(oldPrewarm.calls.isEmpty());
        assertTrue(oldPrewarm.forbiddenOperations.stream().noneMatch(value -> value.startsWith("clear")));
        safeOnly(me);
    }
}
