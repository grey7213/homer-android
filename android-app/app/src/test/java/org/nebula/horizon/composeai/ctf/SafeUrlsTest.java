package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class SafeUrlsTest {
    private static final String BASE = "https://example.test/";
    private static final String LOOPBACK = "http://127.0.0.1:8080/";
    private static final String PRIVATE_LAN = "http://172.24.5.154:8080/";

    @Test
    public void acceptsSameOriginHttpsNavigation() {
        assertTrue(SafeUrls.isTrustedNavigation(BASE, "https://example.test/app/chat.html?id=1"));
        assertTrue(SafeUrls.isTrustedNavigation(BASE, "/module/dialogue/"));
    }

    @Test
    public void rejectsCredentialsPortsAndOtherOrigins() {
        assertFalse(SafeUrls.isTrustedNavigation(BASE, "http://example.test/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(BASE, "https://example.test:444/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(BASE, "https://example.test.evil.invalid/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(BASE, "https://user@example.test/app/"));
    }

    @Test
    public void allowsSameOriginLoopbackForDebugBuildsOnly() {
        assertTrue(SafeUrls.isTrustedNavigation(LOOPBACK, "/app/chat.html"));
        assertFalse(SafeUrls.isTrustedNavigation(LOOPBACK, "http://localhost:8080/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(LOOPBACK, "http://127.0.0.1:8081/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(LOOPBACK, "https://127.0.0.1:8080/app/"));
    }

    @Test
    public void allowsSameOriginPrivateLanForDebugBuilds() {
        assertTrue(SafeUrls.isTrustedNavigation(PRIVATE_LAN, "/app/chat.html"));
        assertFalse(SafeUrls.isTrustedNavigation(PRIVATE_LAN, "http://172.25.5.154:8080/app/"));
        assertFalse(SafeUrls.isTrustedNavigation(PRIVATE_LAN, "http://8.8.8.8:8080/app/"));
    }

    @Test
    public void requiresCanonicalHttpsBase() {
        assertThrows(IllegalArgumentException.class, () -> SafeUrls.requireHttpsBase("http://example.test/"));
        assertThrows(IllegalArgumentException.class, () -> SafeUrls.requireHttpsBase("https://example.test"));
    }
}
