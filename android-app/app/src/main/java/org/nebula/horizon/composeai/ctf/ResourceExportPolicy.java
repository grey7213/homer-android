package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.nio.charset.StandardCharsets;

/** No URL downloads or arbitrary paths: only bounded data from the active
 * resource editor, saved via Android's explicit document picker. */
final class ResourceExportPolicy {
    static final int MAX_BYTES = 8 * 1024 * 1024;

    static boolean trustedEditor(String baseUrl, String pageUrl) {
        try {
            URI base = URI.create(baseUrl), page = URI.create(pageUrl);
            return base.getScheme().equals(page.getScheme())
                    && base.getRawAuthority().equals(page.getRawAuthority())
                    && page.getUserInfo() == null
                    && "/app/workshop-resource-editor.html".equals(page.getRawPath());
        } catch (RuntimeException invalid) { return false; }
    }

    static byte[] validate(String requestId, String filename, String mime, String content) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("invalid request");
        if (filename == null || filename.length() > 120 || filename.isBlank()
                || filename.startsWith(".") || !filename.equals(filename.trim())
                || filename.matches(".*[\\\\/:*?\"<>|\\p{Cntrl}].*")) throw new IllegalArgumentException("invalid filename");
        if (!("application/json".equals(mime) && filename.endsWith(".json"))
                && !("text/html".equals(mime) && filename.endsWith(".html"))) throw new IllegalArgumentException("invalid file type");
        if (content == null || content.isEmpty() || content.length() > MAX_BYTES) throw new IllegalArgumentException("invalid payload");
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IllegalArgumentException("payload too large");
        return bytes;
    }
}
