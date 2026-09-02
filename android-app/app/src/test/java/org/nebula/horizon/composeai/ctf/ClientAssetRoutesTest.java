package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public final class ClientAssetRoutesTest {
    @Test
    public void mapsProductPagesToBundledWebAssets() {
        assertEquals("client/web/index.html", ClientAssetRoutes.assetPath("/"));
        assertEquals("client/web/app/index.html", ClientAssetRoutes.assetPath("/app/"));
        assertEquals("client/web/app/chat.html", ClientAssetRoutes.assetPath("/app/chat.html"));
        assertEquals("client/web/dashboard.html", ClientAssetRoutes.assetPath("/dashboard.html"));
        assertEquals("client/web/admin.html", ClientAssetRoutes.assetPath("/admin.html"));
        assertEquals("client/web/assets/img/logo-64.png", ClientAssetRoutes.assetPath("/assets/img/logo-64.png"));
    }

    @Test
    public void mapsDialogueStaticNamespaceWithoutTreatingOtherRoutesAsAssets() {
        assertEquals("client/runtime/index.html", ClientAssetRoutes.assetPath("/module/dialogue/"));
        assertEquals("client/runtime/scripts/script.js", ClientAssetRoutes.assetPath("/module/dialogue/scripts/script.js"));
        assertEquals("client/runtime/lib.js", ClientAssetRoutes.assetPath("/lib.js"));
        assertEquals(
                "client/runtime/scripts/extensions/homer-bridge/index.js",
                ClientAssetRoutes.assetPath("/scripts/extensions/homer-bridge/index.js")
        );
        assertEquals(
                "client/runtime/scripts/extensions/third-party/SillyTavern-MemoryBooks/index.build.js",
                ClientAssetRoutes.assetPath(
                        "/scripts/extensions/third-party/dialogue-memory-books/index.build.js"
                )
        );
        assertNull(ClientAssetRoutes.assetPath("/api/settings/get"));
        assertNull(ClientAssetRoutes.assetPath("/console/api/web/conversations"));
        assertNull(ClientAssetRoutes.assetPath("/module/other/file.js"));
    }

    @Test
    public void rejectsUnsafePaths() {
        assertNull(ClientAssetRoutes.assetPath("app/chat.html"));
        assertNull(ClientAssetRoutes.assetPath("/app/../secret"));
        assertNull(ClientAssetRoutes.assetPath(null));
    }
}
