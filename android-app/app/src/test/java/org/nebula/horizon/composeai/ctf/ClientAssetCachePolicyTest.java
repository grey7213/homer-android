package org.nebula.horizon.composeai.ctf;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class ClientAssetCachePolicyTest {
    @Test public void mutableCodeAndSettingsMustRevalidateAgainstBundledAssets() {
        for (String mime : new String[]{"text/html", "text/javascript", "text/css", "application/json"}) {
            assertEquals("no-cache", ClientAssetStore.cacheControl(mime));
        }
    }
    @Test public void binaryImagesRemainCached() {
        assertEquals("public, max-age=31536000, immutable", ClientAssetStore.cacheControl("image/png"));
    }
}
