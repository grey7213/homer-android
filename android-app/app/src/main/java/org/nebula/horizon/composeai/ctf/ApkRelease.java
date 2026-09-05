package org.nebula.horizon.composeai.ctf;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.Locale;

/** Public release metadata. Neither the web page nor a redirect chooses the APK origin. */
public final class ApkRelease {
    static final long MAX_BYTES = 256L * 1024 * 1024;
    final String packageName;
    final String versionName;
    final long versionCode;
    final long bytes;
    final String sha256;
    final String certificate;
    final String notes;
    final int minSdk;
    final URI url;

    private ApkRelease(JSONObject file, URI url) throws JSONException {
        packageName = file.getString("package");
        versionName = file.getString("version_name");
        versionCode = positiveInteger(file, "version_code", Integer.MAX_VALUE);
        bytes = positiveInteger(file, "bytes", MAX_BYTES);
        sha256 = digest(file.getString("sha256"));
        certificate = digest(file.getString("cert_sha256"));
        notes = file.optString("release_notes", "性能与稳定性改进。");
        minSdk = file.has("min_sdk") ? (int) positiveInteger(file, "min_sdk", 1000) : 26;
        this.url = url;
        if (versionName.trim().isEmpty() || versionName.length() > 80 || notes.length() > 10000
                || !"release".equals(file.optString("build_type"))) {
            throw new JSONException("Invalid release metadata");
        }
    }

    static ApkRelease parse(String body, String baseUrl, String expectedPackage,
                            boolean allowPrivateHttp) throws JSONException {
        JSONObject root = new JSONObject(body);
        JSONObject canonical = root.getJSONObject("canonical");
        JSONArray files = root.getJSONArray("files");
        if (files.length() > 500) throw new JSONException("Too many releases");
        String hash = digest(canonical.getString("sha256"));
        long size = positiveInteger(canonical, "bytes", MAX_BYTES);
        // Select the canonical artifact, not the highest historical version: the
        // operator can withdraw a bad release while keeping old downloads online.
        JSONObject selected = null;
        for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.optJSONObject(index);
            if (file != null && canonical.getString("name").equals(file.optString("name"))) {
                if (selected != null) throw new JSONException("Duplicate canonical release");
                selected = file;
            }
        }
        if (selected == null || !hash.equals(digest(selected.getString("sha256")))
                || size != positiveInteger(selected, "bytes", MAX_BYTES)
                || !expectedPackage.equals(selected.getString("package"))) {
            throw new JSONException("Inconsistent canonical release");
        }
        // The mutable latest.apk alias is unsuitable during a concurrent publish.
        JSONObject immutable = null;
        for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.optJSONObject(index);
            if (file == null || canonical.getString("name").equals(file.optString("name"))) continue;
            if (hash.equals(file.optString("sha256")) && size == file.optLong("bytes")
                    && expectedPackage.equals(file.optString("package"))
                    && selected.getLong("version_code") == file.optLong("version_code")
                    && selected.getString("cert_sha256").equalsIgnoreCase(file.optString("cert_sha256"))
                    && "release".equals(file.optString("build_type"))) {
                immutable = file;
                break;
            }
        }
        if (immutable == null) throw new JSONException("Missing immutable APK URL");
        URI url = trustedDownload(baseUrl, immutable.getString("url"), allowPrivateHttp);
        return new ApkRelease(selected, url);
    }

    static URI trustedDownload(String baseUrl, String path, boolean allowPrivateHttp) {
        if (!allowPrivateHttp) SafeUrls.requireHttpsBase(baseUrl);
        URI url = SafeUrls.resolveSameOrigin(baseUrl, path);
        if (url.getQuery() != null || url.getFragment() != null || url.getRawPath() == null
                || !url.getRawPath().matches("/download/[A-Za-z0-9][A-Za-z0-9._-]*\\.apk")
                || "/download/ai-xingyue-latest.apk".equals(url.getRawPath())) {
            throw new IllegalArgumentException("Invalid immutable APK URL");
        }
        return url;
    }

    static long positiveInteger(JSONObject object, String field, long maximum) throws JSONException {
        Object value = object.get(field);
        if (!(value instanceof Integer) && !(value instanceof Long)) {
            throw new JSONException("Invalid integer: " + field);
        }
        long number = ((Number) value).longValue();
        if (number <= 0 || number > maximum) throw new JSONException("Invalid range: " + field);
        return number;
    }

    static String digest(String value) throws JSONException {
        if (value == null || !value.matches("[0-9a-fA-F]{64}")) throw new JSONException("Invalid SHA-256");
        return value.toLowerCase(Locale.ROOT);
    }

    String save() throws JSONException {
        return new JSONObject().put("package", packageName).put("version_name", versionName)
                .put("version_code", versionCode).put("bytes", bytes).put("sha256", sha256)
                .put("cert_sha256", certificate).put("release_notes", notes).put("min_sdk", minSdk)
                .put("build_type", "release").put("url", url.toString()).toString();
    }

    static ApkRelease restore(String saved, String baseUrl, String expectedPackage,
                              boolean allowPrivateHttp) throws JSONException {
        JSONObject file = new JSONObject(saved);
        if (!expectedPackage.equals(file.getString("package"))) throw new JSONException("Wrong package");
        return new ApkRelease(file, trustedDownload(baseUrl, file.getString("url"), allowPrivateHttp));
    }
}
