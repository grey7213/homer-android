package org.nebula.horizon.composeai.ctf;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;

/** Private full-size camera output. Never request storage-wide permission. */
final class WebCameraCapture {
    final File file;
    final Uri uri;

    private WebCameraCapture(File file, Uri uri) { this.file = file; this.uri = uri; }

    static boolean acceptsPhoto(boolean capture, String[] types) {
        if (!capture || types == null || types.length == 0) return false;
        for (String type : types) if (type == null || !type.startsWith("image/")) return false;
        return true;
    }

    static WebCameraCapture create(Context context) throws IOException {
        File directory = new File(context.getCacheDir(), "camera-captures");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("camera cache unavailable");
        // A returned file may still be uploading. Retain it across subsequent
        // picker requests; only expire this narrowly scoped cache after a day.
        File[] previous = directory.listFiles();
        if (previous != null) for (File item : previous) {
            if (item.isFile() && item.getName().startsWith("capture-") && item.getName().endsWith(".jpg")
                    && System.currentTimeMillis() - item.lastModified() > 86_400_000L) item.delete();
        }
        File file = File.createTempFile("capture-", ".jpg", directory);
        try {
            return new WebCameraCapture(file, FileProvider.getUriForFile(context,
                    context.getPackageName() + ".camera-files", file));
        } catch (RuntimeException error) { file.delete(); throw error; }
    }

    Intent intent() {
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("photo", uri));
        return intent;
    }

    boolean hasPhoto() { return file.isFile() && file.length() > 0; }

    void finish(Context context, boolean keep) {
        context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (!keep) file.delete();
    }
}
