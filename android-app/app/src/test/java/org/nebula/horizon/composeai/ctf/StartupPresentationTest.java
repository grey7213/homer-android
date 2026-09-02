package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class StartupPresentationTest {
    @Test
    public void identifiesOnlyTheConversationDocument() {
        assertTrue(StartupPresentation.isConversationUrl(
                "https://example.test/app/chat.html?app_id=role-1&conversation_id=chat-1"
        ));
        assertFalse(StartupPresentation.isConversationUrl("https://example.test/app/"));
        assertFalse(StartupPresentation.isConversationUrl("https://example.test/app/chat.html.evil"));
        assertFalse(StartupPresentation.isConversationUrl("not a url"));
        assertFalse(StartupPresentation.isConversationUrl(null));
    }

    @Test
    public void readsTheCurrentConversationCacheKey() {
        assertEquals("chat-1", StartupPresentation.conversationId(
                "https://example.test/app/chat.html?app_id=role-1&conversation_id=chat-1"
        ));
        assertEquals("会话 2", StartupPresentation.conversationId(
                "https://example.test/app/chat.html?conversation_id=%E4%BC%9A%E8%AF%9D+2"
        ));
        assertEquals("", StartupPresentation.conversationId(
                "https://example.test/app/chat.html?app_id=role-1"
        ));
        assertEquals("", StartupPresentation.conversationId(
                "https://example.test/app/profile.html?conversation_id=chat-1"
        ));
    }
}
