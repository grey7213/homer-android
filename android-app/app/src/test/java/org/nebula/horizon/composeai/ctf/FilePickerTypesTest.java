package org.nebula.horizon.composeai.ctf;

import static org.junit.Assert.assertArrayEquals;
import org.junit.Test;

public final class FilePickerTypesTest {
    @Test public void convertsAndDeduplicatesHtmlAcceptTokens() {
        assertArrayEquals(new String[]{"application/json", "image/png"}, FilePickerTypes.normalize(new String[]{".json,.png,application/json"}));
    }
    @Test public void unknownCardPackExtensionsStaySelectable() {
        assertArrayEquals(new String[0], FilePickerTypes.normalize(new String[]{".json,.png,.zip,.tgp,.tpg"}));
    }
    @Test public void ordinaryImageAndAudioPickersRetainFilters() {
        assertArrayEquals(new String[]{"image/*"}, FilePickerTypes.normalize(new String[]{"image/*"}));
        assertArrayEquals(new String[]{"audio/mpeg", "audio/ogg"}, FilePickerTypes.normalize(new String[]{"audio/mpeg", "audio/ogg"}));
    }
    @Test public void emptyAndAnyAcceptAllowAllFiles() {
        assertArrayEquals(new String[0], FilePickerTypes.normalize(null));
        assertArrayEquals(new String[0], FilePickerTypes.normalize(new String[]{"", "*/*"}));
    }
}
