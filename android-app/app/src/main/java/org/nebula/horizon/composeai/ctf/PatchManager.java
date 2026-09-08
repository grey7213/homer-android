package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class PatchManager {
    public interface Callback {
        void onInstalled(String version);
        void onNoUpdate();
        void onFailure(String message);
    }

    private static final String PREFS = "homer-patches";
    private static final String ACTIVE_SLOT = "active_slot";
    private static final String PREVIOUS_SLOT = "previous_slot";
    private static final String PENDING_SLOT = "pending_slot";
    private static final String INSTALLED_VERSION = "installed_version";
    private static final String BUNDLED_APP_VERSION = "bundled_app_version";
    private static final int MAX_MANIFEST_BYTES = 1024 * 1024;
    private static final long MAX_PACKAGE_BYTES = 256L * 1024L * 1024L;
    private static final int MAX_FILES = 4096;
    private static final long MAX_SINGLE_FILE_BYTES = 64L * 1024L * 1024L;

    private final Context context;
    private final SharedPreferences preferences;
    private final File patchesRoot;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    public PatchManager(Context context) {
        this.context = context.getApplicationContext();
        this.preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (preferences.getInt(BUNDLED_APP_VERSION, -1) != BuildConfig.VERSION_CODE) {
            // Old web overrides must not hide fixes shipped inside a new APK.
            // Keep account/session databases and cookies entirely separate.
            preferences.edit().remove(ACTIVE_SLOT).remove(PREVIOUS_SLOT).remove(PENDING_SLOT)
                    .remove(INSTALLED_VERSION).putInt(BUNDLED_APP_VERSION, BuildConfig.VERSION_CODE).commit();
        }
        this.patchesRoot = new File(context.getFilesDir(), "patches");
        if (!patchesRoot.exists()) patchesRoot.mkdirs();
    }

    public void recoverInterruptedUpdate() {
        String pending = preferences.getString(PENDING_SLOT, "");
        if (pending == null || pending.isEmpty()) return;
        String previous = preferences.getString(PREVIOUS_SLOT, "");
        String active = preferences.getString(ACTIVE_SLOT, "");
        preferences.edit()
                .putString(ACTIVE_SLOT, PatchSlotState.recoverActiveSlot(active, pending, previous))
                .remove(PENDING_SLOT)
                .apply();
    }

    public String offlineEntryUrl() {
        String slot = preferences.getString(ACTIVE_SLOT, "");
        if (!"slot-a".equals(slot) && !"slot-b".equals(slot)) {
            return "file:///android_asset/offline/index.html";
        }
        File entry = new File(new File(patchesRoot, slot), "offline/index.html");
        if (!entry.isFile()) return "file:///android_asset/offline/index.html";
        return Uri.fromFile(entry).toString();
    }

    /** Returns a verified active-slot override, or null when the bundled asset should be used. */
    public InputStream openActiveAsset(String relativePath) throws IOException {
        String normalized = relativePath == null ? "" : relativePath.replace('\\', '/');
        if (!PatchVerifier.isSafeZipPath(normalized)
                || (!normalized.startsWith("client/") && !normalized.startsWith("offline/"))) {
            return null;
        }
        String slot = preferences.getString(ACTIVE_SLOT, "");
        if (!"slot-a".equals(slot) && !"slot-b".equals(slot)) return null;
        File slotRoot = new File(patchesRoot, slot);
        File candidate = new File(slotRoot, normalized);
        String rootPath = slotRoot.getCanonicalPath() + File.separator;
        if (!candidate.getCanonicalPath().startsWith(rootPath) || !candidate.isFile()) return null;
        return new BufferedInputStream(new FileInputStream(candidate));
    }

    public void markActiveHealthy() {
        if (!preferences.contains(PENDING_SLOT)) return;
        preferences.edit().remove(PENDING_SLOT).remove(PREVIOUS_SLOT).apply();
    }

    public void checkForUpdateAsync(Callback callback) {
        if (BuildConfig.PATCH_PUBLIC_KEY_B64 == null || BuildConfig.PATCH_PUBLIC_KEY_B64.trim().isEmpty()) {
            callback.onNoUpdate();
            return;
        }
        executor.execute(() -> {
            try {
                ManifestData manifest = downloadManifest();
                String installed = preferences.getString(INSTALLED_VERSION, "bundled");
                if (manifest.version.equals(installed) || manifest.minAppVersion != BuildConfig.VERSION_CODE) {
                    callback.onNoUpdate();
                    return;
                }
                install(manifest);
                callback.onInstalled(manifest.version);
            } catch (Exception error) {
                callback.onFailure(error.getClass().getSimpleName());
            }
        });
    }

    private ManifestData downloadManifest() throws Exception {
        URI manifestUri = SafeUrls.resolveSameOrigin(
                BuildConfig.SERVER_BASE_URL,
                "/updates/android/manifest.json"
        );
        byte[] bytes = readHttps(manifestUri.toURL(), MAX_MANIFEST_BYTES);
        JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        ManifestData data = ManifestData.from(json);
        URI packageUri = SafeUrls.resolveSameOrigin(BuildConfig.SERVER_BASE_URL, data.packageUrl);
        data.packageUri = packageUri;
        String canonical = PatchVerifier.canonicalMessage(
                data.version,
                data.minAppVersion,
                packageUri.toString(),
                data.sha256
        );
        if (!PatchVerifier.verifyRsaSha256(
                BuildConfig.PATCH_PUBLIC_KEY_B64,
                canonical,
                data.signature
        )) {
            throw new GeneralSecurityException("Patch manifest signature is invalid");
        }
        return data;
    }

    private void install(ManifestData manifest) throws Exception {
        File download = File.createTempFile("homer-patch-", ".zip", context.getCacheDir());
        try {
            downloadTo(manifest.packageUri.toURL(), download, MAX_PACKAGE_BYTES);
            try (InputStream input = new FileInputStream(download)) {
                String actual = PatchVerifier.sha256(input);
                if (!actual.equalsIgnoreCase(manifest.sha256)) {
                    throw new GeneralSecurityException("Patch package hash mismatch");
                }
            }
            String active = preferences.getString(ACTIVE_SLOT, "");
            String inactive = PatchSlotState.inactiveSlot(active);
            File staging = new File(patchesRoot, inactive + ".staging");
            File target = new File(patchesRoot, inactive);
            deleteTree(staging);
            if (!staging.mkdirs()) throw new IOException("Cannot create patch staging directory");
            extractAndVerify(download, staging, manifest.files);
            deleteTree(target);
            if (!staging.renameTo(target)) throw new IOException("Cannot activate patch slot");
            preferences.edit()
                    .putString(PREVIOUS_SLOT, active == null ? "" : active)
                    .putString(ACTIVE_SLOT, inactive)
                    .putString(PENDING_SLOT, inactive)
                    .putString(INSTALLED_VERSION, manifest.version)
                    .apply();
        } finally {
            if (!download.delete()) {
                // The app cache directory can safely reclaim this temporary file later.
            }
        }
    }

    private void extractAndVerify(File archive, File staging, Map<String, String> expected)
            throws Exception {
        Map<String, String> actual = new HashMap<>();
        int files = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new FileInputStream(archive)))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().replace('\\', '/');
                if (!PatchVerifier.isSafeZipPath(name) || !expected.containsKey(name)) {
                    throw new GeneralSecurityException("Patch contains an unexpected path");
                }
                files += 1;
                if (files > MAX_FILES) throw new IOException("Patch contains too many files");
                File output = new File(staging, name);
                String rootPath = staging.getCanonicalPath() + File.separator;
                if (!output.getCanonicalPath().startsWith(rootPath)) {
                    throw new GeneralSecurityException("Patch path escapes staging directory");
                }
                File parent = output.getParentFile();
                if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                    throw new IOException("Cannot create patch directory");
                }
                long written = 0;
                try (BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(output))) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = zip.read(buffer)) >= 0) {
                        if (read == 0) continue;
                        written += read;
                        if (written > MAX_SINGLE_FILE_BYTES) {
                            throw new IOException("Patch file exceeds size limit");
                        }
                        out.write(buffer, 0, read);
                    }
                }
                try (InputStream input = new FileInputStream(output)) {
                    actual.put(name, PatchVerifier.sha256(input));
                }
            }
        }
        boolean hasOfflineEntry = actual.containsKey("offline/index.html");
        boolean hasClientEntry = actual.containsKey("client/index.txt");
        if (!actual.keySet().equals(expected.keySet()) || (!hasOfflineEntry && !hasClientEntry)) {
            throw new GeneralSecurityException("Patch file list mismatch");
        }
        for (Map.Entry<String, String> entry : expected.entrySet()) {
            if (!entry.getValue().equalsIgnoreCase(actual.get(entry.getKey()))) {
                throw new GeneralSecurityException("Patch file hash mismatch");
            }
        }
    }

    private static byte[] readHttps(URL url, int maxBytes) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16 * 1024];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    total += read;
                    if (total > maxBytes) throw new IOException("Response exceeds size limit");
                    output.write(buffer, 0, read);
                }
                return output.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static void downloadTo(URL url, File target, long maxBytes) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new IOException("HTTP " + status);
            long announced = connection.getContentLengthLong();
            if (announced > maxBytes) throw new IOException("Patch package exceeds size limit");
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 FileOutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[32 * 1024];
                long total = 0;
                int read;
                while ((read = input.read(buffer)) >= 0) {
                    if (read == 0) continue;
                    total += read;
                    if (total > maxBytes) throw new IOException("Patch package exceeds size limit");
                    output.write(buffer, 0, read);
                }
                output.getFD().sync();
            }
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection open(URL url) throws IOException {
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IOException("HTTPS required");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(15_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json, application/zip");
        connection.setRequestProperty("User-Agent", "HomerAndroid/" + BuildConfig.VERSION_NAME);
        return connection;
    }

    private void deleteTree(File target) throws IOException {
        if (!target.exists()) return;
        String root = patchesRoot.getCanonicalPath() + File.separator;
        String candidate = target.getCanonicalPath();
        if (!candidate.startsWith(root)) throw new IOException("Refusing to remove a path outside patches");
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        if (!target.delete()) throw new IOException("Cannot remove stale patch path");
    }

    private static final class ManifestData {
        String version;
        int minAppVersion;
        String packageUrl;
        String sha256;
        String signature;
        Map<String, String> files;
        URI packageUri;

        static ManifestData from(JSONObject json) throws Exception {
            ManifestData data = new ManifestData();
            data.version = json.getString("version").trim();
            data.minAppVersion = json.getInt("min_app_version");
            data.packageUrl = json.getString("package_url").trim();
            data.sha256 = json.getString("sha256").trim().toLowerCase(Locale.ROOT);
            data.signature = json.getString("signature").trim();
            if (data.version.isEmpty() || !data.sha256.matches("[0-9a-f]{64}")) {
                throw new GeneralSecurityException("Invalid patch manifest fields");
            }
            JSONObject fileObject = json.getJSONObject("files");
            if (fileObject.length() == 0 || fileObject.length() > MAX_FILES) {
                throw new GeneralSecurityException("Invalid patch file list");
            }
            data.files = new HashMap<>();
            Iterator<String> keys = fileObject.keys();
            while (keys.hasNext()) {
                String path = keys.next();
                String hash = fileObject.getString(path).toLowerCase(Locale.ROOT);
                if (!PatchVerifier.isSafeZipPath(path) || !hash.matches("[0-9a-f]{64}")) {
                    throw new GeneralSecurityException("Invalid patch file entry");
                }
                data.files.put(path.replace('\\', '/'), hash);
            }
            return data;
        }
    }
}
