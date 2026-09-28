package org.nebula.horizon.composeai.ctf;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/** Minimal, non-sensitive controls available to the trusted live WebView. */
public final class LiveBridge {
    private final HomerActivity activity;
    private final HomerCacheDatabase database;
    private final WebView owner;

    LiveBridge(HomerActivity activity, HomerCacheDatabase database, WebView owner) {
        this.activity = activity;
        this.database = database;
        this.owner = owner;
    }

    @JavascriptInterface
    public String getAppVisitId() {
        return activity.getAppVisitId();
    }

    @JavascriptInterface
    public String getAppVersion() { return BuildConfig.VERSION_NAME; }

    @JavascriptInterface
    public boolean isDebugBuild() { return BuildConfig.DEBUG; }

    /** Capability negotiation: old clients must keep their existing web fallback. */
    @JavascriptInterface
    public boolean supportsSharedConversationHost() { return true; }

    @JavascriptInterface
    public void prepareAdminConversation(String appId) {
        if (appId == null || appId.isBlank() || appId.length() > 160) return;
        activity.runOnUiThread(() -> activity.prepareAdminConversation(appId));
    }

    @JavascriptInterface
    public void setAppTheme(String mode) {
        if (!"light".equals(mode) && !"dark".equals(mode)) return;
        activity.runOnUiThread(() -> activity.setAppTheme("dark".equals(mode)));
    }

    @JavascriptInterface
    public void setSettingsSurface(String mode) {
        final String safe = "light".equals(mode) || "dark".equals(mode) ? mode : "";
        activity.runOnUiThread(() -> activity.setSettingsSurface(safe));
    }

    @JavascriptInterface
    public void checkForAppUpdate() { activity.runOnUiThread(activity::checkForAppUpdate); }

    @JavascriptInterface
    public void setAccountScope(String owner) {
        if (database.setAccountScope(owner)) {
            activity.runOnUiThread(activity::discardInactiveAccountPages);
        }
        activity.runOnUiThread(() -> activity.onAccountAvailable(owner != null && !owner.trim().isEmpty()));
    }

    @JavascriptInterface
    public void requestOrientation(String value) {
        final String safe = "landscape".equals(value) ? "landscape" : "default";
        activity.runOnUiThread(() -> activity.requestOrientation(safe));
    }

    @JavascriptInterface
    public void notifyShellReady(String documentUrl) {
        final String safeUrl = documentUrl == null ? "" : documentUrl.trim();
        activity.runOnUiThread(() -> activity.onLiveShellReady(owner, safeUrl));
    }

    @JavascriptInterface
    public String readConversationSnapshot(String conversationId) {
        return database.readConversationSnapshot(conversationId);
    }

    @JavascriptInterface
    public String readConversationHistory() {
        return database.readConversationHistory();
    }

    @JavascriptInterface
    public String readLegacySnapshot() {
        return database.readSnapshot();
    }

    @JavascriptInterface
    public boolean saveConversationSnapshot(String payload) {
        return database.saveConversationSnapshot(payload);
    }
}
