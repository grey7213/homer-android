package org.nebula.horizon.composeai.ctf;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.function.LongConsumer;

/** A user-selected file identifies itself by a pinned whole-file digest, never its name. */
final class ArchiveKnownPack {
    static synchronized File install(InputStream source, File directory, Map<String, Long> contracts, LongConsumer progress) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) { source.close(); throw new IOException("PACK_STORAGE"); }
        File incoming = new File(directory, "incoming.import.tmp");
        long maximum = 0;
        for (Map.Entry<String, Long> contract : contracts.entrySet()) {
            if (!contract.getKey().matches("[a-f0-9]{64}") || contract.getValue() < 1 || contract.getValue() > 2L * 1024 * 1024 * 1024) {
                source.close(); throw new IOException("PACK_CONTRACT");
            }
            maximum = Math.max(maximum, contract.getValue());
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0;
            try (InputStream input = source; FileOutputStream output = new FileOutputStream(incoming)) {
                byte[] buffer = new byte[128 * 1024]; int read;
                while ((read = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("PACK_CANCELLED");
                    count += read; if (count > maximum) throw new IOException("PACK_SIZE");
                    digest.update(buffer, 0, read); output.write(buffer, 0, read); progress.accept(count);
                }
                output.getFD().sync();
            }
            StringBuilder value = new StringBuilder();
            for (byte part : digest.digest()) value.append(String.format(Locale.ROOT, "%02x", part & 255));
            String hash = value.toString(); Long expected = contracts.get(hash);
            if (expected == null || expected != count) throw new IOException("PACK_HASH");
            if (Thread.currentThread().isInterrupted()) throw new IOException("PACK_CANCELLED");
            File installed = new File(directory, hash + ".hcap");
            Files.move(incoming.toPath(), installed.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return installed;
        } catch (NoSuchAlgorithmException error) { throw new IOException("PACK_DIGEST", error); }
        finally { Files.deleteIfExists(incoming.toPath()); }
    }
}
