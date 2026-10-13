package org.nebula.horizon.composeai.ctf;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/** Pure presentation policy; rotation never opens, reloads or writes a story. */
final class ArchiveOrientationPolicy {
    static final class Resolution {
        final int orientation;
        final boolean immersive;
        Resolution(int orientation,boolean immersive){this.orientation=orientation;this.immersive=immersive;}
    }
    private Resolution before;
    boolean active(){return before!=null;}
    Resolution update(boolean game,int requested,boolean immersive,int landscape){
        if(game){if(before==null)before=new Resolution(requested,immersive);return new Resolution(landscape,true);}
        Resolution restore=before;before=null;return restore;
    }
    static boolean isGameUrl(String base,String value){
        if(value==null||!SafeUrls.isTrustedNavigation(base,value))return false;
        try{
            URI uri=URI.create(value);
            if("/app/visual-novel.html".equals(uri.getPath()))return true;
            if(!"/app/chat.html".equals(uri.getPath())||uri.getRawQuery()==null)return false;
            String game=null,presentation=null;
            for(String part:uri.getRawQuery().split("&")){
                String[] pair=part.split("=",2);
                String key=URLDecoder.decode(pair[0],StandardCharsets.UTF_8.name());
                String val=pair.length>1?URLDecoder.decode(pair[1],StandardCharsets.UTF_8.name()):"";
                if("vn_game".equals(key)){if(game!=null)return false;game=val;}
                if("presentation".equals(key)){if(presentation!=null)return false;presentation=val;}
            }
            return "archive_vn".equals(presentation)&&game!=null&&game.matches("[A-Za-z0-9_-]{1,128}");
        }catch(Exception ignored){return false;}
    }
}
