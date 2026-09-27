package org.nebula.horizon.composeai.ctf;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Match the engine, not the Android release or a vendor's package version. */
final class WebViewCompatibility {
    static final int MIN_CHROMIUM = 89; // Runtime ES modules use top-level await.
    private static final Pattern CHROME = Pattern.compile("(?:Chrome|Chromium)/(\\d+)\\.");

    static int chromiumMajor(String userAgent) {
        Matcher match = CHROME.matcher(userAgent == null ? "" : userAgent);
        if (!match.find()) return 0;
        try { return Integer.parseInt(match.group(1)); }
        catch (NumberFormatException ignored) { return 0; }
    }

    static boolean needsUpdate(String userAgent) {
        int major = chromiumMajor(userAgent);
        return major > 0 && major < MIN_CHROMIUM;
    }
}
