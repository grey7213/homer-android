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
import android.webkit.RenderProcessGoneDetail;
import android.net.http.SslError;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;

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
    private volatile String appVisitId = java.util.UUID.randomUUID().toString();
    private boolean handlingWebBack;
    private boolean accountAvailable;

    void onAccountAvailable(boolean available) {
        accountAvailable = available;
        if (available) scheduleDialoguePreparation();
    }

    private void scheduleDialoguePreparation() {
        // Use a separate callback: the visible-page readiness poll cancels its
        // own Handler callbacks. Never warm a card or reopen a conversation.
        root.post(() -> {
            if (!accountAvailable || startupFailed || isFinishing() || isDestroyed()
                    || persistentPages.containsKey("chat")) return;
            if (!java.util.Arrays.asList("explore", "community", "workshop", "histories", "me", "admin").contains(activePersistentPage)) return;
            WebView prepared = new WebView(this);
            configureLiveView(prepared);
            prepared.setVisibility(View.INVISIBLE);
            persistentPages.put("chat", prepared);
            preparedDialogueHosts.add(prepared);
            root.addView(prepared, 0, matchParent());
            prepared.loadUrl(BuildConfig.SERVER_BASE_URL.replaceAll("/$", "") + "/app/chat.html?prewarm=1");
        });
    }

    void prepareAdminConversation(String appId) {
        // Only asks the retained host to perform authenticated read-only work.
        // The server, not this bridge or the URL flag, grants preview access.
        WebView prepared = persistentPages.get("chat");
        if (!accountAvailable || prepared == null) return;
        if (!readyConversationHosts.contains(prepared)) {
            pendingAdminPreparation.put(prepared, appId);
            return;
        }
        prepared.evaluateJavascript("window.dispatchEvent(new CustomEvent('homer:prepare-admin-preview',"
                + "{detail:{app_id:" + JSONObject.quote(appId) + "}}))", null);
    }

    private static final String CLOSE_WEB_OVERLAY_SCRIPT = """
            (() => {
              const close = scope => {
                try {
                  if (scope.location.origin !== location.origin) return false;
                  if (typeof scope.HomerCloseOverlay === 'function' && scope.HomerCloseOverlay()) return true;
                  const dialogs = [...scope.document.querySelectorAll('dialog[open]')]
                    .filter(el => el.getClientRects().length);
                  const dialog = dialogs.at(-1);
                  if (!dialog) return false;
                  if (dialog.dispatchEvent(new scope.Event('cancel', {cancelable:true}))) dialog.close();
                  return true;
                } catch (_) { return false; }
              };
              if (close(window)) return true;
              const frame = document.body.classList.contains('is-ready')
                ? document.querySelector('#dialogue-frame') : null;
              return Boolean(frame && close(frame.contentWindow));
            })()
            """;

    String getAppVisitId() { return appVisitId; }

    @Override protected void onStart() {
        super.onStart();
        appVisitId = java.util.UUID.randomUUID().toString();
    }

    @Override protected void onResume() {
        super.onResume();
        if (apkUpdates != null) apkUpdates.onResume();
        if (!startupFailed && liveView != null) liveView.evaluateJavascript(
                "window.dispatchEvent(new Event('homer:app-enter'))", null);
    }

    @Override protected void onPause() {
        if (apkUpdates != null) apkUpdates.onPause();
        super.onPause();
    }

    void checkForAppUpdate() { if (apkUpdates != null) apkUpdates.check(true); }
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
    private final Set<WebView> preparedDialogueHosts = new HashSet<>();
    private final Set<WebView> readyConversationHosts = new HashSet<>();
    private final Map<WebView, String> pendingConversationNavigations = new HashMap<>();
    private final Map<WebView, String> pendingAdminPreparation = new HashMap<>();
    private final ArrayDeque<String> persistentPageHistory = new ArrayDeque<>();
    private String activePersistentPage = "";
    private HomerCacheDatabase cacheDatabase;
    private PatchManager patchManager;
    private ApkUpdateController apkUpdates;
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
    private boolean startupFailed;
    private View recoveryPanel;
    private String snapshotConversationId = "";
    private int nativeSafeTop;
    private int nativeSafeRight;
    private int nativeSafeBottom;
    private int nativeSafeLeft;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFFF5F3F7);
        getWindow().setNavigationBarColor(0xFFF5F3F7);

        cacheDatabase = new HomerCacheDatabase(this);
        patchManager = new PatchManager(this);
        patchManager.recoverInterruptedUpdate();
        clientAssetStore = new ClientAssetStore(this, patchManager);
        apkUpdates = new ApkUpdateController(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(0xFFF5F3F7);
        // A native surface exists before touching the system WebView provider.
        // A disabled/broken provider must not leave a blank activity or crash it.
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
                // Android 15 edge-to-edge does not resize our padded WebViews
                // automatically. IME and navigation occupy the same bottom
                // edge, so use their union rather than adding them twice.
                bottom = Math.max(bars.bottom, current.getInsets(WindowInsets.Type.ime()).bottom);
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

        try {
            liveView = new WebView(this);
            if (WebViewCompatibility.needsUpdate(liveView.getSettings().getUserAgentString())) {
                showRecovery("系统网页组件需要更新", "当前网页组件过旧，无法运行对话模块。更新 Android System WebView 或系统浏览器后重试；账号和聊天记录不会被清除。", true);
                return;
            }
            refreshInstalledAssetCache(liveView);
            snapshotView = new WebView(this);
            root.addView(liveView, matchParent());
            root.addView(snapshotView, matchParent());
            configureSnapshotView();
            configureLiveView(liveView);
        } catch (RuntimeException | LinkageError unavailable) {
            showRecovery("无法启动系统网页组件", "请启用或更新手机的 Android System WebView／系统浏览器后重试。无需卸载应用，也不要清除应用数据。", true);
            return;
        }
        String startupTarget = startupUrl(BuildConfig.SERVER_BASE_URL, cacheDatabase.readLastUrl());
        prepareSnapshotForTarget(startupTarget);
        // Give the tiny local document the first main-loop turn before the
        // heavier live WebView begins parsing the bundled runtime.
        handler.post(this::startLivePage);
    }

    private void showRecovery(String title, String message, boolean updateEngine) {
        if (isFinishing() || isDestroyed()) return;
        startupFailed = true;
        liveRevealed = false;
        handler.removeCallbacksAndMessages(null);
        if (recoveryPanel != null) root.removeView(recoveryPanel);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int padding = Math.round(28 * getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding, padding, padding);
        panel.setBackgroundColor(0xFFF5F3F7);
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(22);
        heading.setTextColor(0xFF202126);
        panel.addView(heading);
        TextView description = new TextView(this);
        description.setText(message);
        description.setTextSize(16);
        description.setTextColor(0xFF45464E);
        description.setPadding(0, padding / 2, 0, padding);
        panel.addView(description);
        Button retry = new Button(this);
        retry.setText("重新打开");
        retry.setOnClickListener(v -> recreate());
        panel.addView(retry);
        if (updateEngine) {
            Button settings = new Button(this);
            settings.setText("打开网页组件设置");
            settings.setOnClickListener(v -> {
                try {
                    android.content.pm.PackageInfo provider = WebView.getCurrentWebViewPackage();
                    Intent intent = provider == null ? new Intent(Settings.ACTION_SETTINGS)
                            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:" + provider.packageName));
                    startActivity(intent);
                } catch (RuntimeException unavailable) {
                    startActivity(new Intent(Settings.ACTION_SETTINGS));
                }
            });
            panel.addView(settings);
        }
        recoveryPanel = panel;
        root.addView(panel, matchParent());
    }

    private boolean handleRendererExit(WebView view) {
        // Android calls this for every WebView sharing the failed renderer.
        // Only dispose of the supplied view, never clear persistent user data.
        persistentPages.values().removeAll(java.util.Collections.singleton(view));
        preparedDialogueHosts.remove(view);
        readyConversationHosts.remove(view);
        pendingConversationNavigations.remove(view);
        pendingAdminPreparation.remove(view);
        if (view == liveView) liveView = null;
        if (view == snapshotView) snapshotView = null;
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        showRecovery("页面已停止运行", "系统回收了页面进程。点“重新打开”恢复，已保存的会话和登录状态会保留。", false);
        return true;
    }

    private void refreshInstalledAssetCache(WebView view) {
        try {
            long revision = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
            android.content.SharedPreferences state = getSharedPreferences("homer-web-assets", MODE_PRIVATE);
            if (state.getLong("installed-at", -1) != revision) {
                // HTTP resource cache only. Never clear cookies, WebStorage,
                // account preferences, conversation databases or user files.
                view.clearCache(true);
                state.edit().putLong("installed-at", revision).apply();
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            // The current package should always exist; do not erase user state.
        }
    }

    private void applyNativeInsetsToWebViews() {
        // The native root is padded by the measured insets above.  Keep the
        // CSS fallback variables at zero to avoid applying the same inset twice
        // inside the WebView while still allowing browser-hosted pages to use
        // env(safe-area-inset-*).
        final String script = "(() => { const r = document.documentElement; "
                + "if (!r) return; "
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
        snapshotView.setBackgroundColor(0xFFF5F3F7);
        snapshotView.addJavascriptInterface(
                new SnapshotBridge(this),
                "HomerNative"
        );
        snapshotView.setWebViewClient(new WebViewClient() {
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return handleRendererExit(view);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !"file".equalsIgnoreCase(scheme);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (startupFailed || view != snapshotView) return;
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
        view.setBackgroundColor(0xFFF5F3F7);
        view.setAlpha(1f);
        view.setVisibility(View.VISIBLE);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new LiveClient());
        view.setWebChromeClient(new LiveChromeClient());
        view.addJavascriptInterface(new LiveBridge(this, cacheDatabase, view), "HomerNative");
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

    private String settingsSurface = "";

    void setAppTheme(boolean dark) {
        getPreferences(MODE_PRIVATE).edit().putBoolean("app_theme_dark", dark).apply();
        applySystemBars();
    }

    void setSettingsSurface(String mode) {
        settingsSurface = mode;
        applySystemBars();
    }

    @SuppressWarnings("deprecation")
    private void applySystemBars() {
        String visibleUrl = liveView == null ? null : liveView.getUrl();
        boolean darkConversation = visibleUrl == null || "about:blank".equals(visibleUrl)
                ? "chat".equals(activePersistentPage) : StartupPresentation.isConversationUrl(visibleUrl);
        if (!darkConversation) settingsSurface = "";
        // The app theme governs non-chat pages too, including the inset behind
        // Android 15's transparent bars. Conversation appearance stays separate.
        if (!darkConversation) darkConversation = getPreferences(MODE_PRIVATE).getBoolean("app_theme_dark", false);
        boolean settingsVisible = !settingsSurface.isEmpty();
        if (settingsVisible) darkConversation = "dark".equals(settingsSurface);
        int surfaceColor = settingsVisible ? (darkConversation ? 0xFF000000 : 0xFFF2F2F7)
                : (darkConversation ? 0xFF141414 : 0xFFF5F3F7);
        getWindow().setStatusBarColor(surfaceColor);
        getWindow().setNavigationBarColor(settingsVisible ? surfaceColor : darkConversation ? 0xFF212121 : 0xFFF5F3F7);
        // Android 15 may make the system bar transparent. Its inset area must
        // match the icon appearance instead of showing the white window below.
        if (root != null) root.setBackgroundColor(surfaceColor);
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller == null) return;
            controller.setSystemBarsAppearance(
                    darkConversation ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
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
                : darkConversation ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
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
        if (startupFailed || liveView == null || snapshotView == null) return;
        liveStartedAt = System.currentTimeMillis();
        liveReadyHandled = false;
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        String target = startupUrl(BuildConfig.SERVER_BASE_URL, cacheDatabase.readLastUrl());
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
            if ("/app/histories.html".equals(path)) return "histories";
            if ("/app/favorites.html".equals(path)) return "favorites";
            if ("/app/community.html".equals(path)) return "community";
            if ("/app/workshop.html".equals(path)) return "workshop";
            if ("/app/me.html".equals(path)) return "me";
            if ("/dashboard.html".equals(path)) return "account";
            if ("/admin.html".equals(path)) return "admin";
        } catch (RuntimeException ignored) {
            // Invalid URLs are rejected by SafeUrls before navigation.
        }
        return "";
    }

    static boolean shouldLoadPersistentTarget(String current, String target) {
        return current == null || !current.equals(target);
    }

    static boolean canSwitchConversationInPlace(String current, String target) {
        if (current == null || target == null) return false;
        try {
            URI from = URI.create(current);
            URI to = URI.create(target);
            String query = to.getRawQuery();
            return "/app/chat.html".equals(from.getPath()) && "/app/chat.html".equals(to.getPath())
                    && java.util.Objects.equals(from.getScheme(), to.getScheme())
                    && java.util.Objects.equals(from.getRawAuthority(), to.getRawAuthority())
                    && query != null && query.matches(".*(?:^|&)app_id=[^&]+.*");
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    /** The warmed chat document can receive the first conversation bind without a reload. */
    static boolean isPreparedChatUrl(String value) {
        if (value == null) return false;
        try {
            URI uri = URI.create(value);
            String query = uri.getRawQuery();
            return "/app/chat.html".equals(uri.getPath())
                    && query != null
                    && query.matches("(?:^|.*&)prewarm=1(?:&.*|$)");
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private boolean switchLiveConversation(WebView view, String target) {
        String current = view.getUrl();
        if (preparedDialogueHosts.contains(view) && !readyConversationHosts.contains(view)) {
            // A tap before chat.js installs its listener is queued, not treated
            // as an old bundle requiring loadUrl (which would reboot the engine).
            pendingConversationNavigations.put(view, target);
            return true;
        }
        if (!canSwitchConversationInPlace(current, target) && !isPreparedChatUrl(current)) return false;
        String script = "!window.dispatchEvent(new CustomEvent('homer:navigate-conversation',"
                + "{cancelable:true,detail:{url:" + JSONObject.quote(target) + "}}))";
        view.evaluateJavascript(script, handled -> {
            if (view != liveView) return;
            if ("true".equals(handled)) {
                snapshotView.setVisibility(View.GONE);
                liveRevealed = true;
                cacheDatabase.saveLastUrl(view.getUrl());
            } else {
                // Older web bundles do not implement the event yet.
                view.loadUrl(target);
            }
        });
        return true;
    }

    private void registerInitialPersistentPage(String target) {
        String key = persistentPageKey(target);
        if (key.isEmpty()) return;
        persistentPages.put(key, liveView);
        activePersistentPage = key;
        applySystemBars();
    }

    private boolean switchPersistentPage(String target) {
        String key = persistentPageKey(target);
        if (key.isEmpty()) return false;
        if (activePersistentPage.isEmpty() && persistentPages.isEmpty()) {
            persistentPages.put(key, liveView);
            activePersistentPage = key;
        applySystemBars();
            return false;
        }
        if (key.equals(activePersistentPage)) {
            String current = liveView.getUrl();
            return current != null && (current.equals(target) || switchLiveConversation(liveView, target));
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
        applySystemBars();
        String currentTarget = liveView.getUrl();
        boolean targetChanged = shouldLoadPersistentTarget(currentTarget, target);
        liveView.setAlpha(1f);
        liveView.setVisibility(View.VISIBLE);
        if (targetChanged) {
            boolean conversationTarget = StartupPresentation.isConversationUrl(target);
            prepareSnapshotForTarget(target);
            snapshotView.setVisibility(conversationTarget ? View.VISIBLE : View.GONE);
            liveRevealed = !conversationTarget;
            liveReadyHandled = false;
            snapshotView.setAlpha(1f);
            if (!switchLiveConversation(liveView, target)) liveView.loadUrl(target);
        } else {
            snapshotView.setVisibility(View.GONE);
            liveRevealed = true;
            liveReadyHandled = true;
            cacheDatabase.saveLastUrl(currentTarget);
            liveView.evaluateJavascript("window.dispatchEvent(new Event('homer:page-visible'))", null);
        }
        applyNativeInsetsToWebViews();
        return true;
    }

    void discardInactiveAccountPages() {
        Set<WebView> stale = new HashSet<>(persistentPages.values());
        stale.remove(liveView);
        for (WebView view : stale) {
            view.stopLoading();
            root.removeView(view);
            view.destroy();
        }
        persistentPages.clear();
        persistentPageHistory.clear();
        preparedDialogueHosts.clear();
        readyConversationHosts.clear();
        pendingConversationNavigations.clear();
        pendingAdminPreparation.clear();
        activePersistentPage = "";
        snapshotLoaded = false;
        snapshotConversationId = "";
        snapshotView.setVisibility(View.GONE);
    }

    private boolean restorePreviousPersistentPage() {
        while (!persistentPageHistory.isEmpty()) {
            String key = persistentPageHistory.removeLast();
            WebView target = persistentPages.get(key);
            if (target == null || key.equals(activePersistentPage)) continue;
            if (liveView != null) liveView.setVisibility(View.GONE);
            liveView = target;
            activePersistentPage = key;
        applySystemBars();
            liveView.setAlpha(1f);
            liveView.setVisibility(View.VISIBLE);
            snapshotView.setVisibility(View.GONE);
            liveRevealed = true;
            liveReadyHandled = true;
            String url = liveView.getUrl();
            if (url != null) cacheDatabase.saveLastUrl(url);
            liveView.evaluateJavascript("window.dispatchEvent(new Event('homer:page-visible'))", null);
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

    /**
     * Cold start restores the last page the user visited. A stored conversation
     * keeps its instant local snapshot; a first/untrusted launch uses the app
     * entry, which opens community when the deployed backend reports it ready.
     */
    static String startupUrl(String serverBaseUrl, String stored) {
        if (SafeUrls.isTrustedNavigation(serverBaseUrl, stored)) {
            try {
                URI candidate = URI.create(stored);
                if (candidate.getPath() != null && candidate.getPath().startsWith("/app/")) {
                    return stored;
                }
            } catch (RuntimeException ignored) {
                // Fall through to the default app entry.
            }
        }
        return serverBaseUrl + "app/";
    }

    private void pollLiveReady() {
        if (startupFailed || isFinishing() || liveView == null) return;
        final WebView observedView = liveView;
        observedView.evaluateJavascript(READ_LIVE_STATE_SCRIPT, raw -> {
            // An asynchronous callback from a page that has since become
            // inactive must not reveal it or overwrite the last visited page.
            if (startupFailed || observedView != liveView || isFinishing() || isDestroyed()) return;
            try {
                String decoded = decodeJavascriptString(raw);
                if (decoded == null || decoded.isEmpty()) throw new IllegalStateException("empty state");
                JSONObject state = new JSONObject(decoded);
                String documentUrl = state.optString("url", "");
                if (!documentUrl.equals(observedView.getUrl())) return;
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

    void onLiveShellReady(WebView owner, String documentUrl) {
        if (!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, documentUrl)
                || !StartupPresentation.isConversationUrl(documentUrl)) return;
        if (owner != liveView && owner != persistentPages.get("chat")) return;
        readyConversationHosts.add(owner);
        String preparedCard = pendingAdminPreparation.remove(owner);
        if (preparedCard != null) prepareAdminConversation(preparedCard);
        String queuedTarget = pendingConversationNavigations.remove(owner);
        if (queuedTarget != null) switchLiveConversation(owner, queuedTarget);
        // A hidden prewarm completion must not reveal or mark the visible page.
        if (owner == liveView) revealLiveShell();
    }

    private void revealLiveShell() {
        if (startupFailed || liveView == null || snapshotView == null) return;
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
        if (startupFailed || liveView == null || snapshotView == null) return;
        if (liveReadyHandled) return;
        liveReadyHandled = true;
        revealLiveShell();
        updateSnapshotConnectionState(true, false);
        transferPendingDraft();
        checkForPatchUpdate();
    }

    private void showSnapshotFallback() {
        if (liveView == null || !StartupPresentation.isConversationUrl(liveView.getUrl())) {
            showRecovery("页面暂时无法打开", "未能加载页面，请检查网络后重新打开。不会退出账号或删除历史记录。", false);
            return;
        }
        if (snapshotView == null) return;
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
                runOnUiThread(() -> { if (!startupFailed && snapshotView != null) snapshotView.loadUrl(patchManager.offlineEntryUrl()); });
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
        if (handlingWebBack) return;
        if (liveRevealed && liveView != null) {
            final WebView current = liveView;
            handlingWebBack = true;
            current.evaluateJavascript(CLOSE_WEB_OVERLAY_SCRIPT, result -> {
                handlingWebBack = false;
                if (isFinishing() || isDestroyed() || liveView != current) return;
                if (!"true".equals(result)) navigateBack();
            });
            return;
        }
        navigateBack();
    }

    private void navigateBack() {
        if (liveRevealed && liveView != null && liveView.canGoBack()) {
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
        if (apkUpdates != null) apkUpdates.close();
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
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return handleRendererExit(view);
        }
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
            readyConversationHosts.remove(view);
            if (startupFailed || view != liveView) return;
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
            if (startupFailed || view != liveView) return;
            if (!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, url)) return;
            applySystemBars();
            applyNativeInsetsToWebViews();
            cacheDatabase.saveLastUrl(url);
            handler.removeCallbacksAndMessages(null);
            pollLiveReady();
            scheduleDialoguePreparation();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == liveView && request.isForMainFrame()) showSnapshotFallback();
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (view == liveView && request.isForMainFrame() && response.getStatusCode() >= 400) showSnapshotFallback();
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
                String[] types = FilePickerTypes.normalize(params.getAcceptTypes());
                intent.setType(types.length == 1 ? types[0] : "*/*");
                intent.removeExtra(Intent.EXTRA_MIME_TYPES);
                if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                return true;
            } catch (RuntimeException error) {
                // Some phone file managers cannot handle the WebView's intent.
                try {
                    Intent fallback = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    fallback.addCategory(Intent.CATEGORY_OPENABLE);
                    fallback.setType("*/*");
                    fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    startActivityForResult(fallback, FILE_CHOOSER_REQUEST);
                } catch (RuntimeException unavailable) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);
                    android.widget.Toast.makeText(HomerActivity.this,
                            "无法打开系统文件选择器，请启用手机的文件管理应用后重试", android.widget.Toast.LENGTH_LONG).show();
                }
                return true;
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
