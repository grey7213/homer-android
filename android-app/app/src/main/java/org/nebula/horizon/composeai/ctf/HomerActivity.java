package org.nebula.horizon.composeai.ctf;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class HomerActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 701;
    private static final int WEB_PERMISSION_REQUEST = 702;
    private static final long READY_POLL_MS = 300L;
    private static final long READY_TIMEOUT_MS = 150_000L;

    private static final String READ_LIVE_STATE_SCRIPT = """
            (() => {
              try {
                const frame = document.querySelector('#dialogue-frame');
                let runtimeDocument = null;
                try { runtimeDocument = frame && frame.contentDocument; } catch (_) {}
                let nodes = runtimeDocument
                  ? [...runtimeDocument.querySelectorAll('#chat .mes')]
                  : [...document.querySelectorAll('#preview-messages .preview-message')];
                const messages = [];
                for (const node of nodes.slice(-80)) {
                  const textNode = node.querySelector?.('.mes_text') || node;
                  const text = String(textNode.innerText || textNode.textContent || '').trim().slice(0, 6000);
                  if (!text) continue;
                  const isUser = node.getAttribute?.('is_user') === 'true'
                    || node.classList?.contains('is-user');
                  messages.push({ role: isUser ? 'user' : 'assistant', text });
                }
                const titleNode = document.querySelector('#preview-title');
                const title = String(titleNode?.textContent || document.title || '角色对话')
                  .replace(/\s*[·|-]\s*惑梦\s*$/, '').trim().slice(0, 120);
                const dialogue = location.pathname === '/app/chat.html';
                const usableDocument = Boolean(document.body && document.body.childElementCount);
                const shellReady = dialogue
                  ? document.documentElement?.dataset?.homerShellReady === 'true'
                  : document.readyState === 'complete' && usableDocument;
                return JSON.stringify({
                  ready: dialogue
                    ? document.body.classList.contains('is-ready')
                    : document.readyState === 'complete' && usableDocument,
                  shellReady,
                  dialogue,
                  title: title || '角色对话',
                  url: location.href,
                  messages,
                });
              } catch (_) {
                return JSON.stringify({ ready: false, title: '角色对话', messages: [] });
              }
            })()
            """;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView snapshotView;
    private WebView liveView;
    private final Map<String, WebView> persistentPages = new HashMap<>();
    private final ArrayDeque<String> persistentPageHistory = new ArrayDeque<>();
    private String activePersistentPage = "";
    private HomerCacheDatabase cacheDatabase;
    private PatchManager patchManager;
    private ClientAssetStore clientAssetStore;
    private ValueCallback<Uri[]> fileChooserCallback;
    private PermissionRequest pendingPermissionRequest;
    private String[] pendingPermissionResources = new String[0];
    private String pendingDraft = "";
    private long liveStartedAt;
    private boolean liveRevealed;
    private boolean liveReadyHandled;
    private boolean updateChecked;
    private boolean immersiveLandscape;
    private boolean snapshotLoaded;
    private String snapshotConversationId = "";
    private int nativeSafeTop;
    private int nativeSafeRight;
    private int nativeSafeBottom;
    private int nativeSafeLeft;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF1D1D1E);
        getWindow().setNavigationBarColor(0xFF1D1D1E);

        cacheDatabase = new HomerCacheDatabase(this);
        patchManager = new PatchManager(this);
        patchManager.recoverInterruptedUpdate();
        clientAssetStore = new ClientAssetStore(this, patchManager);

        root = new FrameLayout(this);
        liveView = new WebView(this);
        snapshotView = new WebView(this);
        root.addView(liveView, matchParent());
        // The local snapshot is the first interactive frame and therefore stays
        // above the live WebView only until the bundled conversation shell says
        // its own controls are wired. Runtime/model readiness is a later phase.
        root.addView(snapshotView, matchParent());
        setContentView(root);

        // Keep the WebView content inside the system bars.  This is the same
        // visual contract Tavo uses: the page itself starts below the status
        // bar and ends above the navigation bar, so fixed HTML controls cannot
        // be painted underneath either bar.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            WindowInsets current = insets;
            int top = 0;
            int right = 0;
            int bottom = 0;
            int left = 0;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = current.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                right = bars.right;
                bottom = bars.bottom;
                left = bars.left;
            } else {
                top = current.getSystemWindowInsetTop();
                right = current.getSystemWindowInsetRight();
                bottom = current.getSystemWindowInsetBottom();
                left = current.getSystemWindowInsetLeft();
            }
            nativeSafeTop = top;
            nativeSafeRight = right;
            nativeSafeBottom = bottom;
            nativeSafeLeft = left;
            view.setPadding(left, top, right, bottom);
            applyNativeInsetsToWebViews();
            return insets;
        });
        root.requestApplyInsets();

        configureSnapshotView();
        configureLiveView(liveView);
        String startupTarget = safeStartupUrl(cacheDatabase.readLastUrl());
        prepareSnapshotForTarget(startupTarget);
        // Give the tiny local document the first main-loop turn before the
        // heavier live WebView begins parsing the bundled runtime.
        handler.post(this::startLivePage);
    }

    private void applyNativeInsetsToWebViews() {
        // The native root is padded by the measured insets above.  Keep the
        // CSS fallback variables at zero to avoid applying the same inset twice
        // inside the WebView while still allowing browser-hosted pages to use
        // env(safe-area-inset-*).
        final String script = "(() => { const r = document.documentElement; "
                + "r.style.setProperty('--homer-native-safe-top','0px');"
                + "r.style.setProperty('--homer-native-safe-right','0px');"
                + "r.style.setProperty('--homer-native-safe-bottom','0px');"
                + "r.style.setProperty('--homer-native-safe-left','0px'); })()";
        Set<WebView> views = new HashSet<>(persistentPages.values());
        if (liveView != null) views.add(liveView);
        for (WebView view : views) view.evaluateJavascript(script, null);
        if (snapshotView != null) snapshotView.evaluateJavascript(script, null);
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureSnapshotView() {
        WebSettings settings = snapshotView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(true);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        snapshotView.setBackgroundColor(0xFF1D1D1E);
        snapshotView.addJavascriptInterface(
                new SnapshotBridge(this),
                "HomerNative"
        );
        snapshotView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !"file".equalsIgnoreCase(scheme);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                applyNativeInsetsToWebViews();
                patchManager.markActiveHealthy();
                updateSnapshotConnectionState(isOnline(), false);
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureLiveView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString()
                + " HomerAndroid/" + BuildConfig.VERSION_NAME);
        view.setBackgroundColor(0xFF1D1D1E);
        view.setAlpha(1f);
        view.setVisibility(View.VISIBLE);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new LiveClient());
        view.setWebChromeClient(new LiveChromeClient());
        view.addJavascriptInterface(new LiveBridge(this, cacheDatabase), "HomerNative");
        view.setDownloadListener(openExternalDownload());
    }

    void requestOrientation(String value) {
        immersiveLandscape = "landscape".equals(value);
        int requested = immersiveLandscape
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        if (getRequestedOrientation() != requested) setRequestedOrientation(requested);
        applySystemBars();
    }

    @SuppressWarnings("deprecation")
    private void applySystemBars() {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller == null) return;
            if (immersiveLandscape) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            } else {
                controller.show(WindowInsets.Type.systemBars());
            }
            return;
        }
        decor.setSystemUiVisibility(immersiveLandscape
                ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_VISIBLE);
    }


    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applySystemBars();
    }

    private DownloadListener openExternalDownload() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null || !url.startsWith("https://")) return;
            openExternal(Uri.parse(url));
        };
    }

    private void startLivePage() {
        liveStartedAt = System.currentTimeMillis();
        liveReadyHandled = false;
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        String stored = cacheDatabase.readLastUrl();
        String target = safeStartupUrl(stored);
        registerInitialPersistentPage(target);
        // Follow the lightweight chatroom pattern used by Fengyue: when the
        // last page was a conversation, expose the local snapshot immediately
        // while the full live runtime warms in the background. The live page
        // remains authoritative and hides this layer as soon as it is ready.
        boolean conversationTarget = StartupPresentation.isConversationUrl(target);
        prepareSnapshotForTarget(target);
        liveRevealed = !conversationTarget;
        snapshotView.setVisibility(conversationTarget ? View.VISIBLE : View.GONE);
        snapshotView.setAlpha(1f);
        liveView.loadUrl(target);
        updateSnapshotConnectionState(isOnline(), true);
    }

    static String persistentPageKey(String value) {
        try {
            String path = URI.create(value).getPath();
            if (path == null) return "";
            if ("/app/chat.html".equals(path) || "/module/dialogue/".equals(path)) return "chat";
            if ("/app/explore.html".equals(path)) return "explore";
            if ("/app/favorites.html".equals(path)) return "favorites";
            if ("/app/workshop.html".equals(path)) return "workshop";
            if ("/app/me.html".equals(path)) return "me";
            if ("/dashboard.html".equals(path)) return "account";
            if ("/admin.html".equals(path)) return "admin";
        } catch (RuntimeException ignored) {
            // Invalid URLs are rejected by SafeUrls before navigation.
        }
        return "";
    }

    private void registerInitialPersistentPage(String target) {
        String key = persistentPageKey(target);
        if (key.isEmpty()) return;
        persistentPages.put(key, liveView);
        activePersistentPage = key;
    }

    private boolean switchPersistentPage(String target) {
        String key = persistentPageKey(target);
        if (key.isEmpty()) return false;
        if (activePersistentPage.isEmpty() && persistentPages.isEmpty()) {
            persistentPages.put(key, liveView);
            activePersistentPage = key;
            return false;
        }
        if (key.equals(activePersistentPage)) {
            String current = liveView.getUrl();
            return current != null && current.equals(target);
        }

        WebView previous = liveView;
        String previousKey = activePersistentPage;
        WebView targetView = persistentPages.get(key);
        boolean newlyCreated = targetView == null;
        if (newlyCreated) {
            targetView = new WebView(this);
            configureLiveView(targetView);
            persistentPages.put(key, targetView);
            root.addView(targetView, 0, matchParent());
        }

        if (previous != null) previous.setVisibility(View.GONE);
        if (!previousKey.isEmpty()) {
            persistentPageHistory.remove(previousKey);
            persistentPageHistory.addLast(previousKey);
        }
        liveView = targetView;
        activePersistentPage = key;
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        snapshotView.setVisibility(View.GONE);
        liveRevealed = true;
        liveReadyHandled = !newlyCreated;
        if (newlyCreated) liveView.loadUrl(target);
        else cacheDatabase.saveLastUrl(liveView.getUrl() == null ? target : liveView.getUrl());
        applyNativeInsetsToWebViews();
        return true;
    }

    private boolean restorePreviousPersistentPage() {
        while (!persistentPageHistory.isEmpty()) {
            String key = persistentPageHistory.removeLast();
            WebView target = persistentPages.get(key);
            if (target == null || key.equals(activePersistentPage)) continue;
            if (liveView != null) liveView.setVisibility(View.GONE);
            liveView = target;
            activePersistentPage = key;
            liveView.setAlpha(1f);
            liveView.setVisibility(View.VISIBLE);
            snapshotView.setVisibility(View.GONE);
            liveRevealed = true;
            liveReadyHandled = true;
            String url = liveView.getUrl();
            if (url != null) cacheDatabase.saveLastUrl(url);
            applyNativeInsetsToWebViews();
            return true;
        }
        return false;
    }

    void reloadLivePage() {
        liveReadyHandled = false;
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        liveStartedAt = System.currentTimeMillis();
        if (liveView.getUrl() == null) {
            startLivePage();
            return;
        }
        boolean conversationTarget = StartupPresentation.isConversationUrl(liveView.getUrl());
        prepareSnapshotForTarget(liveView.getUrl());
        liveRevealed = !conversationTarget;
        snapshotView.setVisibility(conversationTarget ? View.VISIBLE : View.GONE);
        snapshotView.setAlpha(1f);
        liveView.reload();
        updateSnapshotConnectionState(isOnline(), true);
    }

    private void prepareSnapshotForTarget(String target) {
        String conversationId = StartupPresentation.conversationId(target);
        if (snapshotLoaded && conversationId.equals(snapshotConversationId)) return;
        snapshotConversationId = conversationId;
        snapshotLoaded = true;
        snapshotView.loadUrl(patchManager.offlineEntryUrl());
    }

    String readStartupSnapshot() {
        String conversationId = snapshotConversationId;
        if (conversationId == null || conversationId.isEmpty()) return "{}";
        String cached = cacheDatabase.readConversationSnapshot(conversationId);
        if (!"{}".equals(cached)) return cached;
        String legacy = cacheDatabase.readSnapshot();
        try {
            JSONObject legacySnapshot = new JSONObject(legacy);
            String legacyConversationId = StartupPresentation.conversationId(
                    legacySnapshot.optString("url", "")
            );
            return conversationId.equals(legacyConversationId) ? legacy : "{}";
        } catch (Exception ignored) {
            return "{}";
        }
    }

    void queueDraft(String content) {
        pendingDraft = content;
        if (liveReadyHandled) {
            transferPendingDraft();
        } else if (liveView.getUrl() == null) {
            startLivePage();
        }
    }

    private String safeStartupUrl(String value) {
        if (SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, value)) {
            try {
                URI candidate = URI.create(value);
                if (candidate.getPath() != null && candidate.getPath().startsWith("/app/")) {
                    return value;
                }
            } catch (RuntimeException ignored) {
                // Fall through to the default app entry.
            }
        }
        return BuildConfig.SERVER_BASE_URL + "app/";
    }

    private void pollLiveReady() {
        if (isFinishing() || liveView == null) return;
        liveView.evaluateJavascript(READ_LIVE_STATE_SCRIPT, raw -> {
            try {
                String decoded = decodeJavascriptString(raw);
                if (decoded == null || decoded.isEmpty()) throw new IllegalStateException("empty state");
                JSONObject state = new JSONObject(decoded);
                String documentUrl = state.optString("url", "");
                if (state.optBoolean("shellReady")
                        && SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, documentUrl)) {
                    revealLiveShell();
                }
                if (state.optBoolean("ready")
                        && SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, documentUrl)) {
                    if (state.optBoolean("dialogue")) {
                        cacheDatabase.saveSnapshot(state.toString(), documentUrl);
                    }
                    handleLiveRuntimeReady();
                    return;
                }
            } catch (Exception ignored) {
                // A partially loaded page is expected until the dialogue runtime reports ready.
            }
            if (System.currentTimeMillis() - liveStartedAt < READY_TIMEOUT_MS) {
                handler.postDelayed(this::pollLiveReady, READY_POLL_MS);
            } else {
                updateSnapshotConnectionState(isOnline(), false);
            }
        });
    }

    private static String decodeJavascriptString(String raw) throws Exception {
        if (raw == null || "null".equals(raw)) return null;
        return new JSONArray("[" + raw + "]").getString(0);
    }

    void onLiveShellReady(String documentUrl) {
        if (!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, documentUrl)
                || !StartupPresentation.isConversationUrl(documentUrl)) return;
        revealLiveShell();
    }

    private void revealLiveShell() {
        if (liveRevealed && snapshotView.getVisibility() == View.GONE) return;
        liveRevealed = true;
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        snapshotView.setVisibility(View.GONE);
        snapshotView.setAlpha(1f);
        updateSnapshotConnectionState(isOnline(), false);
        checkForPatchUpdate();
    }

    private void handleLiveRuntimeReady() {
        if (liveReadyHandled) return;
        liveReadyHandled = true;
        revealLiveShell();
        updateSnapshotConnectionState(true, false);
        transferPendingDraft();
        checkForPatchUpdate();
    }

    private void showSnapshotFallback() {
        liveRevealed = false;
        liveView.animate().cancel();
        snapshotView.animate().cancel();
        liveReadyHandled = false;
        liveView.setAlpha(0f);
        snapshotView.setVisibility(View.VISIBLE);
        snapshotView.setAlpha(1f);
        updateSnapshotConnectionState(false, false);
    }

    private void transferPendingDraft() {
        if (pendingDraft.isEmpty() || !liveReadyHandled) return;
        String content = pendingDraft;
        pendingDraft = "";
        String script = "(() => { const frame=document.querySelector('#dialogue-frame');"
                + "if(!frame?.contentWindow)return false;frame.contentWindow.postMessage({"
                + "channel:'homer:dialogue-host:v1',version:1,type:'draft',content:"
                + JSONObject.quote(content) + ",submit:true},location.origin);return true; })()";
        liveView.evaluateJavascript(script, null);
    }

    private void checkForPatchUpdate() {
        if (updateChecked) return;
        updateChecked = true;
        patchManager.checkForUpdateAsync(new PatchManager.Callback() {
            @Override
            public void onInstalled(String version) {
                runOnUiThread(() -> snapshotView.loadUrl(patchManager.offlineEntryUrl()));
            }

            @Override
            public void onNoUpdate() {
                // No user-facing interruption is needed.
            }

            @Override
            public void onFailure(String message) {
                // The active slot remains untouched; retry on the next application start.
            }
        });
    }

    private void updateSnapshotConnectionState(boolean online, boolean connecting) {
        if (snapshotView == null) return;
        String script = "window.HomerSnapshot&&window.HomerSnapshot.setConnectionState("
                + online + "," + connecting + ")";
        snapshotView.evaluateJavascript(script, null);
    }

    private boolean isOnline() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) return false;
        Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (RuntimeException ignored) {
            // No compatible external application is installed.
        }
    }

    @Override
    public void onBackPressed() {
        if (liveRevealed && liveView.canGoBack()) {
            liveView.goBack();
            return;
        }
        if (restorePreviousPersistentPage()) return;
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        fileChooserCallback.onReceiveValue(result);
        fileChooserCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != WEB_PERMISSION_REQUEST || pendingPermissionRequest == null) return;
        List<String> granted = new ArrayList<>();
        for (String resource : pendingPermissionResources) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            }
        }
        if (granted.isEmpty()) pendingPermissionRequest.deny();
        else pendingPermissionRequest.grant(granted.toArray(new String[0]));
        pendingPermissionRequest = null;
        pendingPermissionResources = new String[0];
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        if (snapshotView != null) snapshotView.destroy();
        Set<WebView> views = new HashSet<>(persistentPages.values());
        if (liveView != null) views.add(liveView);
        for (WebView view : views) view.destroy();
        persistentPages.clear();
        if (cacheDatabase != null) cacheDatabase.close();
        super.onDestroy();
    }

    private final class LiveClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            WebResourceResponse local = clientAssetStore.intercept(request);
            return local != null ? local : super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri target = request.getUrl();
            String value = target.toString();
            if (SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, value)) {
                if (request.isForMainFrame() && view == liveView && switchPersistentPage(value)) return true;
                return false;
            }
            if (request.isForMainFrame() && ("https".equals(target.getScheme())
                    || "market".equals(target.getScheme()))) {
                openExternal(target);
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (view != liveView) return;
            liveStartedAt = System.currentTimeMillis();
            liveReadyHandled = false;
            boolean conversationTarget = StartupPresentation.isConversationUrl(url);
            prepareSnapshotForTarget(url);
            liveRevealed = !conversationTarget;
            snapshotView.setVisibility(conversationTarget ? View.VISIBLE : View.GONE);
            snapshotView.setAlpha(1f);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (view != liveView) return;
            if (!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, url)) return;
            applyNativeInsetsToWebViews();
            cacheDatabase.saveLastUrl(url);
            handler.removeCallbacksAndMessages(null);
            pollLiveReady();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == liveView && request.isForMainFrame()) showSnapshotFallback();
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (view == liveView) showSnapshotFallback();
        }
    }

    private final class LiveChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> callback,
                FileChooserParams params
        ) {
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            try {
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                return true;
            } catch (RuntimeException error) {
                fileChooserCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> handleWebPermissionRequest(request));
        }
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        if (!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, request.getOrigin().toString())) {
            request.deny();
            return;
        }
        List<String> androidPermissions = new ArrayList<>();
        List<String> acceptedResources = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                acceptedResources.add(resource);
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    androidPermissions.add(Manifest.permission.CAMERA);
                }
            }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                acceptedResources.add(resource);
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    androidPermissions.add(Manifest.permission.RECORD_AUDIO);
                }
            }
        }
        if (acceptedResources.isEmpty()) {
            request.deny();
            return;
        }
        if (androidPermissions.isEmpty()) {
            request.grant(acceptedResources.toArray(new String[0]));
            return;
        }
        if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
        pendingPermissionRequest = request;
        pendingPermissionResources = acceptedResources.toArray(new String[0]);
        requestPermissions(androidPermissions.toArray(new String[0]), WEB_PERMISSION_REQUEST);
    }
}
