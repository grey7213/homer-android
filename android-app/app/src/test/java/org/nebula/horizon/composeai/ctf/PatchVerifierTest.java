package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;

public final class PatchVerifierTest {
    @Test
    public void hashesDeterministically() throws Exception {
        assertEquals(
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                PatchVerifier.sha256("hello".getBytes(StandardCharsets.UTF_8))
        );
    }

    @Test
    public void verifiesRsaManifestSignatureAndRejectsMutation() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair pair = generator.generateKeyPair();
        String message = PatchVerifier.canonicalMessage(
                "2026.08.16.1",
                262,
                "https://example.test/updates/android/patch.zip",
                "a".repeat(64)
        );
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pair.getPrivate());
        signer.update(message.getBytes(StandardCharsets.UTF_8));
        String publicKey = Base64.getEncoder().encodeToString(pair.getPublic().getEncoded());
        String signature = Base64.getEncoder().encodeToString(signer.sign());
        assertTrue(PatchVerifier.verifyRsaSha256(publicKey, message, signature));
        assertFalse(PatchVerifier.verifyRsaSha256(publicKey, message + "changed", signature));
    }

    @Test
    public void onlyAllowsProductResourcePatchPaths() {
        assertTrue(PatchVerifier.isSafeZipPath("offline/index.html"));
        assertTrue(PatchVerifier.isSafeZipPath("offline/assets/app.js"));
        assertTrue(PatchVerifier.isSafeZipPath("client/index.txt"));
        assertTrue(PatchVerifier.isSafeZipPath("client/runtime/scripts/app.js"));
        assertFalse(PatchVerifier.isSafeZipPath("../offline/index.html"));
        assertFalse(PatchVerifier.isSafeZipPath("offline/../secret"));
        assertFalse(PatchVerifier.isSafeZipPath("C:\\offline\\index.html"));
        assertFalse(PatchVerifier.isSafeZipPath("scripts/app.js"));
    }
}
