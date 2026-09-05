package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.content.ContextWrapper;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.File;
import org.json.JSONArray;
import org.json.JSONObject;

/** Uses a separate database; never reads or clears a user's real cache. */
public class HomerCacheDatabaseTest {
    private Context isolated;
    private HomerCacheDatabase cache;

    @Before public void setUp() {
        isolated = new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public File getDatabasePath(String name) {
                return super.getDatabasePath("audit_" + name);
            }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode,
                    SQLiteDatabase.CursorFactory factory) {
                return super.openOrCreateDatabase("audit_" + name, mode, factory);
            }
            @Override public boolean deleteDatabase(String name) {
                return super.deleteDatabase("audit_" + name);
            }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode,
                    SQLiteDatabase.CursorFactory factory, android.database.DatabaseErrorHandler handler) {
                return super.openOrCreateDatabase("audit_" + name, mode, factory, handler);
            }
        };
        isolated.deleteDatabase("homer-local-cache.db");
        cache = new HomerCacheDatabase(isolated);
    }

    @After public void tearDown() {
        cache.close();
        isolated.deleteDatabase("homer-local-cache.db");
    }

    private void saveExample() {
        assertTrue(cache.saveConversationSnapshot("{\"conversation_id\":\"audit-chat\","
                + "\"app_id\":\"audit-card\",\"messages\":[{\"role\":\"assistant\",\"content\":\"cached reply\"}]}"));
    }

    @Test public void testAccountSwitchAndLogoutClearCache() throws Exception {
        assertTrue(cache.setAccountScope("audit-A"));
        saveExample();
        assertFalse(cache.setAccountScope("audit-A"));
        assertEquals(1, new JSONArray(cache.readConversationHistory()).length());
        assertTrue(cache.setAccountScope("audit-B"));
        assertEquals("{}", cache.readConversationSnapshot("audit-chat"));
        assertEquals("[]", cache.readConversationHistory());
        saveExample();
        assertTrue(cache.setAccountScope(""));
        assertEquals("{}", cache.readSnapshot());
        assertEquals("[]", cache.readConversationHistory());
    }

    @Test public void testHistoryDoesNotParseEntireConversation() throws Exception {
        cache.setAccountScope("audit-A");
        saveExample();
        // A bad/full message blob must not affect a summary-only list query.
        cache.getWritableDatabase().execSQL("UPDATE conversation_cache SET messages_json='not-json'");
        JSONObject item = new JSONArray(cache.readConversationHistory()).getJSONObject(0);
        assertEquals("cached reply", item.getString("last_message"));
        assertEquals("audit-chat", item.getString("id"));
    }

    @Test public void testVersionTwoMigrationClearsUnscopedCache() throws Exception {
        createLegacyDatabase(2);
        cache.setAccountScope("audit-A");
        assertEquals("[]", cache.readConversationHistory());
        saveExample();
        assertEquals("cached reply", new JSONArray(cache.readConversationHistory())
                .getJSONObject(0).getString("last_message"));
        assertEquals(4, cache.getReadableDatabase().getVersion());
    }

    @Test public void testVersionOneMigrationCreatesConversationTable() throws Exception {
        createLegacyDatabase(1);
        cache.setAccountScope("audit-A");
        saveExample();
        assertEquals(1, new JSONArray(cache.readConversationHistory()).length());
    }

    @Test public void testVersionThreeMigrationPreservesOwnedConversation() throws Exception {
        createLegacyDatabase(3);
        assertFalse(cache.setAccountScope("audit-A"));
        assertEquals("legacy", new JSONObject(cache.readConversationSnapshot("legacy"))
                .getString("conversation_id"));
        assertEquals(1, new JSONArray(cache.readConversationHistory()).length());
        saveExample();
        assertEquals(2, new JSONArray(cache.readConversationHistory()).length());
    }

    private void createLegacyDatabase(int version) {
        cache.close();
        isolated.deleteDatabase("homer-local-cache.db");
        SQLiteDatabase db = isolated.openOrCreateDatabase("homer-local-cache.db", 0, null);
        db.execSQL("CREATE TABLE app_state(id INTEGER PRIMARY KEY, snapshot_json TEXT DEFAULT '{}',"
                + "last_url TEXT DEFAULT '', updated_at INTEGER DEFAULT 0"
                + (version == 3 ? ", account_scope TEXT DEFAULT 'audit-A'" : "") + ")");
        db.execSQL("INSERT INTO app_state(id) VALUES(1)");
        if (version >= 2) {
            db.execSQL("CREATE TABLE conversation_cache(conversation_id TEXT PRIMARY KEY,app_id TEXT,"
                    + "title TEXT,avatar TEXT,messages_json TEXT,updated_at INTEGER)");
            db.execSQL("INSERT INTO conversation_cache VALUES('legacy','card','title','','[]',0)");
        }
        db.setVersion(version);
        db.close();
        cache = new HomerCacheDatabase(isolated);
    }
}
