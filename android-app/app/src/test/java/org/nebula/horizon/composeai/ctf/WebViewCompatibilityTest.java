package org.nebula.horizon.composeai.ctf;

import org.junit.Test;
import static org.junit.Assert.*;

public class WebViewCompatibilityTest {
    @Test public void testsEngineRatherThanAndroidVersion() {
        assertTrue(WebViewCompatibility.needsUpdate("Mozilla/5.0 (Linux; Android 8.1; wv) Chrome/61.0.0.0"));
        assertFalse(WebViewCompatibility.needsUpdate("Mozilla/5.0 (Linux; Android 8.1; wv) Chrome/138.0.0.0"));
        assertFalse(WebViewCompatibility.needsUpdate("Chrome/89.0.4389.0"));
        assertTrue(WebViewCompatibility.needsUpdate("Chrome/88.0.0.0"));
    }
    @Test public void unknownVendorIsNotRejectedByBrand() {
        assertFalse(WebViewCompatibility.needsUpdate(null));
        assertEquals(0, WebViewCompatibility.chromiumMajor("Vendor/999"));
        assertFalse(WebViewCompatibility.needsUpdate("Chrome/999999999999999999.0"));
    }
}
