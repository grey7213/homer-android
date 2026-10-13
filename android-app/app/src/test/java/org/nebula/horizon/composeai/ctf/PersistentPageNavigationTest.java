package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PersistentPageNavigationTest {
    @Test public void legacyHttpCacheIsMigratedOnceInsteadOfDeletingCardResourcesOnEveryUpgrade() {
        assertTrue(HomerActivity.requiresLegacyHttpCacheMigration(0));
        assertTrue(HomerActivity.requiresLegacyHttpCacheMigration(1));
        assertFalse(HomerActivity.requiresLegacyHttpCacheMigration(2));
        assertFalse(HomerActivity.requiresLegacyHttpCacheMigration(3));
    }
    @Test public void dialogueChildSiteLinkRoutesThroughRetainedHostOnlyForTrustedUserNavigation() {
        String chat = "https://example.test/app/chat.html?app_id=a&conversation_id=c";
        String workshop = "https://example.test/app/workshop.html";
        assertTrue(HomerActivity.isDialogueChildPageNavigation(chat, workshop, false, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(chat, workshop, false, false));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(chat, workshop, true, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(chat, "https://other.test/app/workshop.html", false, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(chat, "https://example.test/app/chat.html?app_id=b", false, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(chat, "https://example.test/app/assets/js/app-core.js", false, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(workshop, workshop, false, true));
        assertFalse(HomerActivity.isDialogueChildPageNavigation(null, workshop, false, true));
    }
    @Test
    public void launcherOpensCommunityRegardlessOfPreviouslyVisitedPage() {
        for (String previous : new String[]{"chat.html?conversation_id=c1", "explore.html",
                "me.html", "workshop.html", "histories.html", "community.html"}) {
            assertEquals("https://example.test/app/community.html",
                    HomerActivity.startupUrl("https://example.test/", "https://example.test/app/" + previous));
        }
    }

    @Test
    public void launcherNeverUsesUntrustedOrNonAppStoredTargets() {
        assertEquals("https://example.test/app/community.html",
                HomerActivity.startupUrl("https://example.test/", null));
        assertEquals("https://example.test/app/community.html",
                HomerActivity.startupUrl("https://example.test/", ""));
        assertEquals("https://example.test/app/community.html",
                HomerActivity.startupUrl("https://example.test/", "https://evil.test/app/me.html"));
        assertEquals("https://example.test/app/community.html",
                HomerActivity.startupUrl("https://example.test/", "https://example.test/dashboard.html"));
        assertEquals("https://example.test/app/community.html", HomerActivity.startupUrl("https://example.test", ""));
    }

    @Test
    public void keepsPrimaryProductSurfacesInSeparatePersistentViews() {
        assertEquals("chat", HomerActivity.persistentPageKey("https://example.test/app/chat.html?conversation_id=c1"));
        assertEquals("explore", HomerActivity.persistentPageKey("https://example.test/app/explore.html"));
        assertEquals("histories", HomerActivity.persistentPageKey("https://example.test/app/histories.html"));
        assertEquals("me", HomerActivity.persistentPageKey("https://example.test/app/me.html"));
        assertEquals("favorites", HomerActivity.persistentPageKey("https://example.test/app/favorites.html"));
        assertEquals("workshop", HomerActivity.persistentPageKey("https://example.test/app/workshop.html"));
        assertEquals("visual-novel", HomerActivity.persistentPageKey("https://example.test/app/visual-novel.html"));
        assertEquals("community", HomerActivity.persistentPageKey("https://example.test/app/community.html"));
        assertEquals("account", HomerActivity.persistentPageKey("https://example.test/dashboard.html"));
        assertEquals("admin", HomerActivity.persistentPageKey("https://example.test/admin.html"));
        assertEquals("", HomerActivity.persistentPageKey("https://example.test/app/character.html?id=card-1"));
    }

    @Test
    public void detectsChangedTargetsWithoutForcingConversationReload() {
        String first = "https://example.test/app/chat.html?app_id=card-1&conversation_id=conv-1";
        String second = "https://example.test/app/chat.html?app_id=card-1&conversation_id=conv-2";
        assertFalse(HomerActivity.shouldLoadPersistentTarget(first, first));
        assertTrue(HomerActivity.shouldLoadPersistentTarget(first, second));
        assertTrue(HomerActivity.shouldLoadPersistentTarget(null, second));
        assertTrue(HomerActivity.canSwitchConversationInPlace(first, second));
        assertTrue(HomerActivity.canSwitchConversationInPlace(first,
                "https://example.test/app/chat.html?conv_id=conv-2&app_id=card-2"));
        assertFalse(HomerActivity.canSwitchConversationInPlace(null, second));
        assertFalse(HomerActivity.canSwitchConversationInPlace(first,
                "https://other.test/app/chat.html?app_id=card-1&conversation_id=conv-2"));
        assertTrue(HomerActivity.canSwitchConversationInPlace(first,
                "https://example.test/app/chat.html?app_id=card-new"));
        assertFalse(HomerActivity.canSwitchConversationInPlace(first,
                "https://example.test/app/chat.html?app_id=&conversation_id=conv-2"));
        assertFalse(HomerActivity.canSwitchConversationInPlace(first,
                "https://example.test/app/explore.html"));
    }
}
