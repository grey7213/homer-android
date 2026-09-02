package org.nebula.horizon.composeai.ctf;

/** Maps same-origin product URLs to the immutable client resources bundled in the APK. */
public final class ClientAssetRoutes {
    private ClientAssetRoutes() {}

    private static final String[] RUNTIME_STATIC_PREFIXES = {
            "/scripts/", "/lib/", "/css/", "/webfonts/", "/locales/", "/sounds/"
    };

    public static String assetPath(String requestPath) {
        if (requestPath == null || requestPath.isEmpty()) return null;
        String path = requestPath.replace('\\', '/');
        if (!path.startsWith("/") || path.contains("\u0000") || path.contains("..")) return null;

        if ("/".equals(path)) return "client/web/index.html";
        if ("/app".equals(path) || "/app/".equals(path)) {
            return "client/web/app/index.html";
        }
        if ("/dashboard.html".equals(path) || "/admin.html".equals(path)) {
            return "client/web" + path;
        }
        if (path.startsWith("/app/") || path.startsWith("/assets/")) {
            return "client/web" + path;
        }
        if ("/favicon.ico".equals(path) || "/robots.txt".equals(path)) {
            return "client/web" + path;
        }

        // Runtime extensions are inserted dynamically with root-relative URLs.
        // These are immutable client files; account/model/chat APIs still fall
        // through to the configured server.
        for (String prefix : RUNTIME_STATIC_PREFIXES) {
            if (path.startsWith(prefix)) {
                String runtimePath = path;
                if (runtimePath.startsWith("/scripts/extensions/third-party/dialogue-memory-books/")) {
                    runtimePath = runtimePath.replace(
                            "/scripts/extensions/third-party/dialogue-memory-books/",
                            "/scripts/extensions/third-party/SillyTavern-MemoryBooks/"
                    );
                }
                return "client/runtime" + runtimePath;
            }
        }
        if ("/script.js".equals(path) || "/lib.js".equals(path) || "/style.css".equals(path)) {
            return "client/runtime" + path;
        }

        if ("/module/dialogue".equals(path) || "/module/dialogue/".equals(path)) {
            return "client/runtime/index.html";
        }
        if (path.startsWith("/module/dialogue/")) {
            String relative = path.substring("/module/dialogue/".length());
            if (relative.isEmpty()) return "client/runtime/index.html";
            if (relative.startsWith("scripts/extensions/third-party/dialogue-memory-books/")) {
                relative = relative.replace(
                        "scripts/extensions/third-party/dialogue-memory-books/",
                        "scripts/extensions/third-party/SillyTavern-MemoryBooks/"
                );
            }
            return "client/runtime/" + relative;
        }
        return null;
    }
}
