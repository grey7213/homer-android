package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Read-only private media, lazily initialized only on an archive screen. */
final class ArchiveMediaStore {
    private static final String PREFIX = "/media-cache/card-assets/ready/archive-local-1111/";
    private final Context context;
    private JSONObject manifest;
    private File pack;
    private File directory;
    private final Map<String, JSONObject> packs = new LinkedHashMap<>();
    private Thread importer;
    private volatile long copied;
    private volatile long importingSize;
    private volatile String state = "missing";
    private volatile String requestedPack = "";
    private volatile long attempt;
    private volatile boolean closed;

    ArchiveMediaStore(Context context) { this.context = context.getApplicationContext(); }

    private synchronized void contract() throws Exception {
        if (manifest != null) return;
        try (InputStream input = context.getAssets().open("client/web/app/assets/data/chatarchive-pack.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int read;
            while ((read = input.read(buffer)) != -1) {
                if (bytes.size() + read > 2 * 1024 * 1024) throw new IOException("PACK_CONTRACT");
                bytes.write(buffer, 0, read);
            }
            JSONObject candidate = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            String hash = candidate.getString("sha256");
            if (!hash.matches("[a-f0-9]{64}")) throw new IOException("PACK_CONTRACT");
            File candidatePack = new File(new File(context.getFilesDir(), "archive-media"), hash + ".hcap");
            directory = candidatePack.getParentFile();
            org.json.JSONArray alternatives = candidate.optJSONArray("packs");
            if (alternatives == null) throw new IOException("PACK_CONTRACT");
            for (int i = 0; i < alternatives.length(); i++) {
                JSONObject row = alternatives.getJSONObject(i);
                if (!row.getString("sha256").matches("[a-f0-9]{64}")) throw new IOException("PACK_CONTRACT");
                packs.put(row.getString("id"), row);
            }
            manifest = candidate; pack = candidatePack;
            state = ready() ? "ready" : "missing";
        }
    }
    private boolean installed(JSONObject row) { File file = new File(directory, row.optString("sha256") + ".hcap"); return file.isFile() && file.length() == row.optLong("bytes", -1); }
    private boolean ready() { for (JSONObject row : packs.values()) if (installed(row)) return true; return false; }

    synchronized String status() {
        try { contract(); org.json.JSONArray ids = new org.json.JSONArray(); for (Map.Entry<String, JSONObject> row : packs.entrySet()) if (installed(row.getValue())) ids.put(row.getKey());
            return new JSONObject().put("state", state).put("ready", ready()).put("packs", ids)
                .put("requestedPack", requestedPack).put("attempt", attempt).put("automatic", !BuildConfig.ARCHIVE_MEDIA_BASE_URL.isEmpty())
                .put("copied", copied).put("bytes", importingSize).put("sourceVersion", "1.1.11").toString(); }
        catch (Exception error) { return "{\"state\":\"unavailable\",\"ready\":false}"; }
    }

    synchronized boolean prepare(String id) {
        if (closed || id == null || !id.matches("[a-z0-9_]{1,64}") || id.equals("full")) return false;
        try {
            contract(); JSONObject row = packs.get(id);
            if (row == null) return false;
            if (installed(row)) { state = "ready"; requestedPack = id; return true; }
            if (importer != null && importer.isAlive()) return false;
            requestedPack = id; ++attempt;
            long expected = row.getLong("bytes");
            if (context.getFilesDir().getUsableSpace() < expected + 32L * 1024 * 1024) { state = "no_space"; return false; }
            requestedPack = id; state = "preparing"; copied = 0; importingSize = expected;
            importer = new Thread(() -> {
                try {
                    String hash = row.getString("sha256");
                    InputStream starter = null;
                    if (id.equals("yuuka")) {
                        try { starter = context.getAssets().open("archive/starter.hcap"); } catch (IOException absent) { /* Optional starter. */ }
                    }
                    if (starter != null) ArchiveKnownPack.install(starter, directory, Collections.singletonMap(hash, expected), value -> copied = value);
                    else {
                        if (BuildConfig.ARCHIVE_MEDIA_BASE_URL.isEmpty()) throw new IOException("PACK_SOURCE_UNCONFIGURED");
                        ArchivePackDownload.fetch(BuildConfig.ARCHIVE_MEDIA_BASE_URL, hash, expected, BuildConfig.DEBUG, directory, value -> copied = value);
                    }
                    state = "ready";
                } catch (Exception error) { state = closed ? "cancelled" : "download_failed"; }
            }, "archive-media-prepare");
            importer.start(); return true;
        } catch (Exception error) { state = "unavailable"; return false; }
    }

    synchronized boolean install(Uri uri) {
        if (closed || (importer != null && importer.isAlive())) return false;
        try {
            contract(); long size = 0;
            try (android.database.Cursor cursor = context.getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) size = cursor.getLong(0);
            }
            if (size <= 0) size = 32L * 1024 * 1024; // unknown SAF size: enforce the hard contract while streaming
            if (context.getFilesDir().getUsableSpace() < size + 32L * 1024 * 1024) { state = "no_space"; return false; }
            state = "importing"; copied = 0; importingSize = size;
            importer = new Thread(() -> {
                try {
                    InputStream input = context.getContentResolver().openInputStream(uri);
                    if (input == null) throw new IOException("PACK_INPUT");
                    Map<String, Long> contracts = new HashMap<>(); for (JSONObject row : packs.values()) contracts.put(row.getString("sha256"), row.getLong("bytes"));
                    ArchiveKnownPack.install(input, directory, contracts, value -> copied = value);
                    state = "ready";
                } catch (Exception error) { state = closed ? "cancelled" : "invalid"; }
            }, "archive-media-import");
            importer.start(); return true;
        } catch (Exception error) { state = "unavailable"; return false; }
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        if (request == null || !"GET".equalsIgnoreCase(request.getMethod())) return null;
        Uri uri = request.getUrl();
        if (uri == null || !SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL, uri.toString())) return null;
        String path = uri.getPath();
        if (path == null || !path.startsWith(PREFIX)) return null;
        String name = path.substring(PREFIX.length());
        try {
            contract();
            if (!ready() || !ArchivePackFile.safeEntry(name) || !manifest.getJSONObject("entries").has(name)) throw new IOException("PACK_MISSING");
            File source = null;
            for (JSONObject row : packs.values()) {
                if (!installed(row)) continue;
                org.json.JSONArray entries = row.getJSONArray("entries");
                for (int i = 0; i < entries.length(); i++) if (name.equals(entries.getString(i))) { source = new File(directory, row.getString("sha256") + ".hcap"); break; }
                if (source != null) break;
            }
            if (source == null) throw new IOException("PACK_MISSING");
            return new WebResourceResponse(ClientAssetStore.mimeType(name), null, 200, "OK",
                    Collections.singletonMap("Cache-Control", "private, no-cache"), ArchivePackFile.open(source, name));
        } catch (Exception error) {
            // A missing local pack must NEVER fall through to the real server.
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.singletonMap("Cache-Control", "no-store"),
                    new ByteArrayInputStream("Local media unavailable".getBytes(StandardCharsets.UTF_8)));
        }
    }
    synchronized void close() { closed = true; if (importer != null) importer.interrupt(); }
}
