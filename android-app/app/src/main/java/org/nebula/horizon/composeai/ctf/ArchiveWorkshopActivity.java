package org.nebula.horizon.composeai.ctf;

import android.app.*;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.webkit.*;
import android.widget.*;
import android.view.ViewGroup;
import org.json.*;
import java.io.*;
import java.net.URI;
import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;

/** Separate third-party WebView: no Homer bridge, cache interceptor or injected account. */
public final class ArchiveWorkshopActivity extends Activity {
    private WebView browser;
    private TextView status;
    private Button cancel;
    private Thread download;
    private volatile boolean closed;
    private volatile HttpURLConnection connection;
    private final Pattern detail=Pattern.compile("^/mods/([a-f0-9-]{36})/$"),revision=Pattern.compile("^/download/([a-f0-9-]{36})/$");
    private Button toolbarButton(String label){
        Button button=new Button(this);button.setText(label);button.setTextSize(13);button.setAllCaps(false);
        button.setTextColor(Color.rgb(223,238,249));button.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        button.setMinHeight((int)(44*getResources().getDisplayMetrics().density));
        GradientDrawable background=new GradientDrawable();background.setColor(Color.rgb(40,57,71));background.setCornerRadius(8*getResources().getDisplayMetrics().density);
        button.setBackground(background);button.setPadding(16,8,16,8);return button;
    }
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(25,34,43));
        LinearLayout bar=new LinearLayout(this);bar.setGravity(android.view.Gravity.CENTER_VERTICAL);bar.setPadding(8,8,8,8);
        Button back=toolbarButton("返回");back.setOnClickListener(v->finish());bar.addView(back);
        status=new TextView(this);status.setTextColor(Color.WHITE);status.setTextSize(13);status.setPadding(12,8,12,8);status.setText("角色工坊 · 独立站点登录 · 仅下载你选择的素材");
        bar.addView(status,new LinearLayout.LayoutParams(0,ViewGroup.LayoutParams.WRAP_CONTENT,1));
        cancel=toolbarButton("取消下载");cancel.setVisibility(android.view.View.GONE);cancel.setOnClickListener(v->cancelDownload());bar.addView(cancel);root.addView(bar);
        browser=new WebView(this);WebSettings settings=browser.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser,false);
        browser.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return !trusted(request.getUrl().toString());}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())status.setText("工坊暂时无法连接，请返回后重试。已有存档未改变。");}
        });
        browser.setDownloadListener((url,agent,disposition,mime,size)->requestDownload(url));
        root.addView(browser,new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,0,1));setContentView(root);
        String resource=getIntent().getStringExtra("resource");
        String savedRevision=getIntent().getStringExtra("revision"),savedSha=getIntent().getStringExtra("sha256");
        if(resource!=null&&savedRevision!=null&&savedRevision.matches("[a-f0-9-]{36}")&&savedSha!=null&&savedSha.matches("[a-f0-9]{64}")){
            Button restore=toolbarButton("下载存档使用的版本");
            restore.setOnClickListener(v->{if(download!=null||closed)return;
                new AlertDialog.Builder(this).setTitle("恢复人物素材")
                    .setMessage("先登录工坊，再下载此存档原本使用的版本。素材缺失不会删除剧情；若旧版本已下架，将保留存档，不会用新版替换。")
                    .setNegativeButton("取消",null).setPositiveButton("下载",(dialog,which)->{
                        try{JSONObject descriptor=new JSONObject().put("resource_id",resource).put("revision_id",savedRevision).put("sha256",savedSha).put("size",-1);
                            startDownload(ArchiveWorkshopStore.ORIGIN+"/download/"+savedRevision+"/",CookieManager.getInstance().getCookie(ArchiveWorkshopStore.ORIGIN+"/"),descriptor);
                        }catch(JSONException invalid){showFailure(invalid);}
                    }).show();
            });
            root.addView(restore,1);status.setText("恢复人物素材 · 工坊需单独登录");
        }
        browser.loadUrl(ArchiveWorkshopStore.ORIGIN+(resource!=null&&resource.matches("[a-f0-9-]{36}")?"/mods/"+resource+"/":"/characters/"));
    }
    static boolean trusted(String value){try{URI uri=URI.create(value);return "https".equals(uri.getScheme())&&"chatarchivemods.org".equals(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getRawUserInfo()==null;}catch(Exception invalid){return false;}}
    private void requestDownload(String url){
        if(closed||download!=null||!trusted(url))return;
        try{
            URI link=URI.create(url),page=URI.create(browser.getUrl());Matcher file=revision.matcher(link.getPath()),resource=detail.matcher(page.getPath());
            if(!trusted(page.toString())||!file.matches()||!resource.matches()||link.getRawQuery()!=null)throw new IOException("MOD_DOWNLOAD_IDENTITY");
            String resourceId=resource.group(1),revisionId=file.group(1);
            // The cookie is read only for the declared third-party origin. Never copy Homer cookies.
            String cookie=CookieManager.getInstance().getCookie(ArchiveWorkshopStore.ORIGIN+"/");
            download=new Thread(()->{
                try{
                    JSONObject envelope=new JSONObject(readPublic(ArchiveWorkshopStore.ORIGIN+"/api/resources/"+resourceId+"/"));
                    JSONObject data=envelope.getJSONObject("data"),metadata=data.getJSONObject("file");
                    if(!envelope.getBoolean("ok")||!revisionId.equals(metadata.getString("revision_id")))throw new IOException("MOD_REVISION_CHANGED");
                    String savedRevision=getIntent().getStringExtra("revision"),savedSha=getIntent().getStringExtra("sha256");
                    if(resourceId.equals(getIntent().getStringExtra("resource")) && savedRevision!=null
                       && (!savedRevision.equals(revisionId)||!metadata.getString("sha256").equals(savedSha)))throw new IOException("MOD_REVISION_CHANGED");
                    JSONObject descriptor=new JSONObject().put("resource_id",resourceId).put("revision_id",revisionId)
                        .put("sha256",metadata.getString("sha256")).put("size",metadata.getLong("size"));
                    if(descriptor.getLong("size")<1||descriptor.getLong("size")>ArchiveModPackage.MAX_FILE)throw new IOException("MOD_SIZE");
                    runOnUiThread(()->{if(!closed)new AlertDialog.Builder(this).setTitle("下载到本机")
                        .setMessage(metadata.optString("name","角色素材")+"\n"+String.format(java.util.Locale.ROOT,"%.1f MB",descriptor.optLong("size")/1000000.0)+"\n素材与存档独立保存。下载不会创建故事或生成内容。")
                        .setNegativeButton("取消",(dialog,which)->download=null)
                        .setPositiveButton("下载",(dialog,which)->startDownload(url,cookie,descriptor)).setOnCancelListener(dialog->download=null).show();});
                }catch(Exception error){showFailure(error);}
            },"archive-workshop-metadata");download.start();
        }catch(Exception error){showFailure(error);}
    }
    private HttpURLConnection connect(String url,String cookie)throws Exception{
        if(!trusted(url))throw new IOException("MOD_ORIGIN");
        HttpURLConnection request=(HttpURLConnection)new URL(url).openConnection();connection=request;
        request.setInstanceFollowRedirects(false);request.setConnectTimeout(15000);request.setReadTimeout(30000);
        request.setRequestProperty("Accept","application/json, application/octet-stream");if(cookie!=null&&!cookie.isEmpty())request.setRequestProperty("Cookie",cookie);
        int code=request.getResponseCode();if(code!=200){request.disconnect();throw new IOException(code==302||code==401||code==403?"MOD_LOGIN_REQUIRED":"MOD_HTTP");}return request;
    }
    private String readPublic(String url)throws Exception{
        HttpURLConnection request=connect(url,null);
        try(InputStream input=request.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int read;while((read=input.read(buffer))!=-1){if(output.size()+read>1024*1024)throw new IOException("MOD_METADATA_LIMIT");output.write(buffer,0,read);}
            return output.toString(StandardCharsets.UTF_8.name());
        }finally{request.disconnect();}
    }
    private void startDownload(String url,String cookie,JSONObject descriptor){
        if(closed)return;cancel.setVisibility(android.view.View.VISIBLE);status.setText("正在下载 · 0%");
        download=new Thread(()->{
            File temporary=null;HttpURLConnection request=null;
            try{
                long expected=descriptor.getLong("size");if(getFilesDir().getUsableSpace()<ArchiveModPackage.MAX_EXPANDED+Math.max(expected,ArchiveModPackage.MAX_FILE)+32*1024*1024)throw new IOException("MOD_NO_SPACE");
                temporary=File.createTempFile("archive-download-",".part",getCacheDir());request=connect(url,cookie);
                // A saved immutable revision may no longer be the detail page's
                // current file. Its saved SHA pins identity; a bounded transport
                // size is taken from this same-origin response, never guessed.
                if(expected==-1){expected=request.getContentLengthLong();if(expected<1||expected>ArchiveModPackage.MAX_FILE)throw new IOException("MOD_SIZE");descriptor.put("size",expected);}
                String content=request.getContentType();if(content!=null&&content.contains("text/html"))throw new IOException("MOD_LOGIN_REQUIRED");
                try(InputStream input=request.getInputStream();FileOutputStream output=new FileOutputStream(temporary)){
                    byte[] buffer=new byte[16384];long copied=0;int read,last=-1;
                    while((read=input.read(buffer))!=-1){if(closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException();if((copied+=read)>expected)throw new IOException("MOD_SIZE");output.write(buffer,0,read);
                        int percent=(int)(copied*100/expected);if(percent!=last){last=percent;runOnUiThread(()->{if(!closed)status.setText("正在下载 · "+percent+"%");});}}
                    if(copied!=expected)throw new IOException("MOD_SIZE");output.getFD().sync();
                }
                if(closed||Thread.currentThread().isInterrupted())throw new InterruptedIOException();
                runOnUiThread(()->{if(!closed)status.setText("下载完成，正在校验素材…");});
                new ArchiveWorkshopStore(this).install(temporary,descriptor);
                runOnUiThread(()->{if(!closed){cancel.setVisibility(android.view.View.GONE);status.setText("已下载 · 返回剧场 → 新故事 → 已下载的工坊人物");download=null;}});
            }catch(Exception error){showFailure(error);}finally{if(request!=null)request.disconnect();if(temporary!=null)temporary.delete();}
        },"archive-workshop-download");download.start();
    }
    private void showFailure(Exception error){
        String code=error.getMessage();final String message=error instanceof InterruptedIOException?"下载已取消，已有素材和故事未改变。"
            :"MOD_LOGIN_REQUIRED".equals(code)?"请先登录工坊，再点击下载。"
            :"MOD_FORMAT_UNSUPPORTED".equals(code)||"MOD_NO_CAPK".equals(code)?"此包暂不支持直接导入，请选择 CAPK 或含 CAPK 的 ZIP；已有存档未改变。"
            :"MOD_NO_SPACE".equals(code)?"手机空间不足，请释放空间后重试。"
            :"MOD_REVISION_CHANGED".equals(code)?"这不是存档使用的版本，请点上方下载存档版本；若已下架，存档仍保留。"
            :"下载或校验未完成，已有素材和故事未改变，请重试。";
        runOnUiThread(()->{if(!closed){status.setText(message);cancel.setVisibility(android.view.View.GONE);download=null;}});
    }
    private void cancelDownload(){Thread worker=download;if(worker!=null)worker.interrupt();HttpURLConnection request=connection;if(request!=null)request.disconnect();}
    @Override public void onBackPressed(){if(browser!=null&&browser.canGoBack())browser.goBack();else super.onBackPressed();}
    @Override public void onDestroy(){closed=true;cancelDownload();if(browser!=null){browser.stopLoading();browser.destroy();}super.onDestroy();}
}
