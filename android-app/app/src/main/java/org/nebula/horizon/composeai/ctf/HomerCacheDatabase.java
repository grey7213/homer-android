package org.nebula.horizon.composeai.ctf;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class HomerCacheDatabase extends SQLiteOpenHelper {
    private static final String DB_NAME = "homer-local-cache.db";
    private static final int DB_VERSION = 2;
    private static final int MAX_PAYLOAD_CHARS = 2_000_000;

    public HomerCacheDatabase(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE app_state ("
                + "id INTEGER PRIMARY KEY CHECK (id = 1),"
                + "snapshot_json TEXT NOT NULL DEFAULT '{}',"
                + "last_url TEXT NOT NULL DEFAULT '',"
                + "updated_at INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("INSERT INTO app_state(id) VALUES (1)");
        createConversationCache(db);
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            createConversationCache(db);
        }
    }

    private static void createConversationCache(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS conversation_cache ("
                + "conversation_id TEXT PRIMARY KEY,"
                + "app_id TEXT NOT NULL DEFAULT '',"
                + "title TEXT NOT NULL DEFAULT '角色对话',"
                + "avatar TEXT NOT NULL DEFAULT '',"
                + "messages_json TEXT NOT NULL DEFAULT '[]',"
                + "updated_at INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_conversation_cache_updated "
                + "ON conversation_cache(updated_at DESC)");
    }

    public synchronized String readSnapshot() {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT snapshot_json FROM app_state WHERE id = 1", null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : "{}";
        }
    }

    public synchronized String readLastUrl() {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT last_url FROM app_state WHERE id = 1", null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : "";
        }
    }

    public synchronized boolean saveSnapshot(String payload, String url) {
        String sanitized;
        try {
            sanitized = sanitizeSnapshot(payload).toString();
        } catch (JSONException error) {
            return false;
        }
        ContentValues values = new ContentValues();
        values.put("snapshot_json", sanitized);
        values.put("last_url", safeUrl(url));
        values.put("updated_at", System.currentTimeMillis());
        return getWritableDatabase().update("app_state", values, "id = 1", null) == 1;
    }

    public synchronized void saveLastUrl(String url) {
        String safe = safeUrl(url);
        if (safe.isEmpty()) return;
        ContentValues values = new ContentValues();
        values.put("last_url", safe);
        values.put("updated_at", System.currentTimeMillis());
        getWritableDatabase().update("app_state", values, "id = 1", null);
    }

    public synchronized String readConversationSnapshot(String conversationId) {
        String safeId = safeIdentifier(conversationId, 160);
        if (safeId.isEmpty()) return "{}";
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT app_id,title,avatar,messages_json,updated_at "
                        + "FROM conversation_cache WHERE conversation_id=?",
                new String[]{safeId})) {
            if (!cursor.moveToFirst()) return "{}";
            JSONObject result = new JSONObject();
            result.put("conversation_id", safeId);
            result.put("app_id", cursor.getString(0));
            result.put("title", cursor.getString(1));
            result.put("avatar", cursor.getString(2));
            result.put("messages", new JSONArray(cursor.getString(3)));
            result.put("updated_at", cursor.getLong(4));
            return result.toString();
        } catch (JSONException error) {
            return "{}";
        }
    }

    public synchronized String readConversationHistory() {
        JSONArray history = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT conversation_id,app_id,title,avatar,messages_json,updated_at "
                        + "FROM conversation_cache ORDER BY updated_at DESC LIMIT 80",
                null)) {
            while (cursor.moveToNext()) {
                JSONObject item = new JSONObject();
                item.put("id", cursor.getString(0));
                item.put("app_id", cursor.getString(1));
                item.put("title", cursor.getString(2));
                item.put("app_icon", cursor.getString(3));
                JSONArray messages = new JSONArray(cursor.getString(4));
                String lastMessage = "";
                if (messages.length() > 0) {
                    JSONObject last = messages.optJSONObject(messages.length() - 1);
                    if (last != null) lastMessage = last.optString("content", "");
                }
                item.put("last_message", lastMessage);
                item.put("updated_at", cursor.getLong(5));
                history.put(item);
            }
        } catch (JSONException ignored) {
            return "[]";
        }
        return history.toString();
    }

    public synchronized boolean saveConversationSnapshot(String payload) {
        if (payload == null || payload.length() > MAX_PAYLOAD_CHARS) return false;
        try {
            JSONObject input = new JSONObject(payload);
            String conversationId = safeIdentifier(input.optString("conversation_id", ""), 160);
            if (conversationId.isEmpty()) return false;
            String appId = safeIdentifier(input.optString("app_id", ""), 160);
            String title = safeText(input.optString("title", "角色对话"), 120, "角色对话");
            String avatar = safeText(input.optString("avatar", ""), 2_000, "");
            JSONArray messages = sanitizeMessages(input.optJSONArray("messages"));
            long updatedAt = Math.max(System.currentTimeMillis(), input.optLong("updated_at", 0));
            ContentValues values = new ContentValues();
            values.put("conversation_id", conversationId);
            values.put("app_id", appId);
            values.put("title", title);
            values.put("avatar", avatar);
            values.put("messages_json", messages.toString());
            values.put("updated_at", updatedAt);
            return getWritableDatabase().insertWithOnConflict(
                    "conversation_cache",
                    null,
                    values,
                    SQLiteDatabase.CONFLICT_REPLACE
            ) != -1;
        } catch (JSONException error) {
            return false;
        }
    }

    private static JSONObject sanitizeSnapshot(String payload) throws JSONException {
        if (payload == null || payload.length() > MAX_PAYLOAD_CHARS) {
            throw new JSONException("Snapshot is too large");
        }
        JSONObject input = new JSONObject(payload);
        JSONObject output = new JSONObject();
        String title = input.optString("title", "角色对话").trim();
        if (title.isEmpty()) title = "角色对话";
        output.put("title", title.substring(0, Math.min(120, title.length())));
        output.put("url", safeUrl(input.optString("url", "")));
        output.put("updated_at", System.currentTimeMillis());
        JSONArray sourceMessages = input.optJSONArray("messages");
        JSONArray normalizedMessages = new JSONArray();
        if (sourceMessages != null) {
            for (int index = 0; index < sourceMessages.length(); index++) {
                JSONObject source = sourceMessages.optJSONObject(index);
                if (source == null) continue;
                JSONObject normalized = new JSONObject();
                normalized.put("id", source.optString("id", ""));
                normalized.put("role", source.optString("role", "assistant"));
                normalized.put("content", source.optString("content", source.optString("text", "")));
                normalized.put("created_at", source.optLong("created_at", 0));
                normalizedMessages.put(normalized);
            }
        }
        JSONArray cleanMessages = sanitizeMessages(normalizedMessages);
        output.put("messages", cleanMessages);
        return output;
    }

    private static JSONArray sanitizeMessages(JSONArray messages) throws JSONException {
        JSONArray cleanMessages = new JSONArray();
        if (messages == null) return cleanMessages;
        int start = Math.max(0, messages.length() - 120);
        for (int index = start; index < messages.length(); index++) {
            JSONObject message = messages.optJSONObject(index);
            if (message == null) continue;
            String role = "user".equals(message.optString("role")) ? "user" : "assistant";
            String content = safeText(
                    message.optString("content", message.optString("text", "")),
                    12_000,
                    ""
            );
            if (content.isEmpty()) continue;
            JSONObject clean = new JSONObject();
            clean.put("id", safeIdentifier(message.optString("id", ""), 180));
            clean.put("role", role);
            clean.put("content", content);
            clean.put("text", content);
            clean.put("created_at", Math.max(0, message.optLong("created_at", 0)));
            cleanMessages.put(clean);
        }
        return cleanMessages;
    }

    private static String safeIdentifier(String value, int maxLength) {
        String clean = value == null ? "" : value.trim();
        return clean.substring(0, Math.min(maxLength, clean.length()));
    }

    private static String safeText(String value, int maxLength, String fallback) {
        String clean = value == null ? "" : value.trim();
        if (clean.isEmpty()) clean = fallback;
        return clean.substring(0, Math.min(maxLength, clean.length()));
    }

    private static String safeUrl(String value) {
        String candidate = value == null ? "" : value.trim();
        return SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, candidate) ? candidate : "";
    }
}
