package org.nebula.horizon.composeai.ctf;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.*;
import android.graphics.drawable.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.core.graphics.Insets;
import androidx.core.view.*;
import org.json.*;
import java.io.*;
import java.util.concurrent.*;

/** The actual workshop website, isolated from Homer accounts and save bridges. */
public final class ArchiveWorkshopActivity extends Activity {
    private LinearLayout root,downloadBar,feedback;
    private FrameLayout body;
    private TextView notice,feedbackText,progressText;
    private Button retry;
    private ProgressBar progress;
    private WebView browser;
    private ArchiveWorkshopClient client;
    private final ExecutorService requests=Executors.newSingleThreadExecutor();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private volatile boolean closed,cancelled;
    private Thread download;
    private boolean dark,failed,metadataBusy;
    private int background,surface,foreground,secondary,accent,navigation;
    private String savedResource,savedRevision,savedSha,lastPage,loginResource,loginRevision;
    private File pendingPreset;
    private String presetName;
    private static final int SAVE_PRESET=363;
    private final Runnable timeout=()->{
        if(!closed&&!failed&&feedback.getVisibility()==View.VISIBLE)
            showFailure("工坊页面暂未显示\n请重试；若仍无法显示，请更新系统 WebView。");
    };

    private int dp(float n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private LinearLayout vertical(){LinearLayout v=new LinearLayout(this);v.setOrientation(LinearLayout.VERTICAL);return v;}
    private TextView text(String value,int size,int color,boolean bold){
        TextView v=new TextView(this);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setIncludeFontPadding(false);
        if(bold)v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return v;
    }
    private Button button(String value,boolean primary){
        Button b=new Button(this);b.setText(value);b.setTextSize(14);b.setAllCaps(false);
        b.setTextColor(primary?(dark?0xff21151b:Color.WHITE):foreground);b.setMinWidth(dp(48));b.setMinimumWidth(dp(48));
        b.setMinHeight(dp(48));b.setMinimumHeight(dp(48));b.setPadding(dp(12),dp(8),dp(12),dp(8));
        b.setStateListAnimator(null);b.setElevation(0);GradientDrawable shape=new GradientDrawable();
        shape.setColor(primary?accent:surface);shape.setCornerRadius(dp(12));
        b.setBackground(new RippleDrawable(android.content.res.ColorStateList.valueOf(dark?0x33ffffff:0x22000000),shape,null));return b;
    }
    @Override public void onCreate(Bundle state){
        dark=getIntent().hasExtra("dark")?getIntent().getBooleanExtra("dark",false):getSharedPreferences("HomerActivity",MODE_PRIVATE).getBoolean("app_theme_dark",false);
        setTheme(dark?R.style.Theme_Homer_WorkshopDark:R.style.Theme_Homer);super.onCreate(state);
        background=dark?0xff141414:0xfff5f3f7;surface=dark?0xff242424:Color.WHITE;
        foreground=dark?0xfff3f3f3:0xff242126;secondary=dark?0xffbdb5be:0xff716774;accent=dark?0xffefa7c4:0xffb83262;
        client=new ArchiveWorkshopClient(new File(getCacheDir(),"archive-public-catalog"));
        savedResource=getIntent().getStringExtra("resource");savedRevision=getIntent().getStringExtra("revision");savedSha=getIntent().getStringExtra("sha256");
        WindowCompat.setDecorFitsSystemWindows(getWindow(),false);
        root=vertical();root.setBackgroundColor(background);root.setTag("workshop-root");setContentView(root);
        WindowInsetsControllerCompat controller=WindowCompat.getInsetsController(getWindow(),root);
        controller.setAppearanceLightStatusBars(!dark);controller.setAppearanceLightNavigationBars(!dark);controller.show(WindowInsetsCompat.Type.systemBars());
        getWindow().setStatusBarColor(background);getWindow().setNavigationBarColor(background);
        ViewCompat.setOnApplyWindowInsetsListener(root,(view,insets)->{
            Insets safe=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.displayCutout());
            Insets keyboard=insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left,safe.top,safe.right,Math.max(safe.bottom,keyboard.bottom));return insets;
        });ViewCompat.requestApplyInsets(root);
        LinearLayout toolbar=new LinearLayout(this);toolbar.setGravity(Gravity.CENTER_VERTICAL);toolbar.setPadding(dp(12),dp(6),dp(12),dp(6));toolbar.setTag("workshop-toolbar");
        Button back=button("‹",false);back.setTextSize(28);back.setContentDescription("返回");back.setOnClickListener(v->onBackPressed());toolbar.addView(back,new LinearLayout.LayoutParams(dp(48),dp(48)));
        TextView title=text("角色工坊",18,foreground,true);title.setSingleLine(true);title.setPadding(dp(12),0,dp(8),0);toolbar.addView(title,new LinearLayout.LayoutParams(0,-2,1));
        Button refresh=button("刷新",false);refresh.setContentDescription("刷新工坊页面");refresh.setTag("workshop-refresh");refresh.setOnClickListener(v->reload());toolbar.addView(refresh);root.addView(toolbar);
        notice=text("",12,secondary,false);notice.setPadding(dp(16),dp(4),dp(16),dp(8));notice.setTag("workshop-notice");notice.setVisibility(View.GONE);root.addView(notice);
        if(savedReference()){
            Button restore=button("下载存档使用的版本",false);restore.setTag("workshop-restore-version");
            restore.setOnClickListener(v->requestRestore());root.addView(restore,new LinearLayout.LayoutParams(-1,dp(48)));
        }
        downloadBar=vertical();downloadBar.setPadding(dp(16),dp(4),dp(16),dp(10));downloadBar.setTag("workshop-download-bar");
        LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);progressText=text("",13,foreground,true);row.addView(progressText,new LinearLayout.LayoutParams(0,-2,1));
        Button cancel=button("取消",false);cancel.setOnClickListener(v->cancelDownload());row.addView(cancel);downloadBar.addView(row);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));downloadBar.addView(progress,new LinearLayout.LayoutParams(-1,dp(4)));
        downloadBar.setVisibility(View.GONE);root.addView(downloadBar);
        body=new FrameLayout(this);body.setBackgroundColor(surface);root.addView(body,new LinearLayout.LayoutParams(-1,0,1));
        feedback=vertical();feedback.setGravity(Gravity.CENTER);feedback.setPadding(dp(28),dp(28),dp(28),dp(28));feedback.setBackgroundColor(surface);feedback.setTag("workshop-feedback");
        feedbackText=text("正在连接角色工坊…",16,foreground,true);feedbackText.setGravity(Gravity.CENTER);feedbackText.setLineSpacing(dp(6),1);feedback.addView(feedbackText);
        retry=button("重新连接",true);retry.setTag("workshop-retry");LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(-2,dp(48));rp.topMargin=dp(20);feedback.addView(retry,rp);retry.setVisibility(View.GONE);retry.setOnClickListener(v->reload());
        createBrowser();
        lastPage=savedResource!=null&&savedResource.matches(ArchiveWorkshopClient.UUID)?ArchiveWorkshopClient.ORIGIN+"/mods/"+savedResource+"/":ArchiveWorkshopClient.ORIGIN+"/characters/";
        if(state==null||browser.restoreState(state)==null)browser.loadUrl(lastPage);
        else{lastPage=browser.getUrl();beginPage();waitForContent(browser,navigation);}
    }
    private void createBrowser(){
        browser=new WebView(this);browser.setTag("workshop-webview");browser.setBackgroundColor(surface);
        WebSettings settings=browser.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser,false);
        browser.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(!request.isForMainFrame())return false;
                String url=request.getUrl().toString();
                if(!navigationAllowed(url)){notice("此链接不属于角色工坊，未在软件内打开。");return true;}
                rememberLoginDownload(view.getUrl(),url);
                if(downloadRevision(url)!=null){requestDownload(url);return true;}return false;
            }
            @Override public void onPageStarted(WebView view,String url,Bitmap icon){
                if(!navigationAllowed(url)){view.stopLoading();showFailure("链接不属于角色工坊，已停止打开。");return;}
                lastPage=url;beginPage();
            }
            @Override public void onPageFinished(WebView view,String url){if(!failed&&view==browser)waitForContent(view,navigation);}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame()&&view==browser)showFailure("工坊暂时无法连接\n请检查网络后重试。");}
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){if(request.isForMainFrame()&&view==browser&&response.getStatusCode()>=400)showFailure("工坊暂时无法打开此页面\n请返回或重试。");}
            @Override public void onReceivedSslError(WebView view,SslErrorHandler ssl,android.net.http.SslError error){ssl.cancel();if(view==browser)showFailure("无法验证工坊的安全连接\n请检查网络和系统时间后重试。");}
            @Override public boolean onRenderProcessGone(WebView view,RenderProcessGoneDetail detail){
                if(view==browser){destroyBrowser();showFailure("工坊页面已停止运行\n点击重新连接；已有素材和故事不受影响。");}return true;
            }
        });
        browser.setDownloadListener((url,agent,disposition,mime,length)->requestDownload(url));
        body.addView(browser,0,new FrameLayout.LayoutParams(-1,-1));body.addView(feedback,new FrameLayout.LayoutParams(-1,-1));
    }
    static boolean navigationAllowed(String url){try{return ArchiveWorkshopClient.trusted(Uri.parse(url).buildUpon().fragment(null).build().toString());}catch(RuntimeException invalid){return false;}}
    static String resourceId(String url){if(!navigationAllowed(url))return null;String path=Uri.parse(url).getPath();return path!=null&&path.matches("/mods/"+ArchiveWorkshopClient.UUID+"/")?path.substring(6,path.length()-1):null;}
    static String downloadRevision(String url){if(!ArchiveWorkshopClient.trusted(url))return null;Uri parsed=Uri.parse(url);String path=parsed.getPath();return parsed.getQuery()==null&&path!=null&&path.matches("/download/"+ArchiveWorkshopClient.UUID+"/")?path.substring(10,path.length()-1):null;}
    private void beginPage(){failed=false;navigation++;handler.removeCallbacks(timeout);feedbackText.setText("正在连接角色工坊…");retry.setVisibility(View.GONE);feedback.setVisibility(View.VISIBLE);handler.postDelayed(timeout,15000);}
    private void waitForContent(WebView own,int ticket){
        if(closed||failed||browser!=own||navigation!=ticket)return;
        // Only element presence and geometry, never form values or session data.
        own.evaluateJavascript("(function(){var m=document.querySelector('main#content');return !!(m&&m.getAttribute('aria-busy')!=='true'&&m.getBoundingClientRect().height>0&&m.querySelector('a,button,input,h1,h2,[role=alert]'));})()",ready->{
            if(closed||failed||browser!=own||navigation!=ticket)return;
            if("true".equals(ready))own.postVisualStateCallback(ticket,new WebView.VisualStateCallback(){
                @Override public void onComplete(long id){if(!closed&&!failed&&browser==own&&navigation==ticket){handler.removeCallbacks(timeout);feedback.setVisibility(View.GONE);CookieManager.getInstance().flush();}}
            });else handler.postDelayed(()->waitForContent(own,ticket),250);
        });
    }
    private void showFailure(String message){failed=true;handler.removeCallbacks(timeout);feedbackText.setText(message);retry.setVisibility(View.VISIBLE);feedback.setVisibility(View.VISIBLE);}
    private void reload(){if(closed)return;if(browser==null){body.removeView(feedback);createBrowser();}browser.loadUrl(navigationAllowed(lastPage)?lastPage:ArchiveWorkshopClient.ORIGIN+"/characters/");}
    private void notice(String message){notice.setText(message);notice.setVisibility(message.isEmpty()?View.GONE:View.VISIBLE);}
    private boolean savedReference(){return savedResource!=null&&savedResource.matches(ArchiveWorkshopClient.UUID)&&savedRevision!=null&&savedRevision.matches(ArchiveWorkshopClient.UUID)&&savedSha!=null&&savedSha.matches("[a-f0-9]{64}");}
    private void requestRestore(){prepareDownload(savedResource,savedRevision,true);}
    private void rememberLoginDownload(String from,String to){
        String resource=resourceId(from);if(resource==null||!"/login/".equals(Uri.parse(to).getPath()))return;
        String next=Uri.parse(to).getQueryParameter("next");
        String revision=next==null?null:downloadRevision(next.startsWith("/")?ArchiveWorkshopClient.ORIGIN+next:next);
        if(revision!=null){loginResource=resource;loginRevision=revision;}
    }
    private void requestDownload(String url){
        String revision=downloadRevision(url),resource=browser==null?null:resourceId(browser.getUrl());
        // A successful normal site login can redirect to its `next` download.
        // Retain only the public detail identity, never credentials/form values.
        if(resource==null&&revision!=null&&revision.equals(loginRevision))resource=loginResource;
        loginResource=null;loginRevision=null;
        if(revision==null||resource==null){notice("请从工坊作品详情中选择下载。");return;}prepareDownload(resource,revision,false);
    }
    private void prepareDownload(String resource,String revision,boolean restore){
        if(closed||metadataBusy||download!=null){notice("请先完成或取消当前下载。");return;}
        metadataBusy=true;int ticket=navigation;notice("正在核对作品版本…");
        requests.execute(()->{try{
            ArchiveWorkshopClient.Item item=client.detail(resource);
            if(!restore&&!item.revision.equals(revision))throw new IOException("MOD_REMOVED");
            if(!(item.importable()||item.saveable()))throw new IOException("MOD_FORMAT_UNSUPPORTED");
            if(!restore&&savedReference()&&resource.equals(savedResource)&&(!revision.equals(savedRevision)||!item.sha.equals(savedSha)))throw new IOException("MOD_REMOVED");
            JSONObject descriptor=restore?new JSONObject().put("resource_id",savedResource).put("revision_id",savedRevision).put("sha256",savedSha).put("size",-1):item.descriptor();
            runOnUiThread(()->{metadataBusy=false;if(closed||navigation!=ticket)return;notice("");
                new AlertDialog.Builder(this).setTitle(restore?"恢复存档素材":"下载到本机")
                    .setMessage(item.title+"\n"+(restore?"下载存档绑定的原版本，不会用新版替换。":"仅下载当前作品；素材与故事存档独立保存。")+"\n下载不会创建故事或生成内容。")
                    .setNegativeButton("取消",null).setPositiveButton("下载",(dialog,which)->{if(!closed&&navigation==ticket)startDownload(item,descriptor);}).show();
            });
        }catch(Exception error){runOnUiThread(()->{metadataBusy=false;if(!closed&&navigation==ticket)notice(failureMessage(error));});}});
    }
    private void startDownload(ArchiveWorkshopClient.Item item,JSONObject descriptor){
        if(download!=null||closed)return;String auth=CookieManager.getInstance().getCookie(ArchiveWorkshopClient.ORIGIN+"/");
        cancelled=false;downloadBar.setVisibility(View.VISIBLE);progress.setProgress(0);progressText.setText("准备下载…");
        download=new Thread(()->{File temporary=null;try{
            long reserve=item.importable()?ArchiveModPackage.MAX_EXPANDED+ArchiveModPackage.MAX_FILE+32L*1024*1024:ArchiveModPackage.MAX_FILE+16L*1024*1024;
            if(getFilesDir().getUsableSpace()<reserve)throw new IOException("MOD_NO_SPACE");
            temporary=File.createTempFile("archive-download-",".part",getCacheDir());
            client.download(descriptor,auth,temporary,percent->runOnUiThread(()->{if(!closed&&!cancelled){progress.setProgress(percent);progressText.setText("正在下载 · "+percent+"%");}}));
            if(closed||cancelled||Thread.currentThread().isInterrupted())throw new InterruptedIOException();
            if(item.saveable()){
                File ready=temporary;temporary=null;runOnUiThread(()->{if(closed||cancelled){ready.delete();endDownload();return;}
                    pendingPreset=ready;presetName=item.name;endDownload();
                    Intent choose=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("json".equals(item.extension)?"application/json":"text/plain").putExtra(Intent.EXTRA_TITLE,item.name);
                    try{startActivityForResult(choose,SAVE_PRESET);}catch(ActivityNotFoundException unavailable){deletePending();notice("手机没有文件保存界面，请稍后重试。");}
                });
            }else{
                runOnUiThread(()->{if(!closed&&!cancelled)progressText.setText("正在校验和安装…");});
                new ArchiveWorkshopStore(this).install(temporary,descriptor);
                runOnUiThread(()->{if(!closed){endDownload();notice("已下载，返回剧场后可选择该人物。已有故事未改变。");}});
            }
        }catch(Exception error){runOnUiThread(()->{if(!closed){endDownload();notice(failureMessage(cancelled?new InterruptedIOException():error));}});}finally{if(temporary!=null)temporary.delete();}},"archive-workshop-download");download.start();
    }
    private void endDownload(){download=null;downloadBar.setVisibility(View.GONE);}
    private void cancelDownload(){cancelled=true;if(download!=null)download.interrupt();client.cancel();progressText.setText("正在取消…");}
    static String failureMessage(Exception e){String code=e.getMessage();return e instanceof java.net.SocketTimeoutException?"连接超时，请检查网络后重试。已有素材和故事不受影响。":e instanceof InterruptedIOException?"下载已取消，已有素材和故事未改变。":"MOD_LOGIN_REQUIRED".equals(code)?"分享站授权已失效，请在工坊页面重新授权后下载；没有安装素材。"
        :"MOD_ACCOUNT_BLOCKED".equals(code)?"分享站账号暂时没有下载权限，请在该站查看账号状态。":"MOD_NO_SPACE".equals(code)?"手机空间不足，请释放空间后重试。":"MOD_REMOVED".equals(code)?"版本可能已下架。故事保留，不会用新版替换。"
        :"MOD_FORMAT_UNSUPPORTED".equals(code)||"MOD_NO_CAPK".equals(code)?"此格式暂不支持导入；人物支持 CAPK / ZIP，预设支持 TXT / JSON。":"MOD_HASH".equals(code)?"文件校验失败，未安装。请重试。":"下载未完成，已有素材和故事未改变。请检查网络后重试。";}
    private void destroyBrowser(){if(browser==null)return;browser.stopLoading();body.removeView(browser);browser.destroy();browser=null;}
    private void deletePending(){if(pendingPreset!=null){pendingPreset.delete();pendingPreset=null;}}
    @Override protected void onActivityResult(int code,int result,Intent data){super.onActivityResult(code,result,data);if(code!=SAVE_PRESET)return;
        if(result!=RESULT_OK||data==null||data.getData()==null){deletePending();notice("已取消保存，已有素材和故事未改变。");return;}File file=pendingPreset;pendingPreset=null;if(file==null)return;Uri target=data.getData();
        requests.execute(()->{try(InputStream input=new FileInputStream(file);OutputStream out=getContentResolver().openOutputStream(target,"w")){if(out==null)throw new IOException();byte[] bytes=new byte[16384];int read;while((read=input.read(bytes))!=-1)out.write(bytes,0,read);runOnUiThread(()->{if(!closed)notice("已保存 "+presetName+"。预设未自动应用。");});}catch(Exception error){runOnUiThread(()->{if(!closed)notice("文件未能保存，请重试。");});}finally{file.delete();}});
    }
    @Override public void onBackPressed(){
        if(download!=null){new AlertDialog.Builder(this).setTitle("下载尚未完成").setMessage("返回会取消当前下载，已有素材和故事不受影响。")
            .setNegativeButton("继续下载",null).setPositiveButton("取消并返回",(d,w)->{cancelDownload();finish();}).show();return;}
        if(browser!=null&&browser.canGoBack()){browser.goBack();return;}super.onBackPressed();
    }
    @Override protected void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);if(browser!=null)browser.saveState(out);}
    @Override public void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);ViewCompat.requestApplyInsets(root);}
    @Override public void onDestroy(){closed=true;navigation++;handler.removeCallbacksAndMessages(null);if(download!=null)download.interrupt();client.close();requests.shutdownNow();destroyBrowser();deletePending();super.onDestroy();}
}
