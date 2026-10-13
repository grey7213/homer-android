package org.nebula.horizon.composeai.ctf;
import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.zip.*;

public class ArchivePackFileTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    byte[] pack(String name) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            zip.putNextEntry(new ZipEntry(name)); zip.write(new byte[]{1, 2, 3}); zip.closeEntry();
        }
        return output.toByteArray();
    }
    String hash(byte[] bytes) throws Exception {
        StringBuilder value = new StringBuilder();
        for (byte part : MessageDigest.getInstance("SHA-256").digest(bytes)) value.append(String.format("%02x", part & 255));
        return value.toString();
    }
    @Test public void safeDataOnlyPaths() {
        assertTrue(ArchivePackFile.safeEntry("media/02_场景背景/office.png"));
        for (String path : new String[]{"../x.png", "/x.png", "a/../x.png", "a\\x.png", "a//x.png", "x.js", "x.html", "x.exe", "C:/x.png"})
            assertFalse(path, ArchivePackFile.safeEntry(path));
    }
    @Test public void verifiedInstallStreamsAndReadsOnlySelectedEntry() throws Exception {
        byte[] bytes = pack("media/test.png"); File destination = new File(folder.getRoot(), "media.hcap");
        ArchivePackFile.install(new ByteArrayInputStream(bytes), destination, bytes.length, hash(bytes), value -> {});
        try (InputStream input = ArchivePackFile.open(destination, "media/test.png")) { assertArrayEquals(new byte[]{1, 2, 3}, input.readAllBytes()); }
        assertFalse(new File(folder.getRoot(), "media").exists());
    }
    @Test public void invalidOrExecutableReplacementDoesNotDamageOldFile() throws Exception {
        File destination = folder.newFile("media.hcap"); byte[] original = {9, 8}; Files.write(destination.toPath(), original);
        for (String name : new String[]{"media/script.js", "../bad.png"}) {
            byte[] bytes = pack(name);
            try { ArchivePackFile.install(new ByteArrayInputStream(bytes), destination, bytes.length, hash(bytes), value -> {}); fail(); }
            catch (IOException expected) { assertArrayEquals(original, Files.readAllBytes(destination.toPath())); }
        }
        byte[] bytes = pack("media/good.png");
        try { ArchivePackFile.install(new ByteArrayInputStream(bytes), destination, bytes.length, "0".repeat(64), value -> {}); fail(); }
        catch (IOException expected) { assertArrayEquals(original, Files.readAllBytes(destination.toPath())); }
        assertFalse(new File(folder.getRoot(), "media.hcap.import.tmp").exists());
    }
}
