package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.junit.Test;

public final class HomerUtf8Sha256Test {
    private static String reference(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte item : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return hex.toString();
    }

    @Test public void matchesUtf8ForEmptyEnglishChineseEmojiNullAndNewlines() throws Exception {
        for (String value : new String[] {"", "ASCII", "中英 mixed 😀\n\u0000", "0", "null", "\"\\ud800-x-\\udfff\""}) {
            assertEquals(reference(value), HomerUtf8Sha256.digest(value));
            assertTrue(HomerUtf8Sha256.digest(value).matches("[a-f0-9]{64}"));
        }
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", HomerUtf8Sha256.digest(""));
    }

    @Test public void malformedUnpairedUtf16RejectsRatherThanHashingDifferentReplacementBytes() {
        assertEquals("", HomerUtf8Sha256.digest(null));
        assertEquals("", HomerUtf8Sha256.digest("x\ud800"));
        assertEquals("", HomerUtf8Sha256.digest("\udfff-x"));
        assertEquals("", HomerUtf8Sha256.digest("\ud800\ud800"));
    }

    @Test public void exactlyThirtyTwoMiBUtf8AsciiIsAllowed() {
        char[] characters = new char[HomerUtf8Sha256.MAX_UTF8_BYTES];
        Arrays.fill(characters, 'a');
        assertEquals("facb58ac139bf9fc0e1f8b1f147003236b1b69e84f3a4c94166fa66f18f89932", HomerUtf8Sha256.digest(new String(characters)));
    }

    @Test public void characterLengthAboveLimitRejectsBeforeEncoding() {
        char[] characters = new char[HomerUtf8Sha256.MAX_UTF8_BYTES + 1];
        Arrays.fill(characters, 'a');
        assertEquals("", HomerUtf8Sha256.digest(new String(characters)));
    }

    @Test public void MultibyteUtf8BudgetRejectsEvenWhenUtf16LengthFits() {
        char[] characters = new char[HomerUtf8Sha256.MAX_UTF8_BYTES / 3 + 1];
        Arrays.fill(characters, '中');
        assertEquals("", HomerUtf8Sha256.digest(new String(characters)));
    }

    @Test public void bridgeUsesPureHelperWithoutActivityOrDatabaseAccess() throws Exception {
        LiveBridge bridge = new LiveBridge(null, null, null);
        assertEquals(reference("{\"text\":\"中😀\\n\\u0000\\ud800\"}"), bridge.sha256Utf8("{\"text\":\"中😀\\n\\u0000\\ud800\"}"));
        assertEquals("", bridge.sha256Utf8(null));
        assertTrue(LiveBridge.class.getMethod("sha256Utf8", String.class)
                .isAnnotationPresent(android.webkit.JavascriptInterface.class));
    }
}
