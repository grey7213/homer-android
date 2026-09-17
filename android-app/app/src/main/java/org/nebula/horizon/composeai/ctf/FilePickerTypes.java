package org.nebula.horizon.composeai.ctf;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/** Android intents accept MIME types, never HTML extension tokens. */
final class FilePickerTypes {
    static String[] normalize(String[] accepts) {
        Set<String> types = new LinkedHashSet<>();
        if (accepts != null) for (String accept : accepts) {
            if (accept == null) continue;
            for (String token : accept.split(",")) {
                String type = token.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                switch (type) {
                    case ".json": type = "application/json"; break;
                    case ".png": type = "image/png"; break;
                    case ".jpg": case ".jpeg": type = "image/jpeg"; break;
                    case ".zip": type = "application/zip"; break;
                    default: break;
                }
                // TGP/TPG and provider-specific files have no registered MIME.
                // Leave these visible; the importer validates their content.
                if (type.equals("*/*") || !type.matches("[a-z0-9!#$&^_.+-]+/([a-z0-9!#$&^_.+-]+|\\*)")) return new String[0];
                types.add(type);
            }
        }
        return types.toArray(new String[0]);
    }
}
