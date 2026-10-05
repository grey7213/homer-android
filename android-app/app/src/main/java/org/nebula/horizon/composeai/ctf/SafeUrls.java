package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

public final class SafeUrls {
    private SafeUrls() {}

    public static URI requireHttpsBase(String value) {
        URI uri = parseBase(value);
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("Server base URL must use HTTPS");
        }
        return uri;
    }

    static URI requireTrustedBase(String value) {
        URI uri = parseBase(value);
        String scheme = String.valueOf(uri.getScheme()).toLowerCase(Locale.ROOT);
        boolean secure = "https".equals(scheme);
        boolean debugHttp = "http".equals(scheme)
                && (isLoopback(uri.getHost()) || isPrivateIpv4(uri.getHost()));
        if (!secure && !debugHttp) {
            throw new IllegalArgumentException("Server base URL must use HTTPS or private-network HTTP");
        }
        return uri;
    }

    private static URI parseBase(String value) {
        try {
            URI uri = new URI(value);
            if (uri.getHost() == null) {
                throw new IllegalArgumentException("Server base URL must include a host");
            }
            String path = uri.getPath();
            if (path == null || !path.endsWith("/")) {
                throw new IllegalArgumentException("Server base URL must end in /");
            }
            if (uri.getUserInfo() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException("Server base URL contains unsupported components");
            }
            return uri;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid server base URL", error);
        }
    }

    public static boolean isTrustedNavigation(String baseUrl, String candidate) {
        try {
            URI base = requireTrustedBase(baseUrl);
            URI target = base.resolve(candidate);
            return base.getScheme().equalsIgnoreCase(target.getScheme())
                    && base.getHost().equalsIgnoreCase(target.getHost())
                    && effectivePort(base) == effectivePort(target)
                    && target.getUserInfo() == null;
        } catch (RuntimeException error) {
            return false;
        }
    }

    /**
     * A same-origin document Blob belongs to the renderer, not to the network
     * asset loader. Only permit it inside an already trusted live page; it must
     * never replace that page or become a generally trusted bridge/API origin.
     */
    static boolean isTrustedFrameBlobNavigation(String baseUrl, String candidate,
                                               boolean mainFrame, String currentTopUrl) {
        if (mainFrame || !isTrustedNavigation(baseUrl, currentTopUrl)) return false;
        try {
            URI blob = new URI(candidate);
            if (!"blob".equalsIgnoreCase(blob.getScheme()) || blob.getRawFragment() != null) return false;
            URI source = new URI(blob.getRawSchemeSpecificPart());
            String scheme = source.getScheme();
            if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                    || source.isOpaque() || source.getRawQuery() != null
                    || source.getRawFragment() != null || source.getRawUserInfo() != null
                    || !isTrustedNavigation(baseUrl, source.toString())) return false;
            // URL.createObjectURL emits one opaque UUID after the creator origin.
            // No relative path, extra segment, encoded separator or query is a
            // renderer-created document Blob supported by this exception.
            String path = source.getRawPath();
            return path != null && path.matches(
                    "/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
        } catch (URISyntaxException | RuntimeException error) {
            return false;
        }
    }

    public static URI resolveSameOrigin(String baseUrl, String candidate) {
        URI base = requireTrustedBase(baseUrl);
        URI resolved = base.resolve(candidate);
        if (!isTrustedNavigation(baseUrl, resolved.toString())) {
            throw new IllegalArgumentException("URL must use the configured server origin");
        }
        return resolved;
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static boolean isLoopback(String host) {
        return "127.0.0.1".equals(host) || "localhost".equalsIgnoreCase(host);
    }

    private static boolean isPrivateIpv4(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int index = 0; index < 4; index++) {
                octets[index] = Integer.parseInt(parts[index]);
                if (octets[index] < 0 || octets[index] > 255) return false;
            }
        } catch (NumberFormatException error) {
            return false;
        }
        return octets[0] == 10
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168);
    }
}
