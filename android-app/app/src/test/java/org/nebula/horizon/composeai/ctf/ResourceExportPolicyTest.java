package org.nebula.horizon.composeai.ctf;
import org.junit.Test;
import static org.junit.Assert.*;

public final class ResourceExportPolicyTest {
    private static final String BASE="https://example.test/";
    @Test public void editorOnlySameOriginNoRoleScriptAuthority(){
        assertTrue(ResourceExportPolicy.trustedEditor(BASE,BASE+"app/workshop-resource-editor.html?type=preset&id=qa"));
        for(String url:new String[]{BASE+"app/chat.html",BASE+"app/workshop-resource.html",BASE+"app/workshop-resource-editor.html/",BASE+"app/%77orkshop-resource-editor.html","https://evil.test/app/workshop-resource-editor.html","https://user@example.test/app/workshop-resource-editor.html","http://example.test/app/workshop-resource-editor.html","blob:"+BASE+"id"})assertFalse(url,ResourceExportPolicy.trustedEditor(BASE,url));
    }
    @Test public void boundedFileDataAndNamesOnly(){
        assertArrayEquals("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8),ResourceExportPolicy.validate("qa-1","预设.json","application/json","{}"));
        assertNotNull(ResourceExportPolicy.validate("qa-2","正则.html","text/html","<div>test</div>"));
        for(String name:new String[]{"../secret.json","folder/test.json","a\\b.json","a\n.json",".json","a.apk"," x.json","a.json "}){
            try{ResourceExportPolicy.validate("qa",name,"application/json","{}");fail(name);}catch(IllegalArgumentException expected){}
        }
        for(String mime:new String[]{"text/javascript","application/zip","image/png","application/json; charset=utf-8"}){
            try{ResourceExportPolicy.validate("qa","test.json",mime,"{}");fail(mime);}catch(IllegalArgumentException expected){}
        }
        try{ResourceExportPolicy.validate("qa","big.json","application/json","汉".repeat(ResourceExportPolicy.MAX_BYTES/3+1));fail("UTF-8 bytes are bounded");}catch(IllegalArgumentException expected){}
        try{ResourceExportPolicy.validate("bad/request","ok.json","application/json","{}");fail("request identity");}catch(IllegalArgumentException expected){}
    }
}
