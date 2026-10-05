package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class HomerChatNavigationTest {
    private static final String FIRST = "https://example.test/app/chat.html?app_id=card-1&conversation_id=conv-1";
    private static final String SECOND = "https://example.test/app/chat.html?app_id=card-2&conversation_id=conv-2";

    @Test public void latestTargetRejectsLateFallbackFromTheSameRetainedOwner() {
        HomerChatNavigation guard = new HomerChatNavigation();
        long old = guard.begin();
        long current = guard.begin();
        assertFalse(guard.accepts(old, true, FIRST, FIRST, SECOND));
        assertTrue(guard.accepts(current, true, FIRST, SECOND, SECOND));
    }

    @Test public void documentReloadInvalidatesAResultEvenWhenTheUrlDidNotChange() {
        HomerChatNavigation guard = new HomerChatNavigation();
        long request = guard.begin();
        guard.invalidate();
        assertFalse(guard.accepts(request, true, FIRST, SECOND, FIRST));
    }

    @Test public void allowsCurrentHandledAndLegacyFallbackCallbacks() {
        HomerChatNavigation guard = new HomerChatNavigation();
        long request = guard.begin();
        assertTrue(guard.accepts(request, true, FIRST, SECOND, FIRST));
        assertTrue(guard.accepts(request, true, FIRST, SECOND, SECOND));
        assertFalse(guard.accepts(request, false, FIRST, SECOND, SECOND));
        assertFalse(guard.accepts(request, true, FIRST, SECOND,
                "https://example.test/app/chat.html?app_id=card-3&conversation_id=conv-3"));
    }

    @Test public void canonicalHistoryUrlMayNormalizeParameterOrderAndAlias() {
        HomerChatNavigation guard = new HomerChatNavigation();
        long request = guard.begin();
        assertTrue(guard.accepts(request, true, FIRST, SECOND,
                "https://example.test/app/chat.html?conv_id=conv-2&app_id=card-2"));
        assertFalse(guard.accepts(request, true, FIRST, SECOND,
                "https://example.test/app/chat.html?app_id=card-2&conversation_id=conv-other"));
    }

    @Test public void newCardResolutionDoesNotRejectItsNewlyCreatedCloudId() {
        HomerChatNavigation guard = new HomerChatNavigation();
        long request = guard.begin();
        assertTrue(guard.accepts(request, true, FIRST,
                "https://example.test/app/chat.html?app_id=card-2", SECOND));
    }

    @Test public void staleShellReadyAndPageFinishedCannotBelongToTheCurrentDocument() {
        assertFalse(HomerChatNavigation.sameDocument(FIRST, SECOND));
        assertFalse(HomerChatNavigation.sameDocument(FIRST, null));
        assertFalse(HomerChatNavigation.sameDocument("http://[invalid", FIRST));
        assertTrue(HomerChatNavigation.sameDocument(FIRST, FIRST + "#messages"));
        assertFalse(HomerChatNavigation.sameDocument(FIRST,
                FIRST.replace("example.test", "evil.test")));
    }
}
