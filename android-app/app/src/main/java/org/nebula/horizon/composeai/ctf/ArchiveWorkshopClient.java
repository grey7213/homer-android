package org.nebula.horizon.composeai.ctf;

import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Public catalog and origin-scoped transport. Never receives a Homer account. */
final class ArchiveWorkshopClient implements Closeable {
    static final String ORIGIN = ArchiveWorkshopStore.ORIGIN;
    static final int MAX_JSON = 2 * 1024 * 1024;
    static final String UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    interface Progress { void update(int percent); }
    interface Transport { byte[] get(String url, String cookie, int limit) throws Exception; }
    private final File cache;
    private final Transport transport;
    private final Set<HttpURLConnection> active = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;

    ArchiveWorkshopClient(File cache) { this.cache=cache; this.transport=this::readNetwork; }
    ArchiveWorkshopClient(File cache, Transport transport) { this.cache=cache; this.transport=transport; }

    static boolean trusted(String value) {
        try { URI u=URI.create(value); return "https".equals(u.getScheme())
            && "chatarchivemods.org".equals(u.getHost()) && (u.getPort()==-1||u.getPort()==443)
            && u.getRawUserInfo()==null && u.getFragment()==null; }
        catch (RuntimeException invalid) { return false; }
    }
    static String query(String category, String search, int page) throws Exception {
        if (!Arrays.asList("characters","presets").contains(category) || page<1 || page>10000)
            throw new IOException("MOD_QUERY");
        String q=search==null?"":search.trim(); if(q.length()>120)throw new IOException("MOD_QUERY");
        return "/api/resources/?category="+category+"&page="+page+"&q="+URLEncoder.encode(q,StandardCharsets.UTF_8.name());
    }
    static String preview(String path) {
        if(path==null||path.isEmpty())return "";
        String url=path.startsWith("/")?ORIGIN+path:path;
        try { URI u=URI.create(url); return trusted(url)&&u.getPath().matches("/preview/"+UUID+"/")
            && (u.getRawQuery()==null||"size=card".equals(u.getRawQuery())) ?url:""; }
        catch(RuntimeException invalid){return "";}
    }
    static int errorStatus(int status) { return status==401||status==403?401:status; }
    static void checkStatus(int status) throws IOException {
        if(status==200)return;
        throw new IOException(errorStatus(status)==401||status==302?"MOD_LOGIN_REQUIRED":status==404?"MOD_REMOVED":"MOD_HTTP_"+status);
    }
    static JSONObject data(byte[] bytes) throws Exception {
        if(bytes.length>MAX_JSON)throw new IOException("MOD_METADATA_LIMIT");
        JSONObject value=new JSONObject(new String(bytes,StandardCharsets.UTF_8));
        if(!value.optBoolean("ok"))throw new IOException("MOD_API");
        return value.getJSONObject("data");
    }
    static final class Item {
        final String id,title,description,author,preview,revision,sha,name,extension,category;
        final long size;
        final int downloads;
        Item(JSONObject value) throws Exception {
            id=value.getString("id"); if(!id.matches(UUID))throw new IOException("MOD_IDENTITY");
            title=limited(value.optString("title"),180);description=limited(value.optString("description"),24000);
            JSONObject person=value.optJSONObject("author"),image=value.optJSONObject("preview"),file=value.optJSONObject("file");
            author=limited(person==null?"社区创作者":person.optString("name","社区创作者"),120);
            preview=ArchiveWorkshopClient.preview(image==null?"":image.optString("thumbnail_url",image.optString("url")));
            category="presets".equals(value.optString("category"))?"presets":"characters";
            revision=file==null?"":file.optString("revision_id");sha=file==null?"":file.optString("sha256");
            name=limited(file==null?"":file.optString("name"),180);
            extension=file==null?"":file.optString("extension").toLowerCase(Locale.ROOT);
            size=file==null?0:file.optLong("size");downloads=Math.max(0,value.optInt("download_count"));
        }
        boolean validFile(){return revision.matches(UUID)&&sha.matches("[a-f0-9]{64}")&&size>0&&size<=ArchiveModPackage.MAX_FILE;}
        boolean importable(){return "characters".equals(category)&&validFile()&&Arrays.asList("capk","zip").contains(extension);}
        boolean saveable(){return "presets".equals(category)&&validFile()&&Arrays.asList("txt","json").contains(extension);}
        JSONObject descriptor() throws JSONException { return new JSONObject().put("resource_id",id).put("revision_id",revision).put("sha256",sha).put("size",size); }
    }
    static String limited(String value,int max){return value.length()>max?value.substring(0,max):value;}
    static final class Page {
        final List<Item> items=new ArrayList<>();final int page,pages,total;
        Page(JSONObject data) throws Exception {
            page=data.getInt("page");pages=data.getInt("pages");total=data.getInt("total");
            if(page<1||pages<0||pages>10000||total<0)throw new IOException("MOD_PAGINATION");
            JSONArray list=data.getJSONArray("items");if(list.length()>100)throw new IOException("MOD_METADATA_LIMIT");
            for(int i=0;i<list.length();i++){try{items.add(new Item(list.getJSONObject(i)));}catch(Exception invalid){/* Invalid rows are never actionable. */}}
        }
    }
    Page list(String category,String search,int page) throws Exception {
        String path=query(category,search,page);byte[] bytes=transport.get(ORIGIN+path,null,MAX_JSON);
        Page parsed=new Page(data(bytes));writeCache(path,bytes);return parsed;
    }
    Page cached(String category,String search,int page) {
        try{String path=query(category,search,page);File file=cacheFile(path);if(!file.isFile()||file.length()>MAX_JSON)return null;
            return new Page(data(java.nio.file.Files.readAllBytes(file.toPath())));}catch(Exception invalid){return null;}
    }
    Item detail(String id) throws Exception {if(!id.matches(UUID))throw new IOException("MOD_IDENTITY");return new Item(data(transport.get(ORIGIN+"/api/resources/"+id+"/",null,MAX_JSON)));}
    boolean authorized(String cookie) throws Exception {
        if(cookie==null||cookie.isEmpty())return false;
        JSONObject user=data(transport.get(ORIGIN+"/api/me/",cookie,MAX_JSON)).optJSONObject("user");
        if(user==null)return false;if(user.optBoolean("banned"))throw new IOException("MOD_ACCOUNT_BLOCKED");return true;
    }
    byte[] image(String url) throws Exception {if(preview(url).isEmpty())throw new IOException("MOD_ORIGIN");return transport.get(url,null,2*1024*1024);}
    private File cacheFile(String path) throws Exception {
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8));StringBuilder name=new StringBuilder();
        for(byte b:hash)name.append(String.format(Locale.ROOT,"%02x",b&255));return new File(cache,name+".json");
    }
    private void writeCache(String path,byte[] bytes) {
        if(closed)return;
        try{if(!cache.isDirectory()&&!cache.mkdirs())return;
            // Bounded public catalog cache; never stores cookies or /api/me responses.
            File[] old=cache.listFiles((dir,name)->name.endsWith(".json"));
            if(old!=null&&old.length>=12){Arrays.sort(old,Comparator.comparingLong(File::lastModified));old[0].delete();}
            File target=cacheFile(path),temp=File.createTempFile("catalog-",".part",cache);
            try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}
                java.nio.file.Files.move(temp.toPath(),target.toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);
            }finally{temp.delete();}
        }catch(Exception unavailable){/* Network results remain usable without cache. */}
    }
    private HttpURLConnection connect(String url,String cookie) throws Exception {
        if(closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");
        if(!trusted(url))throw new IOException("MOD_ORIGIN");
        HttpURLConnection request=(HttpURLConnection)new URL(url).openConnection();active.add(request);
        try{request.setInstanceFollowRedirects(false);request.setConnectTimeout(10000);request.setReadTimeout(20000);
            if(closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");
            request.setRequestProperty("Accept","application/json, application/octet-stream, image/*");
            if(cookie!=null&&!cookie.isEmpty())request.setRequestProperty("Cookie",cookie);
            checkStatus(request.getResponseCode());return request;
        }catch(Exception error){active.remove(request);request.disconnect();throw error;}
    }
    private byte[] readNetwork(String url,String cookie,int limit) throws Exception {
        HttpURLConnection request=connect(url,cookie);
        try(InputStream input=request.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))!=-1){if(closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");
                if(out.size()+n>limit)throw new IOException("MOD_METADATA_LIMIT");out.write(buffer,0,n);}return out.toByteArray();
        }finally{active.remove(request);request.disconnect();}
    }
    void download(JSONObject descriptor,String cookie,File output,Progress progress) throws Exception {
        String revision=descriptor.getString("revision_id"),resource=descriptor.getString("resource_id"),sha=descriptor.getString("sha256");
        long expected=descriptor.getLong("size");
        if(!revision.matches(UUID)||!resource.matches(UUID)||!sha.matches("[a-f0-9]{64}")||expected==0||expected< -1||expected>ArchiveModPackage.MAX_FILE)throw new IOException("MOD_IDENTITY");
        HttpURLConnection request=connect(ORIGIN+"/download/"+revision+"/",cookie);
        try{
            if(expected==-1){expected=request.getContentLengthLong();if(expected<1||expected>ArchiveModPackage.MAX_FILE)throw new IOException("MOD_SIZE");descriptor.put("size",expected);}
            String type=request.getContentType();if(type!=null&&type.toLowerCase(Locale.ROOT).contains("text/html"))throw new IOException("MOD_LOGIN_REQUIRED");
            try(InputStream input=request.getInputStream()){copyVerified(input,expected,sha,output,progress);}
        }finally{active.remove(request);request.disconnect();}
    }
    static void copyVerified(InputStream input,long expected,String sha,File output,Progress progress)throws Exception {
        if(expected<1||expected>ArchiveModPackage.MAX_FILE||!sha.matches("[a-f0-9]{64}"))throw new IOException("MOD_SIZE");
        MessageDigest digest=MessageDigest.getInstance("SHA-256");long copied=0;int previous=-1;
        try(FileOutputStream out=new FileOutputStream(output)){
            byte[] buffer=new byte[16384];int n;while((n=input.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");
                copied+=n;if(copied>expected)throw new IOException("MOD_SIZE");out.write(buffer,0,n);digest.update(buffer,0,n);
                int percent=(int)(copied*100/expected);if(percent!=previous){previous=percent;progress.update(percent);}}
            if(copied!=expected)throw new IOException("MOD_SIZE");out.getFD().sync();
        }
        StringBuilder actual=new StringBuilder();for(byte b:digest.digest())actual.append(String.format(Locale.ROOT,"%02x",b&255));
        if(!actual.toString().equals(sha))throw new IOException("MOD_HASH");
    }
    void cancel(){for(HttpURLConnection c:active)c.disconnect();}
    @Override public void close(){closed=true;cancel();}
}
