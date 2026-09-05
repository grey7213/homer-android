package org.nebula.horizon.composeai.ctf;

import android.webkit.JavascriptInterface;

/** Minimal, non-sensitive controls available to the trusted live WebView. */
public final class LiveBridge {
    private final HomerActivity activity;
    private final HomerCacheDatabase database;

    LiveBridge(HomerActivity activity, HomerCacheDatabase database) {
        this.activity = activity;
        this.database = database;
    }

    @JavascriptInterface
    public String getAppVisitId() {
        return activity.getAppVisitId();
    }

    @JavascriptInterface
    public void setAccountScope(String owner) {
        if (database.setAccountScope(owner)) {
            activity.runOnUiThread(activity::discardInactiveAccountPages);
        }
    }

    @JavascriptInterface
    public void requestOrientation(String value) {
        final String safe = "landscape".equals(value) ? "landscape" : "default";
        activity.runOnUiThread(() -> activity.requestOrientation(safe));
    }

    @JavascriptInterface
    public void notifyShellReady(String documentUrl) {
        final String safeUrl = documentUrl == null ? "" : documentUrl.trim();
        activity.runOnUiThread(() -> activity.onLiveShellReady(safeUrl));
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
