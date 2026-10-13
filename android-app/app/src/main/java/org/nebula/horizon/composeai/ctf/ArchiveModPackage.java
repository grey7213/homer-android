package org.nebula.horizon.composeai.ctf;

import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.util.*;
import java.util.zip.*;

/** Data-only CAPK v1 interoperability contract observed from an authorized sample. */
final class ArchiveModPackage {
    static final long MAX_EXPANDED = 200L * 1024 * 1024;
    static final int MAX_FILE = 50_000_000;
    private long expanded;
    private final List<JSONObject> manifests = new ArrayList<>();
    private static byte[] exact(InputStream input,int size)throws IOException {
        byte[] bytes=new byte[size];int offset=0;
        while(offset<size){int read=input.read(bytes,offset,size-offset);if(read<0)throw new IOException("MOD_TRUNCATED");offset+=read;}
        return bytes;
    }

    static boolean safePath(String name) {
        if (name == null || name.isEmpty() || name.length() > 500 || name.startsWith("/")
                || name.contains("\\") || name.contains(":")) return false;
        for (String part : name.split("/", -1)) if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        return name.codePoints().noneMatch(c -> c < 32 || c == 127);
    }
    static boolean dataFile(String name) {
        return safePath(name) && name.toLowerCase(Locale.ROOT).matches(".*\\.(json|atlas|skel|png|jpg|jpeg|webp|mp3|ogg|wav)$");
    }
    private static int integer(InputStream input) throws IOException {
        byte[] b = exact(input,4);
        if (b.length != 4) throw new IOException("MOD_TRUNCATED");
        long n = (b[0]&255L) | ((b[1]&255L)<<8) | ((b[2]&255L)<<16) | ((b[3]&255L)<<24);
        if (n > Integer.MAX_VALUE) throw new IOException("MOD_LIMIT");
        return (int)n;
    }
    private static String string(InputStream input) throws IOException {
        int n = 0, shift = 0;
        for (int i = 0; i < 5; i++) {
            int b = input.read(); if (b < 0) throw new IOException("MOD_TRUNCATED");
            if (i == 4 && (b & 0xf0) != 0) throw new IOException("MOD_STRING");
            n |= (b & 127) << shift;
            if ((b & 128) == 0) {
                if (n < 0 || n > 4096) throw new IOException("MOD_STRING");
                byte[] bytes = exact(input,n);
                return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString();
            }
            shift += 7;
        }
        throw new IOException("MOD_STRING");
    }
    private void capk(InputStream input, File directory) throws Exception {
        if (!Arrays.equals(exact(input,4), new byte[]{'K','P','A','C'}) || integer(input) != 1) throw new IOException("MOD_CAPK_VERSION");
        string(input); int count = integer(input);
        if (count < 1 || count > 1024 || manifests.size() >= 12) throw new IOException("MOD_LIMIT");
        int ordinal = manifests.size(); File target = new File(directory, "role-" + ordinal);
        if (!target.mkdirs()) throw new IOException("MOD_DIRECTORY");
        Set<String> names = new HashSet<>(); JSONObject manifest = null;
        for (int i = 0; i < count; i++) {
            String name = string(input); int size = integer(input);
            if (!dataFile(name) || !names.add(name.toLowerCase(Locale.ROOT)) || size > MAX_FILE || (expanded += size) > MAX_EXPANDED) throw new IOException("MOD_ENTRY");
            File file = new File(target, name);
            if (!file.getCanonicalPath().startsWith(target.getCanonicalPath() + File.separator)) throw new IOException("MOD_PATH");
            if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("MOD_DIRECTORY");
            try (FileOutputStream output = new FileOutputStream(file)) {
                byte[] buffer = new byte[16384]; int left = size;
                while (left > 0) {
                    if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("MOD_CANCELLED");
                    int read = input.read(buffer, 0, Math.min(buffer.length, left));
                    if (read < 0) throw new IOException("MOD_TRUNCATED"); output.write(buffer,0,read); left -= read;
                }
                output.getFD().sync();
            }
            if (name.equals("manifest.json")) {
                if (size > 2*1024*1024) throw new IOException("MOD_MANIFEST_LIMIT");
                manifest = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            }
        }
        if (input.read() != -1 || manifest == null || manifest.optInt("schema_version") != 1
                || !manifest.has("role") || !manifest.has("spines")) throw new IOException("MOD_MANIFEST");
        manifests.add(manifest);
    }
    static List<JSONObject> unpack(File source, File directory) throws Exception {
        ArchiveModPackage parser = new ArchiveModPackage();
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source))) {
            input.mark(4); byte[] magic = exact(input,4); input.reset();
            if (Arrays.equals(magic,new byte[]{'K','P','A','C'})) parser.capk(input,directory);
            else if (magic.length == 4 && magic[0]=='P' && magic[1]=='K') {
                try (ZipInputStream zip = new ZipInputStream(input, StandardCharsets.UTF_8)) {
                    ZipEntry entry; int count=0; Set<String> names=new HashSet<>();
                    while ((entry=zip.getNextEntry()) != null) {
                        if (++count > 1024) throw new IOException("MOD_LIMIT");
                        String name=entry.getName();
                        if (entry.isDirectory()) { if(!safePath(name.replaceAll("/$","")))throw new IOException("MOD_PATH"); continue; }
                        if(!safePath(name)||!names.add(name.toLowerCase(Locale.ROOT)))throw new IOException("MOD_PATH");
                        if(name.toLowerCase(Locale.ROOT).endsWith(".capk")) parser.capk(zip,directory);
                        else {
                            // Non-package documentation is inert, but still bounded against ZIP bombs.
                            byte[] buffer=new byte[16384]; int read;
                            while((read=zip.read(buffer))!=-1)if((parser.expanded+=read)>MAX_EXPANDED)throw new IOException("MOD_LIMIT");
                        }
                        zip.closeEntry();
                    }
                }
            } else throw new IOException("MOD_FORMAT_UNSUPPORTED");
        }
        if(parser.manifests.isEmpty())throw new IOException("MOD_NO_CAPK");
        return parser.manifests;
    }
}
