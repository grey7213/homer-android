package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class PersistentPageNavigationTest {
    @Test
    public void keepsPrimaryProductSurfacesInSeparatePersistentViews() {
        assertEquals("chat", HomerActivity.persistentPageKey("https://example.test/app/chat.html?conversation_id=c1"));
        assertEquals("explore", HomerActivity.persistentPageKey("https://example.test/app/explore.html"));
        assertEquals("me", HomerActivity.persistentPageKey("https://example.test/app/me.html"));
        assertEquals("favorites", HomerActivity.persistentPageKey("https://example.test/app/favorites.html"));
        assertEquals("workshop", HomerActivity.persistentPageKey("https://example.test/app/workshop.html"));
        assertEquals("account", HomerActivity.persistentPageKey("https://example.test/dashboard.html"));
        assertEquals("admin", HomerActivity.persistentPageKey("https://example.test/admin.html"));
        assertEquals("", HomerActivity.persistentPageKey("https://example.test/app/character.html?id=card-1"));
    }
}
