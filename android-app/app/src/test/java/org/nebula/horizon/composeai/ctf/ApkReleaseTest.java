package org.nebula.horizon.composeai.ctf;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import static org.junit.Assert.*;

public class ApkReleaseTest {
    private static final String BASE = "https://patcher.villainy.top/";
    private static final String PACKAGE = "org.nebula.horizon.composeai";
    private static final String HASH = "a".repeat(64);
    private static final String CERT = "b".repeat(64);

    private JSONObject feed() throws Exception {
        JSONObject file = new JSONObject().put("name", "ai-xingyue-latest.apk")
                .put("url", "/download/ai-xingyue-latest.apk").put("bytes", 1000)
                .put("sha256", HASH).put("cert_sha256", CERT).put("package", PACKAGE)
                .put("version_code", 270).put("version_name", "1.15.0").put("build_type", "release");
        JSONObject immutable = new JSONObject(file.toString()).put("name", "homer-270.apk")
                .put("url", "/download/homer-270.apk");
        return new JSONObject().put("canonical", new JSONObject(file.toString()))
                .put("files", new JSONArray().put(file).put(immutable));
    }
    private ApkRelease parse(JSONObject feed) throws Exception {
        return ApkRelease.parse(feed.toString(), BASE, PACKAGE, false);
    }
    private void rejects(JSONObject feed) throws Exception { assertThrows(Exception.class, () -> parse(feed)); }
    private JSONObject file(JSONObject feed) throws Exception { return feed.getJSONArray("files").getJSONObject(0); }
    private JSONObject download(JSONObject feed) throws Exception { return feed.getJSONArray("files").getJSONObject(1); }

    @Test public void acceptsLegacyFeedAndUsesImmutableArtifact() throws Exception {
        ApkRelease result = parse(feed());
        assertEquals(270, result.versionCode);
        assertEquals(BASE + "download/homer-270.apk", result.url.toString());
        assertEquals(result.sha256, ApkRelease.restore(result.save(), BASE, PACKAGE, false).sha256);
    }
    @Test public void canonicalControlsReleaseInsteadOfHistoricalMaximum() throws Exception {
        JSONObject value = feed();
        value.getJSONArray("files").put(new JSONObject(download(value).toString()).put("version_code", 999));
        assertEquals(270, parse(value).versionCode);
    }
    @Test public void rejectsWrongPackage() throws Exception {
        JSONObject value = feed(); file(value).put("package", "some.other.app"); rejects(value);
    }
    @Test public void rejectsForeignOrigin() throws Exception {
        JSONObject value = feed(); download(value).put("url", "https://example.com/download/app.apk"); rejects(value);
    }
    @Test public void rejectsHttpDowngrade() throws Exception {
        JSONObject value = feed(); download(value).put("url", "http://patcher.villainy.top/download/app.apk"); rejects(value);
    }
    @Test public void rejectsUserInfo() throws Exception {
        JSONObject value = feed(); download(value).put("url", "https://user@patcher.villainy.top/download/app.apk"); rejects(value);
    }
    @Test public void rejectsEncodedTraversalOrQuery() throws Exception {
        for (String path : new String[]{"/download/%2e%2e/app.apk", "/download/app.apk?to=other", "/download/app.apk#x", "/outside/app.apk"}) {
            JSONObject value = feed(); download(value).put("url", path); rejects(value);
        }
    }
    @Test public void rejectsNoImmutableArtifact() throws Exception {
        JSONObject value = feed(); value.getJSONArray("files").remove(1); rejects(value);
    }
    @Test public void rejectsCanonicalHashOrSizeMismatch() throws Exception {
        JSONObject value = feed(); value.getJSONObject("canonical").put("bytes", 999); rejects(value);
        value = feed(); file(value).put("sha256", "c".repeat(64)); rejects(value);
    }
    @Test public void rejectsUnsignedAndDebugMetadata() throws Exception {
        JSONObject value = feed(); file(value).put("cert_sha256", ""); rejects(value);
        value = feed(); file(value).put("build_type", "debug"); rejects(value);
    }
    @Test public void rejectsInvalidNumbers() throws Exception {
        for (Object number : new Object[]{0, -1, "270", 270.5, 2147483648L}) {
            JSONObject value = feed(); file(value).put("version_code", number); rejects(value);
        }
    }
    @Test public void rejectsOversizedFileAndMissingMetadata() throws Exception {
        JSONObject value = feed(); value.getJSONObject("canonical").put("bytes", ApkRelease.MAX_BYTES + 1); rejects(value);
        value = feed(); value.remove("canonical"); rejects(value);
    }
    @Test public void rejectsDuplicateCanonical() throws Exception {
        JSONObject value = feed(); value.getJSONArray("files").put(file(value)); rejects(value);
    }
    @Test public void permitsPrivateHttpOnlyForDebugFixture() throws Exception {
        assertThrows(Exception.class, () -> ApkRelease.parse(feed().toString(), "http://127.0.0.1:18490/", PACKAGE, false));
        assertEquals("127.0.0.1", ApkRelease.parse(feed().toString(), "http://127.0.0.1:18490/", PACKAGE, true).url.getHost());
        assertThrows(Exception.class, () -> ApkRelease.parse(feed().toString(), "http://example.com/", PACKAGE, true));
    }
}
