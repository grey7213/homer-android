package org.nebula.horizon.composeai.ctf;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class TrustedFrameBlobNavigationTest {
    private static final String BASE = "https://example.test/";
    private static final String PAGE = "https://example.test/app/chat.html";
    private static final String ID = "3c6d4ab9-cce1-47bb-a1b2-23d051cf2e48";
    private static final String BLOB = "blob:https://example.test/" + ID;

    @Test public void permitsOnlyTrustedRendererBlobInsideLiveFrame() {
        assertTrue(SafeUrls.isTrustedFrameBlobNavigation(BASE, BLOB, false, PAGE));
        assertTrue(SafeUrls.isTrustedFrameBlobNavigation(BASE,
                "blob:https://EXAMPLE.test:443/" + ID, false, PAGE));
        assertFalse(SafeUrls.isTrustedNavigation(BASE, BLOB));
    }

    @Test public void neverPermitsMainFrameOrPopupDocumentBlob() {
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(BASE, BLOB, true, PAGE));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(BASE, BLOB, false,
                "https://outside.test/"));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(BASE, BLOB, false, null));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(BASE, BLOB, false, "about:blank"));
    }

    @Test public void rejectsOtherOriginsAndOpaqueOrNestedBlobSources() {
        for (String value : new String[]{
                "blob:https://outside.test/" + ID,
                "blob:https://example.test.evil.test/" + ID,
                "blob:http://example.test/" + ID,
                "blob:https://example.test:444/" + ID,
                "blob:https://user@example.test/" + ID,
                "blob:null/" + ID,
                "blob:blob:https://example.test/" + ID,
                "blob:/" + ID,
                "blob:file:///" + ID,
                "blob:javascript:alert(1)"
        }) assertFalse(value, SafeUrls.isTrustedFrameBlobNavigation(BASE, value, false, PAGE));
    }

    @Test public void rejectsArbitrarySchemesAndNonObjectUrlShapes() {
        for (String value : new String[]{
                "file:///android_asset/offline/index.html",
                "javascript:alert(1)", "data:text/html,test", "about:blank", "intent://test",
                "https://example.test/app/chat.html",
                "blob:https://example.test/" + ID + "/extra",
                "blob:https://example.test/" + ID + "?x=1",
                "blob:https://example.test/" + ID + "#x",
                "blob:https://example.test/%2f" + ID,
                "blob:https://example.test/not-an-object-url",
                "blob:https://example.test/../" + ID,
                "blob:https://[invalid/" + ID
        }) assertFalse(value, SafeUrls.isTrustedFrameBlobNavigation(BASE, value, false, PAGE));
    }

    @Test public void preservesConfiguredDebugOriginAndPortIsolation() {
        String base = "http://127.0.0.1:8191/";
        String page = base + "app/chat.html";
        assertTrue(SafeUrls.isTrustedFrameBlobNavigation(base,
                "blob:" + base + ID, false, page));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(base,
                "blob:http://localhost:8191/" + ID, false, page));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(base,
                "blob:http://127.0.0.1:8192/" + ID, false, page));
        assertFalse(SafeUrls.isTrustedFrameBlobNavigation(base,
                "blob:https://127.0.0.1:8191/" + ID, false, page));
    }
}
