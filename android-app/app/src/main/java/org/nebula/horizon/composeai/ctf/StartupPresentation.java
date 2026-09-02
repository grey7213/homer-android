package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/** Pure startup routing rules shared by the Activity and unit tests. */
final class StartupPresentation {
    private StartupPresentation() {}

    static boolean isConversationUrl(String value) {
        if (value == null || value.trim().isEmpty()) return false;
        try {
            return "/app/chat.html".equals(URI.create(value).getPath());
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    static String conversationId(String value) {
        if (!isConversationUrl(value)) return "";
        try {
            String query = URI.create(value).getRawQuery();
            if (query == null || query.isEmpty()) return "";
            for (String pair : query.split("&")) {
                int separator = pair.indexOf('=');
                String rawKey = separator >= 0 ? pair.substring(0, separator) : pair;
                if (!"conversation_id".equals(decode(rawKey))) continue;
                String rawValue = separator >= 0 ? pair.substring(separator + 1) : "";
                return decode(rawValue).trim();
            }
        } catch (RuntimeException ignored) {
            // Invalid URLs and encodings cannot identify a conversation cache.
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
