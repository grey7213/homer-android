package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

/** Downloads stay in private cache; only a verified complete file reaches the installer. */
final class ApkUpdateManager implements AutoCloseable {
    interface Result<T> {
        void success(T value);
        void failure(Exception error);
    }
    interface Progress { void changed(long received, long total); }
    static final class Cancelled extends InterruptedIOException {
        Cancelled() { super("Cancelled"); }
    }
    private static final int MAX_FEED_BYTES = 1024 * 1024;
    private final Context context;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicReference<Job> active = new AtomicReference<>();

    private static final class Job {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        void requireActive() throws InterruptedIOException {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new Cancelled();
        }
    }
    private interface Work<T> { T run(Job job) throws Exception; }

    ApkUpdateManager(Context context) { this.context = context.getApplicationContext(); }

    void check(Result<ApkRelease> callback) {
        execute(job -> {
            URI source = SafeUrls.resolveSameOrigin(BuildConfig.SERVER_BASE_URL, "/download/release.json");
            if (!BuildConfig.DEBUG) SafeUrls.requireHttpsBase(BuildConfig.SERVER_BASE_URL);
            HttpURLConnection connection = open(source, job);
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    job.requireActive();
                    if (output.size() + count > MAX_FEED_BYTES) throw new IOException("Release feed too large");
                    output.write(buffer, 0, count);
                }
                ApkRelease release = ApkRelease.parse(output.toString(StandardCharsets.UTF_8.name()),
                        BuildConfig.SERVER_BASE_URL, context.getPackageName(), BuildConfig.DEBUG);
                PackageInfo installed = installedPackage();
                if (release.versionCode <= version(installed)) return null;
                if (release.minSdk > Build.VERSION.SDK_INT) throw new IOException("ANDROID_VERSION_UNSUPPORTED");
                if (!certificates(installed).contains(release.certificate)) throw new IOException("Certificate mismatch");
                return release;
            } finally { connection.disconnect(); }
        }, callback);
    }

    void download(ApkRelease release, Progress progress, Result<File> callback) {
        execute(job -> {
            File directory = new File(context.getCacheDir(), "apk-updates");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create update cache");
            if (directory.getUsableSpace() < release.bytes * 2 + 16L * 1024 * 1024) {
                throw new IOException("INSUFFICIENT_SPACE");
            }
            File target = apkFile(release);
            if (target.isFile()) {
                try { verify(target, release, job); return target; }
                catch (Cancelled error) { throw error; }
                catch (Exception error) { if (!target.delete()) throw new IOException("Cannot remove invalid APK"); }
            }
            File partial = new File(directory, "download.part");
            HttpURLConnection connection = null;
            try {
                connection = open(release.url, job);
                long declaredSize = connection.getContentLengthLong();
                if (declaredSize >= 0 && declaredSize != release.bytes) throw new IOException("APK size mismatch");
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    byte[] buffer = new byte[64 * 1024];
                    long received = 0, reportedAt = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        job.requireActive();
                        received += count;
                        if (received > release.bytes) throw new IOException("APK exceeds declared size");
                        output.write(buffer, 0, count);
                        long now = android.os.SystemClock.elapsedRealtime();
                        if (now - reportedAt >= 150 || received == release.bytes) {
                            progress.changed(received, release.bytes);
                            reportedAt = now;
                        }
                    }
                    output.getFD().sync();
                }
                verify(partial, release, job);
                job.requireActive();
                if (!partial.renameTo(target)) throw new IOException("Cannot save verified APK");
                return target;
            } finally {
                if (connection != null) connection.disconnect();
                if (partial.exists()) partial.delete();
            }
        }, callback);
    }

    void verifyForInstall(ApkRelease release, Result<File> callback) {
        execute(job -> { File file = apkFile(release); verify(file, release, job); return file; }, callback);
    }

    File apkFile(ApkRelease release) {
        return new File(new File(context.getCacheDir(), "apk-updates"), "homer-" + release.versionCode + ".apk");
    }

    private <T> void execute(Work<T> work, Result<T> callback) {
        Job job = new Job();
        if (!active.compareAndSet(null, job)) { callback.failure(new IOException("UPDATE_BUSY")); return; }
        executor.execute(() -> {
            T value;
            try {
                value = work.run(job);
                job.requireActive();
            } catch (Exception error) {
                active.compareAndSet(job, null);
                callback.failure(job.cancelled ? new Cancelled() : error);
                return;
            }
            active.compareAndSet(job, null);
            callback.success(value);
        });
    }

    private HttpURLConnection open(URI uri, Job job) throws IOException {
        job.requireActive();
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        job.connection = connection;
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(20000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Cache-Control", "no-cache");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", "HomerAndroid/" + BuildConfig.VERSION_NAME);
        try {
            job.requireActive();
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new IOException("Update service unavailable");
            }
            return connection;
        } catch (IOException error) { connection.disconnect(); throw error; }
    }

    private void verify(File file, ApkRelease release, Job job) throws Exception {
        if (!file.isFile() || file.length() != release.bytes) throw new IOException("APK size mismatch");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) { job.requireActive(); hash.update(buffer, 0, count); }
        }
        if (!hex(hash.digest()).equals(release.sha256)) throw new IOException("APK hash mismatch");
        PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), signingFlags());
        PackageInfo installed = installedPackage();
        if (archive == null || !context.getPackageName().equals(archive.packageName)
                || !release.packageName.equals(archive.packageName)
                || version(archive) != release.versionCode || version(archive) <= version(installed)
                || !release.versionName.equals(archive.versionName)
                || archive.applicationInfo == null || archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT
                || (!BuildConfig.DEBUG && (archive.applicationInfo.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)) {
            throw new IOException("APK identity or version mismatch");
        }
        Set<String> expected = certificates(installed), actual = certificates(archive);
        if (expected.isEmpty() || !expected.equals(actual) || !actual.contains(release.certificate)) {
            throw new IOException("APK signing certificate mismatch");
        }
    }

    private PackageInfo installedPackage() throws PackageManager.NameNotFoundException {
        return context.getPackageManager().getPackageInfo(context.getPackageName(), signingFlags());
    }
    @SuppressWarnings("deprecation")
    private static int signingFlags() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }
    @SuppressWarnings("deprecation")
    static long version(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    @SuppressWarnings("deprecation")
    private static Set<String> certificates(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
                ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        Set<String> result = new HashSet<>();
        if (signatures != null) for (Signature signature : signatures) {
            result.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        }
        return result;
    }
    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte item : bytes) value.append(String.format(Locale.ROOT, "%02x", item & 255));
        return value.toString();
    }
    void cancel() {
        Job job = active.get();
        if (job != null) {
            job.cancelled = true;
            if (job.connection != null) job.connection.disconnect();
        }
    }
    @Override public void close() { cancel(); executor.shutdownNow(); }
}
