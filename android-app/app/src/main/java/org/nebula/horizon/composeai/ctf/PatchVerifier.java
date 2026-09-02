package org.nebula.horizon.composeai.ctf;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Locale;

public final class PatchVerifier {
    private PatchVerifier() {}

    public static String canonicalMessage(
            String version,
            int minAppVersion,
            String packageUrl,
            String sha256
    ) {
        return version + "\n" + minAppVersion + "\n" + packageUrl + "\n"
                + sha256.toLowerCase(Locale.ROOT) + "\n";
    }

    public static String sha256(InputStream input) throws IOException, GeneralSecurityException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (read > 0) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    public static String sha256(byte[] data) throws GeneralSecurityException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return hex(digest.digest(data));
    }

    public static boolean verifyRsaSha256(
            String publicKeyDerBase64,
            String message,
            String signatureBase64
    ) throws GeneralSecurityException {
        if (publicKeyDerBase64 == null || publicKeyDerBase64.trim().isEmpty()) return false;
        byte[] keyBytes = Base64.getDecoder().decode(publicKeyDerBase64.replaceAll("\\s", ""));
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(keyBytes));
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(key);
        verifier.update(message.getBytes(StandardCharsets.UTF_8));
        return verifier.verify(Base64.getDecoder().decode(signatureBase64));
    }

    public static boolean isSafeZipPath(String value) {
        if (value == null || value.trim().isEmpty() || value.indexOf('\0') >= 0) return false;
        String normalized = value.replace('\\', '/');
        if (normalized.startsWith("/") || normalized.matches("^[A-Za-z]:.*")) return false;
        String[] parts = normalized.split("/");
        for (String part : parts) {
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) return false;
        }
        return normalized.startsWith("offline/") || normalized.startsWith("client/");
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }
}
