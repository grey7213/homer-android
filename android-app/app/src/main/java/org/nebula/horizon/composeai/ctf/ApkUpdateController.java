package org.nebula.horizon.composeai.ctf;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.util.Locale;

/** Activity-scoped UI; the OS always asks the user to approve an installation. */
@SuppressWarnings("deprecation")
final class ApkUpdateController implements AutoCloseable {
    private static final long CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000;
    private static final String PENDING = "pending_permission_release";
    private final Activity activity;
    private final ApkUpdateManager manager;
    private final SharedPreferences preferences;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlertDialog dialog;
    private ProgressDialog progress;
    private boolean busy, foreground, closed, awaitingPermission, operationCancelled;
    private ApkRelease pendingRelease;
    private Runnable pendingUi;

    ApkUpdateController(Activity activity) {
        this.activity = activity;
        manager = new ApkUpdateManager(activity);
        preferences = activity.getSharedPreferences("homer-apk-update", Context.MODE_PRIVATE);
        String saved = preferences.getString(PENDING, "");
        if (saved != null && !saved.isEmpty()) {
            try {
                long age = System.currentTimeMillis() - preferences.getLong("permission_at", 0);
                if (age < 0 || age > 24L * 60 * 60 * 1000) throw new IllegalStateException("Expired");
                pendingRelease = ApkRelease.restore(saved, BuildConfig.SERVER_BASE_URL,
                        activity.getPackageName(), BuildConfig.DEBUG);
                awaitingPermission = manager.apkFile(pendingRelease).isFile();
            } catch (Exception ignored) { clearPendingPermission(); }
        }
    }

    void onResume() {
        foreground = true;
        if (awaitingPermission && pendingRelease != null) {
            awaitingPermission = false;
            clearPendingPermission();
            ApkRelease release = pendingRelease;
            if (activity.getPackageManager().canRequestPackageInstalls()) verifyAndInstall(release);
            else permissionDeclined(release);
            return;
        }
        if (pendingUi != null) {
            Runnable action = pendingUi;
            pendingUi = null;
            action.run();
        } else {
            // Own Handler: web page completion clears the Activity's polling Handler.
            handler.postDelayed(() -> { if (foreground && !closed) check(false); }, 1500);
        }
    }

    void onPause() { foreground = false; }

    void check(boolean manual) {
        if (closed || busy || (dialog != null && dialog.isShowing())) return;
        if (!foreground) { if (manual) pendingUi = () -> check(true); return; }
        long now = System.currentTimeMillis();
        long elapsed = now - preferences.getLong("last_check", 0);
        if (!manual && elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) return;
        preferences.edit().putLong("last_check", now).apply();
        busy = true;
        operationCancelled = false;
        if (manual) showProgress("检查更新", "正在获取最新版本…", false);
        manager.check(new ApkUpdateManager.Result<>() {
            @Override public void success(ApkRelease release) {
                handler.post(() -> {
                    if (closed) return;
                    busy = false;
                    dismissProgress();
                    if (operationCancelled) return;
                    if (release != null) present(() -> offer(release));
                    else if (manual) present(() -> info("已是最新版本", "当前版本 " + BuildConfig.VERSION_NAME));
                });
            }
            @Override public void failure(Exception error) { failed(error, manual, () -> check(true)); }
        });
    }

    private void offer(ApkRelease release) {
        String message = "当前版本 " + BuildConfig.VERSION_NAME + "\n新版本 " + release.versionName
                + " · " + megabytes(release.bytes) + " MB\n\n" + release.notes
                + "\n\n覆盖安装会保留账号和聊天数据。";
        dialog = new AlertDialog.Builder(activity).setTitle("发现新版本")
                .setMessage(message).setNegativeButton("稍后", null)
                .setPositiveButton("下载更新", (which, button) -> download(release)).create();
        dialog.show();
    }

    private void download(ApkRelease release) {
        busy = true;
        showProgress("下载更新", "正在连接下载服务…", true);
        manager.download(release, (received, total) -> handler.post(() -> {
            if (closed || progress == null) return;
            progress.setProgress((int) (received * 100 / total));
            progress.setMessage(megabytes(received) + " / " + megabytes(total) + " MB");
        }), new ApkUpdateManager.Result<>() {
            @Override public void success(File file) {
                handler.post(() -> {
                    if (closed) return;
                    busy = false;
                    dismissProgress();
                    if (operationCancelled) return;
                    present(() -> requestInstall(release));
                });
            }
            @Override public void failure(Exception error) { failed(error, true, () -> download(release)); }
        });
    }

    private void requestInstall(ApkRelease release) {
        pendingRelease = release;
        if (activity.getPackageManager().canRequestPackageInstalls()) verifyAndInstall(release);
        else {
            dialog = new AlertDialog.Builder(activity).setTitle("允许安装更新")
                    .setMessage("新版已下载并通过校验。请在系统设置中允许惑梦安装应用，然后返回继续安装。")
                    .setNegativeButton("稍后", (which, button) -> clearPendingPermission())
                    .setPositiveButton("前往设置", (which, button) -> {
                        try {
                            preferences.edit().putString(PENDING, release.save())
                                    .putLong("permission_at", System.currentTimeMillis()).commit();
                            awaitingPermission = true;
                            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName())));
                        } catch (Exception error) {
                            awaitingPermission = false;
                            clearPendingPermission();
                            handler.post(() -> info("无法打开设置", "请在系统设置中允许惑梦安装应用，再次检查更新即可继续。"));
                        }
                    }).create();
            dialog.show();
        }
    }

    private void permissionDeclined(ApkRelease release) {
        dialog = new AlertDialog.Builder(activity).setTitle("尚未允许安装")
                .setMessage("下载的更新已保留。允许安装后即可继续，当前版本仍可正常使用。")
                .setNegativeButton("稍后", null)
                .setPositiveButton("继续安装", (which, button) -> requestInstall(release)).create();
        dialog.show();
    }

    private void verifyAndInstall(ApkRelease release) {
        busy = true;
        showProgress("准备安装", "正在校验安装包…", false);
        // Recheck after returning from settings or process recreation, including
        // the installed version (another installer may have updated it meanwhile).
        manager.verifyForInstall(release, new ApkUpdateManager.Result<>() {
            @Override public void success(File file) {
                handler.post(() -> {
                    if (closed) return;
                    busy = false;
                    dismissProgress();
                    if (operationCancelled) return;
                    present(() -> {
                        try {
                            if (!activity.getPackageManager().canRequestPackageInstalls()) { requestInstall(release); return; }
                            Uri uri = FileProvider.getUriForFile(activity,
                                    activity.getPackageName() + ".apk-updates", file);
                            Intent install = new Intent(Intent.ACTION_VIEW)
                                    .setDataAndType(uri, "application/vnd.android.package-archive")
                                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            install.setClipData(ClipData.newRawUri("Homer update", uri));
                            clearPendingPermission();
                            activity.startActivity(install);
                        } catch (RuntimeException error) {
                            info("无法启动安装", "请确认系统安装器可用，再次检查更新重试。");
                        }
                    });
                });
            }
            @Override public void failure(Exception error) { clearPendingPermission(); failed(error, true, () -> check(true)); }
        });
    }

    private void failed(Exception error, boolean visible, Runnable retry) {
        handler.post(() -> {
            if (closed) return;
            busy = false;
            dismissProgress();
            if (operationCancelled || error instanceof ApkUpdateManager.Cancelled) {
                if (visible && foreground) Toast.makeText(activity, "更新已取消", Toast.LENGTH_SHORT).show();
                return;
            }
            if (visible) present(() -> {
                String message = "更新未完成，请检查网络后重试。当前版本仍可正常使用。";
                if ("INSUFFICIENT_SPACE".equals(error.getMessage())) message = "可用空间不足，请清理存储空间后重试。";
                else if ("ANDROID_VERSION_UNSUPPORTED".equals(error.getMessage())) message = "此更新需要更高版本的 Android，当前版本仍可继续使用。";
                else if (error instanceof org.json.JSONException || String.valueOf(error.getMessage()).contains("mismatch")) {
                    message = "更新信息或安装包校验未通过，请稍后重新检查更新。";
                }
                dialog = new AlertDialog.Builder(activity).setTitle("更新未完成").setMessage(message)
                        .setNegativeButton("关闭", null)
                        .setPositiveButton("重试", (which, button) -> handler.post(retry)).create();
                dialog.show();
            });
        });
    }

    private void showProgress(String title, String message, boolean download) {
        dismissProgress();
        operationCancelled = false;
        progress = new ProgressDialog(activity);
        progress.setTitle(title);
        progress.setMessage(message);
        progress.setProgressStyle(download ? ProgressDialog.STYLE_HORIZONTAL : ProgressDialog.STYLE_SPINNER);
        progress.setIndeterminate(!download);
        progress.setMax(100);
        progress.setCancelable(true);
        progress.setCanceledOnTouchOutside(false);
        progress.setButton(ProgressDialog.BUTTON_NEGATIVE, "取消", (which, button) -> cancelOperation());
        progress.setOnCancelListener(which -> cancelOperation());
        progress.show();
    }
    private void cancelOperation() { operationCancelled = true; manager.cancel(); }
    private void dismissProgress() { if (progress != null) { progress.dismiss(); progress = null; } }
    private void present(Runnable action) {
        if (closed || activity.isFinishing() || activity.isDestroyed()) return;
        if (foreground) action.run();
        else pendingUi = action;
    }
    private void info(String title, String message) {
        dialog = new AlertDialog.Builder(activity).setTitle(title).setMessage(message)
                .setPositiveButton("知道了", null).create();
        dialog.show();
    }
    private void clearPendingPermission() { preferences.edit().remove(PENDING).remove("permission_at").apply(); }
    private static String megabytes(long bytes) { return String.format(Locale.ROOT, "%.1f", bytes / 1048576.0); }
    @Override public void close() {
        closed = true;
        manager.close();
        handler.removeCallbacksAndMessages(null);
        dismissProgress();
        if (dialog != null) dialog.dismiss();
    }
}
