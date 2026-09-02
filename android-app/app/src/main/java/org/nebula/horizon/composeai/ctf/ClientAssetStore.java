package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Serves product-owned static resources locally while API requests remain on the server. */
public final class ClientAssetStore {
    private final Context context;
    private final PatchManager patchManager;
    private final Set<String> bundledAssets;

    ClientAssetStore(Context context, PatchManager patchManager) {
        this.context = context.getApplicationContext();
        this.patchManager = patchManager;
        this.bundledAssets = loadBundledIndex();
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        if (request == null || !"GET".equalsIgnoreCase(request.getMethod())) return null;
        Uri uri = request.getUrl();
        if (uri == null || !SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, uri.toString())) {
            return null;
        }
        String assetPath = ClientAssetRoutes.assetPath(uri.getPath());
        if (assetPath == null) return null;

        InputStream stream = null;
        try {
            stream = patchManager.openActiveAsset(assetPath);
            if (stream == null && bundledAssets.contains(assetPath.substring("client/".length()))) {
                stream = context.getAssets().open(assetPath);
            }
            if (stream == null) return null;
            String mime = mimeType(assetPath);
            String encoding = isText(mime) ? StandardCharsets.UTF_8.name() : null;
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "public, max-age=31536000, immutable");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("X-Homer-Client-Asset", "apk");
            if ("text/html".equals(mime)) headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
        } catch (IOException error) {
            if (stream != null) {
                try { stream.close(); } catch (IOException ignored) {}
            }
            return null;
        }
    }

    Set<String> bundledAssetsForTest() {
        return Collections.unmodifiableSet(bundledAssets);
    }

    private Set<String> loadBundledIndex() {
        Set<String> result = new HashSet<>();
        try (InputStream input = context.getAssets().open("client/index.txt");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String path = line.trim().replace('\\', '/');
                if (!path.isEmpty() && !path.startsWith("/") && !path.contains("..")) result.add(path);
            }
        } catch (IOException ignored) {
            // A missing index fails closed: the request continues to the configured server.
        }
        return result;
    }

    static String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".ogg")) return "audio/ogg";
        if (lower.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }

    private static boolean isText(String mime) {
        return mime.startsWith("text/") || "application/json".equals(mime)
                || "image/svg+xml".equals(mime);
    }
}
