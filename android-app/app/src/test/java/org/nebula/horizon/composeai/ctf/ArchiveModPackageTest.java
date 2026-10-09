package org.nebula.horizon.composeai.ctf;
import org.junit.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static org.junit.Assert.*;

public class ArchiveModPackageTest {
    private static void number(OutputStream out,int n)throws IOException {for(int i=0;i<4;i++)out.write((n>>>(8*i))&255);}
    private static void text(OutputStream out,String value)throws IOException {
        byte[] bytes=value.getBytes(StandardCharsets.UTF_8);int n=bytes.length;
        while(n>=128){out.write((n&127)|128);n>>>=7;}out.write(n);out.write(bytes);
    }
    private static byte[] packageBytes(String name)throws Exception{
        ByteArrayOutputStream out=new ByteArrayOutputStream();out.write("KPAC".getBytes(StandardCharsets.US_ASCII));number(out,1);text(out,"合成测试人物");number(out,1);
        text(out,name);byte[] json="{\"schema_version\":1,\"role\":{},\"spines\":[]}".getBytes(StandardCharsets.UTF_8);number(out,json.length);out.write(json);return out.toByteArray();
    }
    @Test public void dataOnlyAndPathBoundaries(){
        for(String unsafe:new String[]{"../x.png","a/../../x.png","/a.png","a\\b.png","a:b.png","a//b.png","a/./b.png","a\u0000.png"})assertFalse(ArchiveModPackage.safePath(unsafe));
        for(String unsafe:new String[]{"a.js","a.html","a.apk","a.dll","a.exe"})assertFalse(ArchiveModPackage.dataFile(unsafe));
        assertTrue(ArchiveModPackage.dataFile("files/0/贴图.png"));
    }
    @Test public void truncatedAndTraversalNeverProduceReadyPackage()throws Exception{
        Path root=Files.createTempDirectory("homer-capk-test-");
        try{
            for(byte[] bytes:new byte[][]{Arrays.copyOf(packageBytes("manifest.json"),30),packageBytes("../manifest.json"),packageBytes("code.js")}){
                File source=root.resolve(UUID.randomUUID()+".capk").toFile();Files.write(source.toPath(),bytes);
                File directory=Files.createTempDirectory(root,"extract-").toFile();
                try{ArchiveModPackage.unpack(source,directory);fail("unsafe package accepted");}catch(IOException expected){assertTrue(expected.getMessage().startsWith("MOD_"));}
            }
            File source=root.resolve("valid.capk").toFile();Files.write(source.toPath(),packageBytes("manifest.json"));
            assertEquals(1,ArchiveModPackage.unpack(source,Files.createTempDirectory(root,"valid-").toFile()).size());
        }finally{clean(root);}
    }
    @Test public void authorizedRealZipHasExactProfileAndAllDeclaredFiles()throws Exception{
        String path=System.getenv("ARCHIVE_QA_ROLE_SAMPLE");Assume.assumeTrue("authorized local sample only",path!=null);
        Path root=Files.createTempDirectory("homer-real-capk-");
        try{
            List<JSONObject> manifests=ArchiveModPackage.unpack(new File(path),root.toFile());assertEquals(1,manifests.size());
            JSONObject manifest=manifests.get(0),person=manifest.getJSONObject("role");assertFalse(person.getString("private_setting").isBlank());
            JSONArray spines=manifest.getJSONArray("spines");assertEquals(1,spines.length());assertEquals(39,spines.getJSONObject(0).getJSONArray("animation_names").length());
            assertTrue(root.resolve("role-0/files/0/skeleton_42.skel").toFile().isFile());assertEquals(11805684,root.resolve("role-0/files/0/skeleton2.png").toFile().length());
            ArchiveWorkshopStore store=new ArchiveWorkshopStore(root.resolve("installed").toFile());
            JSONObject descriptor=new JSONObject().put("resource_id","608761ee-d235-437d-90f7-aa22d97786d8").put("revision_id","d7c8d252-8f12-433c-acb2-f8d02daa6963")
                .put("sha256","3092b83304b64e7367274adb5379598e1b21f61daf93599d06ab1f97819033f2").put("size",13494935);
            JSONObject converted=store.install(new File(path),descriptor).getJSONArray("roles").getJSONObject(0);
            assertEquals(39,converted.getJSONArray("variants").getJSONObject(0).getJSONArray("animations").length());
            assertEquals("d7c8d252-8f12-433c-acb2-f8d02daa6963",converted.getJSONObject("source").getString("revisionId"));
            assertEquals(1,new JSONObject(new ArchiveWorkshopStore(root.resolve("installed").toFile()).catalog()).getJSONArray("roles").length());
            assertEquals(converted.toString(),store.install(new File(path),descriptor).getJSONArray("roles").getJSONObject(0).toString());
            String outputPath=System.getenv("ARCHIVE_QA_OUTPUT");
            if(outputPath!=null){
                File output=new File(outputPath);if(output.exists())throw new IOException("QA output must be a fresh task directory");
                ArchiveWorkshopStore exported=new ArchiveWorkshopStore(output);
                exported.install(new File(path),descriptor);
                Files.write(new File(output,"catalog.json").toPath(),exported.catalog().getBytes(StandardCharsets.UTF_8));
            }
        }finally{clean(root);}
    }
    private static void clean(Path root)throws IOException{try(var stream=Files.walk(root)){Iterator<Path> paths=stream.sorted(Comparator.reverseOrder()).iterator();while(paths.hasNext())Files.delete(paths.next());}}
}
