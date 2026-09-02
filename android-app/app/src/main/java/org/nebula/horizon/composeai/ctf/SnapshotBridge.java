package org.nebula.horizon.composeai.ctf;

import android.webkit.JavascriptInterface;

public final class SnapshotBridge {
    private final HomerActivity activity;

    SnapshotBridge(HomerActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String getSnapshot() {
        return activity.readStartupSnapshot();
    }

    @JavascriptInterface
    public String getServerBaseUrl() {
        return BuildConfig.SERVER_BASE_URL;
    }

    @JavascriptInterface
    public void retryConnection() {
        activity.runOnUiThread(activity::reloadLivePage);
    }

    @JavascriptInterface
    public void submitDraft(String content) {
        String safe = content == null ? "" : content.trim();
        if (safe.isEmpty() || safe.length() > 10_000) return;
        activity.runOnUiThread(() -> activity.queueDraft(safe));
    }
}
