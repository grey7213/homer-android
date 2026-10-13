package org.nebula.horizon.composeai.ctf;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ArchiveOrientationPolicyTest {
    private final String base="https://example.test/";
    @Test public void onlyTrustedHallAndBoundGameAreLandscape(){
        assertTrue(ArchiveOrientationPolicy.isGameUrl(base,base+"app/visual-novel.html"));
        assertTrue(ArchiveOrientationPolicy.isGameUrl(base,base+"app/chat.html?app_id=a&conversation_id=c&presentation=archive_vn&vn_game=g-123"));
        for(String path:new String[]{"app/community.html","app/me.html","app/chat.html?app_id=a","app/chat.html?presentation=archive_vn","app/chat.html?presentation=archive_vn&vn_game=","app/chat.html?presentation=archive_vn&vn_game=a&vn_game=b","app/chat.html?presentation=archive_vn&vn_game=bad%2Fid"})assertFalse(path,ArchiveOrientationPolicy.isGameUrl(base,base+path));
        assertFalse(ArchiveOrientationPolicy.isGameUrl(base,"https://evil.test/app/visual-novel.html"));
        assertFalse(ArchiveOrientationPolicy.isGameUrl(base,"https://user@example.test/app/visual-novel.html"));
    }
    @Test public void hallStageTalkAndBackRestoreExactlyOriginalDirection(){
        ArchiveOrientationPolicy policy=new ArchiveOrientationPolicy();
        assertNull(policy.update(false,1,false,6));
        ArchiveOrientationPolicy.Resolution hall=policy.update(true,1,false,6);
        assertEquals(6,hall.orientation);assertTrue(hall.immersive);assertTrue(policy.active());
        for(int i=0;i<4;i++)assertEquals(6,policy.update(true,6,true,6).orientation);
        ArchiveOrientationPolicy.Resolution restore=policy.update(false,6,true,6);
        assertEquals(1,restore.orientation);assertFalse(restore.immersive);assertFalse(policy.active());
        assertNull(policy.update(false,1,false,6));
    }
    @Test public void preexistingLandscapeCardIsNotForcedPortraitOnGameExit(){
        ArchiveOrientationPolicy policy=new ArchiveOrientationPolicy();
        policy.update(true,6,true,6);
        ArchiveOrientationPolicy.Resolution restored=policy.update(false,6,true,6);
        assertEquals(6,restored.orientation);assertTrue(restored.immersive);
    }
}
