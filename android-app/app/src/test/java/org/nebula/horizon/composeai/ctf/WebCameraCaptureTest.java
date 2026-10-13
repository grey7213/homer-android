package org.nebula.horizon.composeai.ctf;

import org.junit.Test;
import static org.junit.Assert.*;

public final class WebCameraCaptureTest {
    @Test public void onlyExplicitImageCaptureOpensCamera() {
        assertTrue(WebCameraCapture.acceptsPhoto(true, FilePickerTypes.normalize(new String[]{"image/*"})));
        assertTrue(WebCameraCapture.acceptsPhoto(true, FilePickerTypes.normalize(new String[]{".jpg,.png"})));
        assertFalse(WebCameraCapture.acceptsPhoto(false, new String[]{"image/*"}));
        assertFalse(WebCameraCapture.acceptsPhoto(true, new String[]{"video/mp4"}));
        assertFalse(WebCameraCapture.acceptsPhoto(true, new String[]{"image/*", "application/json"}));
        assertFalse(WebCameraCapture.acceptsPhoto(true, FilePickerTypes.normalize(new String[]{"*/*"})));
        assertFalse(WebCameraCapture.acceptsPhoto(true, null));
    }
}
