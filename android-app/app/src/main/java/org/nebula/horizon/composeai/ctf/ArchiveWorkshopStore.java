package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.net.Uri;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Immutable, on-demand workshop resources. Never contains account saves or cookies. */
final class ArchiveWorkshopStore {
    static final String ORIGIN="https://chatarchivemods.org";
    static final String PREFIX="/media-cache/card-assets/ready/archive-workshop/";
    private final File root;
    ArchiveWorkshopStore(Context context){root=new File(context.getFilesDir(),"archive-workshop");}
    ArchiveWorkshopStore(File root){this.root=root;}
    private static String required(JSONObject object,String field,String pattern)throws Exception{
        String value=object.getString(field);if(!value.matches(pattern))throw new IOException("MOD_IDENTITY");return value;
    }
    synchronized JSONObject install(File source,JSONObject descriptor)throws Exception{
        String sha=required(descriptor,"sha256","[a-f0-9]{64}"),revision=required(descriptor,"revision_id","[a-f0-9-]{36}"),resource=required(descriptor,"resource_id","[a-f0-9-]{36}");
        long expected=descriptor.getLong("size");
        if(expected<1||expected>ArchiveModPackage.MAX_FILE||source.length()!=expected)throw new IOException("MOD_SIZE");
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(InputStream input=new FileInputStream(source)){byte[] buffer=new byte[16384];int read;while((read=input.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");digest.update(buffer,0,read);}}
        StringBuilder actual=new StringBuilder();for(byte b:digest.digest())actual.append(String.format(Locale.ROOT,"%02x",b&255));
        if(!actual.toString().equals(sha))throw new IOException("MOD_HASH");
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("MOD_DIRECTORY");
        File destination=new File(root,sha);
        if(new File(destination,"catalog.json").isFile())return readCatalog(destination);
        File stage=Files.createTempDirectory(root.toPath(),"install-").toFile();
        try{
            List<JSONObject> manifests=ArchiveModPackage.unpack(source,stage);JSONArray roles=new JSONArray();
            for(int index=0;index<manifests.size();index++){
                JSONObject manifest=manifests.get(index),person=manifest.getJSONObject("role");
                String uid=required(person,"role_uid","[a-zA-Z0-9_-]{1,64}");
                String id="mod-"+revision+"-"+index;
                JSONArray spines=manifest.getJSONArray("spines"),variants=new JSONArray();String preview="";
                for(int j=0;j<spines.length();j++){
                    JSONObject spine=spines.getJSONObject(j);String folder="files/"+j+"/",base=PREFIX+sha+"/role-"+index+"/"+folder;
                    String skeleton=asset(stage,index,folder+spine.getString("skeleton_file"));
                    String atlas=asset(stage,index,folder+spine.getString("atlas_file"));
                    JSONArray textures=spine.getJSONArray("texture_files"),urls=new JSONArray();
                    for(int k=0;k<textures.length();k++)urls.put(base+asset(stage,index,folder+textures.getString(k)));
                    validateAtlas(new File(new File(stage,"role-"+index),folder+spine.getString("atlas_file")),textures);
                    String avatar=spine.optString("avatar_file");if(!avatar.isEmpty()&&preview.isEmpty())preview=base+asset(stage,index,folder+avatar);
                    variants.put(new JSONObject().put("id",String.valueOf(j)).put("label",spine.optString("appearance_title",spine.optString("display_name","装束 "+(j+1))))
                        .put("skeleton",base+skeleton).put("atlas",base+atlas).put("textures",urls)
                        .put("animations",spine.optJSONArray("animation_names")==null?new JSONArray():spine.getJSONArray("animation_names"))
                        .put("emotionNames",spine.optJSONArray("emotion_names")==null?new JSONArray():spine.getJSONArray("emotion_names"))
                        .put("spineVersion","4.2").put("binary",spine.optBoolean("binary_skeleton",true)));
                }
                if(variants.length()==0||person.optString("name").trim().isEmpty())throw new IOException("MOD_PROFILE");
                JSONObject reference=new JSONObject().put("resourceId",resource).put("revisionId",revision).put("sha256",sha).put("roleUid",uid);
                roles.put(new JSONObject().put("id",id).put("name",person.getString("name")).put("aliases",new JSONArray()).put("academy",person.optString("organization"))
                    .put("profile",person.optString("private_setting")).put("signature",person.optString("signature")).put("preview",preview)
                    .put("defaultVariant","0").put("variants",variants).put("source",reference)
                    .put("appearanceProfiles",manifest.optJSONArray("appearance_profiles")).put("emotionMappings",manifest.optJSONArray("emotion_mappings")));
            }
            JSONObject catalog=new JSONObject().put("version",1).put("source",descriptor).put("roles",roles);
            try(FileOutputStream output=new FileOutputStream(new File(stage,"catalog.json"))){output.write(catalog.toString().getBytes(StandardCharsets.UTF_8));output.getFD().sync();}
            if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("MOD_CANCELLED");
            Files.move(stage.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);
            return catalog;
        }finally{if(stage.exists())removeStage(stage);}
    }
    private static String asset(File stage,int index,String name)throws IOException{
        if(!ArchiveModPackage.dataFile(name)||!new File(new File(stage,"role-"+index),name).isFile())throw new IOException("MOD_ASSET_MISSING");
        return name.substring(name.lastIndexOf('/')+1);
    }
    private static void validateAtlas(File atlas,JSONArray textures)throws Exception{
        if(atlas.length()>2*1024*1024)throw new IOException("MOD_ATLAS_LIMIT");
        Set<String> names=new HashSet<>();for(int i=0;i<textures.length();i++){String name=textures.getString(i);if(!ArchiveModPackage.safePath(name)||name.contains("/"))throw new IOException("MOD_ATLAS_PATH");names.add(name);}
        List<String> lines=Files.readAllLines(atlas.toPath(),StandardCharsets.UTF_8);boolean page=true;int count=0;
        for(String line:lines){String trimmed=line.trim();if(trimmed.isEmpty()){page=true;continue;}
            if(page){if(!names.contains(trimmed))throw new IOException("MOD_ATLAS_PATH");count++;page=false;}}
        if(count==0)throw new IOException("MOD_ATLAS_PATH");
    }
    private static JSONObject readCatalog(File directory)throws Exception{
        File file=new File(directory,"catalog.json");if(file.length()>2*1024*1024)throw new IOException("MOD_CATALOG_LIMIT");
        return new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
    }
    synchronized String catalog(){
        JSONArray roles=new JSONArray();File[] folders=root.listFiles();if(folders!=null)for(File folder:folders){
            if(!folder.getName().matches("[a-f0-9]{64}"))continue;
            try{JSONArray list=readCatalog(folder).getJSONArray("roles");for(int i=0;i<list.length();i++)roles.put(list.getJSONObject(i));}catch(Exception invalid){/* Incomplete packages are never selectable. */}
        }
        try { return new JSONObject().put("version",1).put("roles",roles).toString(); }
        catch(JSONException invalid) { return "{\"version\":1,\"roles\":[]}"; }
    }
    WebResourceResponse intercept(WebResourceRequest request){
        Uri uri=request.getUrl();String path=uri.getPath();
        if(!"GET".equals(request.getMethod())||!SafeUrls.isTrustedNavigation(BuildConfig.SERVER_BASE_URL,uri.toString())||path==null||!path.startsWith(PREFIX))return null;
        try{
            String relative=path.substring(PREFIX.length());String[] parts=relative.split("/",2);
            if(parts.length!=2||!parts[0].matches("[a-f0-9]{64}")||!ArchiveModPackage.dataFile(parts[1]))throw new IOException("MOD_PATH");
            File directory=new File(root,parts[0]),file=new File(directory,parts[1]);
            if(!new File(directory,"catalog.json").isFile()||!file.getCanonicalPath().startsWith(directory.getCanonicalPath()+File.separator)||!file.isFile())throw new IOException("MOD_MISSING");
            Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","private, max-age=31536000, immutable");headers.put("X-Content-Type-Options","nosniff");
            return new WebResourceResponse(ClientAssetStore.mimeType(path),null,200,"OK",headers,new FileInputStream(file));
        }catch(Exception invalid){return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream("Local workshop media unavailable".getBytes(StandardCharsets.UTF_8)));}
    }
    private void removeStage(File directory)throws IOException{
        if(!directory.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator)||!directory.getName().startsWith("install-"))throw new IOException("MOD_PATH");
        try(var paths=Files.walk(directory.toPath())){Iterator<Path> iterator=paths.sorted(Comparator.reverseOrder()).iterator();while(iterator.hasNext())Files.deleteIfExists(iterator.next());}
    }
}
