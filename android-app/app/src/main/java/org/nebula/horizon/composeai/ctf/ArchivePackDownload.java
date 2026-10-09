package org.nebula.horizon.composeai.ctf;

import java.io.*;
import java.net.*;
import java.util.*;
import java.util.function.LongConsumer;

/** Pinned data-only downloads; no cookies, caller URLs, redirects or retries. */
final class ArchivePackDownload {
    static URI source(String base, String digest, boolean debug) throws IOException {
        try {
            URI uri = URI.create(base);
            if (!digest.matches("[a-f0-9]{64}") || uri.getUserInfo() != null || uri.getQuery() != null
                    || uri.getFragment() != null || uri.getHost() == null || !base.endsWith("/")) throw new IOException("PACK_SOURCE");
            String host = uri.getHost();
            boolean local = host.equals("localhost");
            if (host.matches("[0-9]+(?:\\.[0-9]+){3}")) {
                String[] octets = host.split("\\."); int[] values = new int[4]; boolean valid = true;
                for (int i = 0; i < 4; i++) { values[i] = Integer.parseInt(octets[i]); if(values[i]>255)valid=false; }
                local = valid && (values[0]==127 || values[0]==10 || (values[0]==192&&values[1]==168)
                        || (values[0]==172&&values[1]>=16&&values[1]<=31));
            }
            if (!"https".equals(uri.getScheme()) && !(debug && local && "http".equals(uri.getScheme()))) throw new IOException("PACK_SOURCE");
            return uri.resolve(digest + ".hcap");
        } catch (IllegalArgumentException error) { throw new IOException("PACK_SOURCE", error); }
    }

    static File fetch(String base, String hash, long expected, boolean debug, File directory, LongConsumer progress) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) source(base, hash, debug).toURL().openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/octet-stream");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("PACK_HTTP");
            long length = connection.getContentLengthLong();
            if (length >= 0 && length != expected) throw new IOException("PACK_SIZE");
            return ArchiveKnownPack.install(connection.getInputStream(), directory, Collections.singletonMap(hash, expected), progress);
        } finally { connection.disconnect(); }
    }
}
