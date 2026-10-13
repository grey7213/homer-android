package org.nebula.horizon.composeai.ctf;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.function.LongConsumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Immutable data-only pack. No extraction, scripts, player saves or network. */
final class ArchivePackFile {
    static boolean safeEntry(String name) {
        if (name == null || name.isEmpty() || name.startsWith("/") || name.contains("\\")
                || name.indexOf('\0') >= 0 || name.contains(":")) return false;
        for (String part : name.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return name.matches("(?s).+\\.(png|jpg|webp|ogg|wav|atlas|skel|txt)");
    }

    static void install(InputStream source, File target, long expectedBytes, String sha256,
                        LongConsumer progress) throws IOException {
        if (expectedBytes < 1 || expectedBytes > 2L * 1024 * 1024 * 1024
                || !sha256.matches("[a-f0-9]{64}")) throw new IOException("PACK_CONTRACT");
        File temporary = new File(target.getParentFile(), target.getName() + ".import.tmp");
        if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("PACK_STORAGE");
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IOException("PACK_DIGEST", error); }
        try {
            long count = 0;
            try (InputStream input = source; FileOutputStream output = new FileOutputStream(temporary)) {
                byte[] buffer = new byte[128 * 1024]; int read;
                while ((read = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException("PACK_CANCELLED");
                    count += read;
                    if (count > expectedBytes) throw new IOException("PACK_SIZE");
                    digest.update(buffer, 0, read); output.write(buffer, 0, read); progress.accept(count);
                }
                output.getFD().sync();
            }
            StringBuilder hash = new StringBuilder();
            for (byte value : digest.digest()) hash.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            if (count != expectedBytes || !sha256.contentEquals(hash)) throw new IOException("PACK_HASH");
            try (ZipFile zip = new ZipFile(temporary)) {
                if (zip.size() < 1) throw new IOException("PACK_EMPTY");
                java.util.Enumeration<? extends ZipEntry> entries = zip.entries();
                while (entries.hasMoreElements()) {
                    ZipEntry entry = entries.nextElement();
                    if (!safeEntry(entry.getName()) || entry.getSize() < 0 || entry.getSize() > 16 * 1024 * 1024)
                        throw new IOException("PACK_ENTRY");
                }
            }
            // Interrupted/invalid imports never truncate the installed copy.
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary.toPath());
        }
    }

    static InputStream open(File pack, String name) throws IOException {
        if (!safeEntry(name)) throw new IOException("PACK_PATH");
        ZipFile zip = new ZipFile(pack);
        ZipEntry entry = zip.getEntry(name);
        if (entry == null) { zip.close(); throw new FileNotFoundException("PACK_MISSING"); }
        InputStream stream = zip.getInputStream(entry);
        return new FilterInputStream(stream) {
            @Override public void close() throws IOException { try { super.close(); } finally { zip.close(); } }
        };
    }
}
