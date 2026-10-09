package org.nebula.horizon.composeai.ctf;

import org.junit.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import static org.junit.Assert.*;

public class ArchiveWorkshopClientTest {
    static final String ID="11111111-2222-3333-4444-555555555555",REV="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    static JSONObject item()throws Exception{return new JSONObject().put("id",ID).put("title","合成作品").put("category","characters").put("description","<script>not executable</script>")
        .put("author",new JSONObject().put("name","合成作者")).put("file",new JSONObject().put("revision_id",REV).put("sha256","a".repeat(64)).put("size",100).put("name","sample.zip").put("extension","zip"));}
    static byte[] wrap(JSONObject data)throws Exception{return new JSONObject().put("ok",true).put("data",data).toString().getBytes(StandardCharsets.UTF_8);}
    static String hash(byte[] value)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(value))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    @Test public void originAndPreviewNeverAcceptRedirectOrCredentials(){
        assertTrue(ArchiveWorkshopClient.trusted("https://chatarchivemods.org/api/me/"));
        for(String url:new String[]{"http://chatarchivemods.org/","https://chatarchivemods.org.evil/","https://user@chatarchivemods.org/","https://chatarchivemods.org:444/","javascript:alert(1)"})assertFalse(url,ArchiveWorkshopClient.trusted(url));
        assertEquals("",ArchiveWorkshopClient.preview("//evil.example/image.png"));assertEquals("",ArchiveWorkshopClient.preview("/api/me/"));
        assertEquals(ArchiveWorkshopClient.ORIGIN+"/preview/"+REV+"/?size=card",ArchiveWorkshopClient.preview("/preview/"+REV+"/?size=card"));
    }
    @Test public void queryIsBoundedAndEncoded()throws Exception{
        assertTrue(ArchiveWorkshopClient.query("characters","中文 & / ?",2).contains("%26"));
        for(String cat:new String[]{"manage","characters&private=1"})try{ArchiveWorkshopClient.query(cat,"",1);fail();}catch(IOException expected){}
        try{ArchiveWorkshopClient.query("characters","x".repeat(121),1);fail();}catch(IOException expected){}
    }
    @Test public void actionsAreMetadataBoundAndFormatsHonest()throws Exception{
        ArchiveWorkshopClient.Item role=new ArchiveWorkshopClient.Item(item());assertTrue(role.importable());assertFalse(role.saveable());assertEquals(ID,role.descriptor().getString("resource_id"));
        assertEquals("<script>not executable</script>",role.description);
        for(String ext:new String[]{"7z","rar","exe","html"})assertFalse(new ArchiveWorkshopClient.Item(withExtension(ext)).importable());
        JSONObject preset=item().put("category","presets");preset.getJSONObject("file").put("extension","txt");assertTrue(new ArchiveWorkshopClient.Item(preset).saveable());
        JSONObject changed=item();changed.getJSONObject("file").put("sha256","bad");assertFalse(new ArchiveWorkshopClient.Item(changed).validFile());
    }
    private static JSONObject withExtension(String extension)throws Exception{JSONObject v=item();v.getJSONObject("file").put("extension",extension);return v;}
    @Test public void catalogCacheOnlyContainsPublicRows()throws Exception{
        Path dir=Files.createTempDirectory("workshop-public-test-");try{
            List<String> calls=new ArrayList<>();ArchiveWorkshopClient client=new ArchiveWorkshopClient(dir.toFile(),(url,cookie,limit)->{
                calls.add(url);if(url.endsWith("/api/me/")){assertEquals("synthetic-session",cookie);return wrap(new JSONObject().put("user",JSONObject.NULL));}
                assertNull(cookie);return wrap(new JSONObject().put("page",1).put("pages",1).put("total",1).put("items",new JSONArray().put(item())));
            });
            assertEquals(1,client.list("characters","",1).items.size());assertEquals(1,client.cached("characters","",1).items.size());
            assertFalse(client.authorized("synthetic-session"));assertFalse(client.authorized(null));
            assertEquals(1,dir.toFile().listFiles().length);assertFalse(new String(Files.readAllBytes(dir.toFile().listFiles()[0].toPath()),StandardCharsets.UTF_8).contains("synthetic-session"));assertEquals(2,calls.size());client.close();
        }finally{try(var files=Files.walk(dir)){for(Path p:files.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}}
    }
    @Test public void blockedAndExpiredAuthorizationNeverPretendSuccess()throws Exception{
        ArchiveWorkshopClient client=new ArchiveWorkshopClient(new File("unused-cache"),(url,cookie,limit)->wrap(new JSONObject().put("user",new JSONObject().put("banned",true))));
        try{client.authorized("synthetic-session");fail();}catch(IOException expected){assertEquals("MOD_ACCOUNT_BLOCKED",expected.getMessage());}
        for(int status:new int[]{401,403,302})try{ArchiveWorkshopClient.checkStatus(status);fail();}catch(IOException expected){assertEquals("MOD_LOGIN_REQUIRED",expected.getMessage());}
        try{ArchiveWorkshopClient.checkStatus(404);fail();}catch(IOException expected){assertEquals("MOD_REMOVED",expected.getMessage());}client.close();
    }
    @Test public void verifiedCopyRejectsTruncationOversizeHashAndCancellation()throws Exception{
        Path dir=Files.createTempDirectory("workshop-copy-test-");try{byte[] bytes="synthetic package bytes".getBytes(StandardCharsets.UTF_8);File file=dir.resolve("test.part").toFile();List<Integer> progress=new ArrayList<>();
            ArchiveWorkshopClient.copyVerified(new ByteArrayInputStream(bytes),bytes.length,hash(bytes),file,progress::add);assertArrayEquals(bytes,Files.readAllBytes(file.toPath()));assertEquals(Integer.valueOf(100),progress.get(progress.size()-1));
            for(long expected:new long[]{bytes.length-1,bytes.length+1})try{ArchiveWorkshopClient.copyVerified(new ByteArrayInputStream(bytes),expected,hash(bytes),file,p->{});fail();}catch(IOException error){assertEquals("MOD_SIZE",error.getMessage());}
            try{ArchiveWorkshopClient.copyVerified(new ByteArrayInputStream(bytes),bytes.length,"0".repeat(64),file,p->{});fail();}catch(IOException error){assertEquals("MOD_HASH",error.getMessage());}
            Thread.currentThread().interrupt();try{ArchiveWorkshopClient.copyVerified(new ByteArrayInputStream(bytes),bytes.length,hash(bytes),file,p->{});fail();}catch(InterruptedIOException expected){}finally{Thread.interrupted();}
        }finally{try(var files=Files.walk(dir)){for(Path p:files.sorted(Comparator.reverseOrder()).toList())Files.delete(p);}}
    }
    @Test public void malformedPaginationAndEnvelopeFailClosed()throws Exception{
        try{new ArchiveWorkshopClient.Page(new JSONObject().put("page",0).put("pages",1).put("total",1).put("items",new JSONArray()));fail();}catch(IOException expected){}
        try{ArchiveWorkshopClient.data("{\"ok\":false}".getBytes(StandardCharsets.UTF_8));fail();}catch(IOException expected){}
    }
    @Test public void connectionTimeoutIsNotPresentedAsUserCancellation(){
        String timeout=ArchiveWorkshopActivity.failureMessage(new java.net.SocketTimeoutException());
        assertTrue(timeout.contains("超时"));assertFalse(timeout.contains("已取消"));
        assertTrue(ArchiveWorkshopActivity.failureMessage(new InterruptedIOException()).contains("已取消"));
        assertTrue(ArchiveWorkshopActivity.failureMessage(new IOException("MOD_LOGIN_REQUIRED")).contains("重新授权"));
    }
}
