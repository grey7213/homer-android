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

    @JavascriptInterface
    public String getArchiveMediaStatus() { return activity.archiveMediaStatus(); }

    @JavascriptInterface
    public String getArchiveWorkshopCatalog() { return activity.archiveWorkshopCatalog(); }

    @JavascriptInterface
    public void openArchiveWorkshop() { activity.runOnUiThread(() -> activity.openArchiveWorkshop(owner)); }

    @JavascriptInterface
    public void openArchiveWorkshopResource(String reference) { activity.runOnUiThread(() -> activity.openArchiveWorkshopResource(owner,reference)); }

    @JavascriptInterface
    public void prepareArchiveMedia(String roleId) { activity.runOnUiThread(() -> activity.prepareArchiveMedia(owner, roleId)); }

    @JavascriptInterface
    public void importArchiveMedia() { activity.runOnUiThread(() -> activity.importArchiveMedia(owner)); }

    @JavascriptInterface
    public void downloadUserBackup() {
        activity.runOnUiThread(() -> activity.downloadUserBackup(owner));
    }

    /** Pure UTF-8 digest only; an empty result requests the existing web fallback. */
    @JavascriptInterface
    public String sha256Utf8(String value) { return HomerUtf8Sha256.digest(value); }

    /** Capability negotiation: old clients must keep their existing web fallback. */
    @JavascriptInterface
    public boolean supportsSharedConversationHost() { return true; }

    @JavascriptInterface
    public void prepareAdminConversation(String appId) {
        if (appId == null || appId.isBlank() || appId.length() > 160) return;
        activity.runOnUiThread(() -> activity.prepareAdminConversation(appId));
    }

    /** Only the owning, current history document may request bounded read-only preparation. */
    @JavascriptInterface
    public void prepareHistoryConversations(String documentUrl, String accountOwner, String targetsJson) {
        final Object documentToken = activity.historyPreparationDocumentToken(owner);
        final long expiresAt = System.currentTimeMillis() + HistoryConversationPreparation.TTL_MS;
        activity.runOnUiThread(() -> activity.prepareHistoryConversations(owner, documentToken,
                documentUrl, accountOwner, targetsJson, expiresAt));
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
        activity.runOnUiThread(() -> activity.onAccountAvailable(owner));
    }

    @JavascriptInterface
    public void requestOrientation(String value) {
        final String safe = "landscape".equals(value) ? "landscape" : "default";
        final Object documentToken = activity.historyPreparationDocumentToken(owner);
        activity.runOnUiThread(() -> activity.requestOrientation(owner, documentToken, safe));
    }

    @JavascriptInterface
    public void refreshArchiveOrientation(String documentUrl) {
        final Object documentToken = activity.historyPreparationDocumentToken(owner);
        activity.runOnUiThread(() -> activity.refreshArchiveOrientation(owner, documentToken, documentUrl));
    }

    @JavascriptInterface
    public void notifyShellReady(String documentUrl) {
        final String safeUrl = documentUrl == null ? "" : documentUrl.trim();
        final Object documentToken = activity.historyPreparationDocumentToken(owner);
        activity.runOnUiThread(() -> activity.onLiveShellReady(owner, safeUrl, documentToken));
    }

    /** Preparation completion is lifecycle correlation, not account authorization. */
    @JavascriptInterface
    public void notifyDialoguePreparationStarted(String documentUrl, String accountOwner, String engineToken) {
        activity.runOnUiThread(() -> activity.onDialoguePreparationStarted(owner, documentUrl, accountOwner, engineToken));
    }

    @JavascriptInterface
    public void notifyDialogueCoreReady(String documentUrl, String accountOwner, String engineToken) {
        activity.runOnUiThread(() -> activity.onDialoguePreparationFinished(owner, documentUrl, accountOwner, engineToken));
    }

    @JavascriptInterface
    public void notifyDialoguePreparationStopped(String documentUrl, String accountOwner, String engineToken) {
        activity.runOnUiThread(() -> activity.onDialoguePreparationFinished(owner, documentUrl, accountOwner, engineToken));
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
