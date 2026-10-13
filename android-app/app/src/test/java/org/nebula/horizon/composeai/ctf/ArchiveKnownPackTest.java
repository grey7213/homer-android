package org.nebula.horizon.composeai.ctf;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.*;

public class ArchiveKnownPackTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    String hash(byte[] value) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte part : MessageDigest.getInstance("SHA-256").digest(value)) hex.append(String.format("%02x", part & 255));
        return hex.toString();
    }
    @Test public void userFileIsIdentifiedByDigestAndSizeRatherThanName() throws Exception {
        byte[] first = {1,2,3}, second = {4,5,6,7};
        Map<String, Long> expected = Map.of(hash(first), 3L, hash(second), 4L);
        File a = ArchiveKnownPack.install(new ByteArrayInputStream(first), folder.getRoot(), expected, value -> {});
        File b = ArchiveKnownPack.install(new ByteArrayInputStream(second), folder.getRoot(), expected, value -> {});
        assertTrue(a.exists()); assertTrue(b.exists()); assertNotEquals(a, b);
        assertArrayEquals(first, Files.readAllBytes(a.toPath()));
    }
    @Test public void unknownAndInterruptedImportsKeepExistingPacks() throws Exception {
        byte[] first = {1,2,3}; Map<String, Long> expected = Map.of(hash(first), 3L);
        File prior = ArchiveKnownPack.install(new ByteArrayInputStream(first), folder.getRoot(), expected, value -> {});
        try { ArchiveKnownPack.install(new ByteArrayInputStream(new byte[]{7,8,9}), folder.getRoot(), expected, value -> {}); fail(); }
        catch (IOException correct) { assertArrayEquals(first, Files.readAllBytes(prior.toPath())); }
        Thread.currentThread().interrupt();
        try { ArchiveKnownPack.install(new ByteArrayInputStream(first), folder.getRoot(), expected, value -> {}); fail(); }
        catch (IOException correct) { assertTrue(prior.exists()); }
        finally { Thread.interrupted(); }
        assertFalse(new File(folder.getRoot(), "incoming.import.tmp").exists());
    }
}
