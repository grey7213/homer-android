package org.nebula.horizon.composeai.ctf;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Pure bounded hashing only; this helper has no storage, network or logging access. */
final class HomerUtf8Sha256 {
    static final int MAX_UTF8_BYTES = 32 * 1024 * 1024;
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private HomerUtf8Sha256() { }

    static String digest(String value) {
        // Every valid UTF-16 code unit needs at least one UTF-8 byte. Check the
        // cheap character budget before scanning or allocating encoded bytes.
        if (value == null || value.length() > MAX_UTF8_BYTES) return "";
        if (!fitsUtf8Budget(value)) return "";
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_UTF8_BYTES) return "";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            char[] hex = new char[digest.length * 2];
            for (int index = 0; index < digest.length; index++) {
                int item = digest[index] & 0xff;
                hex[index * 2] = HEX[item >>> 4];
                hex[index * 2 + 1] = HEX[item & 0xf];
            }
            return new String(hex);
        } catch (NoSuchAlgorithmException unavailable) {
            return "";
        }
    }

    private static boolean fitsUtf8Budget(String value) {
        long byteLength = 0;
        for (int index = 0; index < value.length(); index++) {
            char item = value.charAt(index);
            if (item <= 0x7f) byteLength++;
            else if (item <= 0x7ff) byteLength += 2;
            else if (Character.isHighSurrogate(item)) {
                if (++index >= value.length() || !Character.isLowSurrogate(value.charAt(index))) return false;
                byteLength += 4;
            } else if (Character.isLowSurrogate(item)) {
                // Java's encoder and TextEncoder replace malformed UTF-16
                // differently. JSON.stringify escapes such units beforehand;
                // arbitrary malformed raw input must use the browser fallback.
                return false;
            } else byteLength += 3;
            if (byteLength > MAX_UTF8_BYTES) return false;
        }
        return true;
    }
}
