package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PersistentPageNavigationTest {
    @Test
    public void keepsPrimaryProductSurfacesInSeparatePersistentViews() {
        assertEquals("chat", HomerActivity.persistentPageKey("https://example.test/app/chat.html?conversation_id=c1"));
        assertEquals("explore", HomerActivity.persistentPageKey("https://example.test/app/explore.html"));
        assertEquals("histories", HomerActivity.persistentPageKey("https://example.test/app/histories.html"));
        assertEquals("me", HomerActivity.persistentPageKey("https://example.test/app/me.html"));
        assertEquals("favorites", HomerActivity.persistentPageKey("https://example.test/app/favorites.html"));
        assertEquals("workshop", HomerActivity.persistentPageKey("https://example.test/app/workshop.html"));
        assertEquals("account", HomerActivity.persistentPageKey("https://example.test/dashboard.html"));
        assertEquals("admin", HomerActivity.persistentPageKey("https://example.test/admin.html"));
        assertEquals("", HomerActivity.persistentPageKey("https://example.test/app/character.html?id=card-1"));
    }

    @Test
    public void reloadsPersistentViewWhenConversationTargetChanges() {
        String first = "https://example.test/app/chat.html?app_id=card-1&conversation_id=conv-1";
        String second = "https://example.test/app/chat.html?app_id=card-1&conversation_id=conv-2";
        assertFalse(HomerActivity.shouldLoadPersistentTarget(first, first));
        assertTrue(HomerActivity.shouldLoadPersistentTarget(first, second));
        assertTrue(HomerActivity.shouldLoadPersistentTarget(null, second));
    }
}
