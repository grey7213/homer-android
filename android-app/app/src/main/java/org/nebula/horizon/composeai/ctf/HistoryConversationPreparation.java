package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded read-only IDs, never navigation, account authorization or card content. */
final class HistoryConversationPreparation {
    static final long TTL_MS = 30_000;
    final String owner;
    final String targetsJson;
    final long expiresAt;

    private HistoryConversationPreparation(String owner, String targetsJson, long expiresAt) {
        this.owner = owner;
        this.targetsJson = targetsJson;
        this.expiresAt = expiresAt;
    }

    static boolean validId(String value) {
        return value != null && !value.isEmpty() && value.length() <= 160
                && value.equals(value.trim()) && value.chars().noneMatch(Character::isISOControl);
    }

    static HistoryConversationPreparation parse(String owner, String targetsJson, long expiresAt, long now) {
        if (!validId(owner) || targetsJson == null || targetsJson.length() > 8192
                || expiresAt <= now || expiresAt - now > TTL_MS) return null;
        try {
            JSONArray input = new JSONArray(targetsJson), targets = new JSONArray();
            if (input.length() < 1 || input.length() > 2) return null;
            Set<String> seen = new HashSet<>();
            for (int index = 0; index < input.length(); index++) {
                Object value = input.get(index);
                if (!(value instanceof JSONObject)) return null;
                JSONObject item = (JSONObject) value;
                if (item.length() != 2 || !(item.opt("app_id") instanceof String)
                        || !(item.opt("conversation_id") instanceof String)) return null;
                String app = item.getString("app_id"), conversation = item.getString("conversation_id");
                if (!validId(app) || !validId(conversation)) return null;
                String identity = new JSONArray().put(app).put(conversation).toString();
                if (seen.add(identity)) targets.put(new JSONObject().put("app_id", app).put("conversation_id", conversation));
            }
            return new HistoryConversationPreparation(owner, targets.toString(), expiresAt);
        } catch (Exception invalid) {
            return null;
        }
    }

    static boolean validHistorySource(String base, String document, String current) {
        try {
            return HomerChatNavigation.sameDocument(document, current)
                    && SafeUrls.isTrustedNavigation(base, document)
                    && "/app/histories.html".equals(URI.create(document).getRawPath());
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    static boolean emptyPreparedDestination(String base, String document) {
        try {
            URI uri = URI.create(document);
            // Only the actual capability-only URL, never a selected/admin chat.
            return SafeUrls.isTrustedNavigation(base, document)
                    && "/app/chat.html".equals(uri.getRawPath()) && "prewarm=1".equals(uri.getRawQuery());
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    boolean current(String availableOwner, long now) {
        return owner.equals(availableOwner) && expiresAt > now && expiresAt - now <= TTL_MS;
    }

    String eventScript() {
        return "window.dispatchEvent(new CustomEvent('homer:prepare-history-conversations',{detail:{owner:"
                + JSONObject.quote(owner) + ",targets:" + targetsJson + ",expires_at:" + expiresAt + "}}));";
    }
}
