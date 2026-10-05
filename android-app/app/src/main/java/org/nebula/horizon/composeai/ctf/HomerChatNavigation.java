package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Rejects late callbacks without reloading a retained conversation WebView. */
final class HomerChatNavigation {
    private long generation;

    long begin() {
        return ++generation;
    }

    void invalidate() {
        ++generation;
    }

    boolean accepts(long request, boolean activeOwner, String source, String target, String current) {
        return activeOwner && request == generation && (sameDocument(source, current)
                || sameRequestedConversation(target, current));
    }

    static boolean sameDocument(String expected, String current) {
        if (expected == null || current == null) return false;
        try {
            URI left = URI.create(expected).normalize();
            URI right = URI.create(current).normalize();
            return Objects.equals(left.getScheme(), right.getScheme())
                    && Objects.equals(left.getRawAuthority(), right.getRawAuthority())
                    && Objects.equals(left.getRawPath(), right.getRawPath())
                    && Objects.equals(left.getRawQuery(), right.getRawQuery());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static boolean sameRequestedConversation(String target, String current) {
        if (target == null || current == null) return false;
        try {
            URI left = URI.create(target);
            URI right = URI.create(current);
            if (!Objects.equals(left.getScheme(), right.getScheme())
                    || !Objects.equals(left.getRawAuthority(), right.getRawAuthority())
                    || !"/app/chat.html".equals(left.getPath())
                    || !Objects.equals(left.getPath(), right.getPath())) return false;
            String app = parameter(left, "app_id");
            if (app.isEmpty() || !app.equals(parameter(right, "app_id"))) return false;
            String conversation = conversation(left);
            // New-card launches may resolve their cloud conversation before
            // the native JS callback arrives; an existing history must match.
            return conversation.isEmpty() || conversation.equals(conversation(right));
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String conversation(URI uri) {
        String value = parameter(uri, "conversation_id");
        return value.isEmpty() ? parameter(uri, "conv_id") : value;
    }

    private static String parameter(URI uri, String name) {
        String query = uri.getRawQuery();
        if (query == null) return "";
        for (String pair : query.split("&")) {
            int separator = pair.indexOf('=');
            String key = separator >= 0 ? pair.substring(0, separator) : pair;
            if (!name.equals(decode(key))) continue;
            return decode(separator >= 0 ? pair.substring(separator + 1) : "").trim();
        }
        return "";
    }

    private static String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception ignored) {
            return "";
        }
    }
}
