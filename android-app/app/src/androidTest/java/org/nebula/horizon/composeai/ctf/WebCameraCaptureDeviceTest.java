package org.nebula.horizon.composeai.ctf;

import android.app.Activity;
import android.app.Application;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import static org.junit.Assert.*;

/** Private synthetic camera output; no sensor, account, formal APIs or photos. */
public final class WebCameraCaptureDeviceTest {
    private final Instrumentation test = InstrumentationRegistry.getInstrumentation();
    private HomerActivity host;
    private WebView view;
    private Object token;
    private Uri[] result;
    private int completions;

    private Object get(String name) throws Exception { Field f=HomerActivity.class.getDeclaredField(name);f.setAccessible(true);return f.get(host); }
    private void set(String name,Object value) throws Exception { Field f=HomerActivity.class.getDeclaredField(name);f.setAccessible(true);f.set(host,value); }
    private void call(String name,Class<?>[] types,Object... args) throws Exception {Method m=HomerActivity.class.getDeclaredMethod(name,types);m.setAccessible(true);m.invoke(host,args);}
    private void main(ThrowingRunnable action) {test.runOnMainSync(()->{try{action.run();}catch(Exception e){throw new RuntimeException(e);}});}
    private interface ThrowingRunnable {void run() throws Exception;}

    private void open() throws Exception {
        Application app=(Application)test.getTargetContext().getApplicationContext();
        Application.ActivityLifecycleCallbacks isolate=new Application.ActivityLifecycleCallbacks(){
            public void onActivityCreated(Activity a,Bundle b){if(!(a instanceof HomerActivity))return;host=(HomerActivity)a;try{
                ((Handler)get("readinessHandler")).removeCallbacksAndMessages(null);
                for(String name:new String[]{"liveView","snapshotView"}){WebView original=(WebView)get(name);if(original==null)continue;original.stopLoading();original.removeJavascriptInterface("HomerNative");original.setWebViewClient(new WebViewClient(){
                    public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
                });}
            }catch(Exception e){throw new RuntimeException(e);}}
            public void onActivityStarted(Activity a){}public void onActivityResumed(Activity a){}public void onActivityPaused(Activity a){}public void onActivityStopped(Activity a){}public void onActivitySaveInstanceState(Activity a,Bundle b){}public void onActivityDestroyed(Activity a){}
        };
        app.registerActivityLifecycleCallbacks(isolate);
        try{host=(HomerActivity)test.startActivitySync(new Intent(test.getTargetContext(),HomerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));}
        finally{app.unregisterActivityLifecycleCallbacks(isolate);}
        CountDownLatch loaded=new CountDownLatch(1);
        main(()->{
            view=new WebView(host);view.setWebViewClient(new WebViewClient(){
                public void onPageFinished(WebView v,String u){loaded.countDown();}
                public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){return new WebResourceResponse("text/html","UTF-8",new ByteArrayInputStream("<p>Isolated capture</p>".getBytes(java.nio.charset.StandardCharsets.UTF_8)));}
            });
            host.setContentView(view);view.loadUrl(BuildConfig.SERVER_BASE_URL+"app/chat.html?qa-camera=1");
        });
        assertTrue(loaded.await(10,TimeUnit.SECONDS));
        main(()->{token=new Object();set("liveView",view);set("availableAccountOwner","qa-camera");((Map<WebView,Object>)get("liveDocumentTokens")).put(view,token);});
    }

    private void prepareCallback() throws Exception {
        main(()->{result=null;completions=0;set("fileChooserCallback",(ValueCallback<Uri[]>)value->{result=value;completions++;});
            set("fileChooserSource",view);set("fileChooserDocument",token);set("fileChooserOwner","qa-camera");set("fileChooserUrl",view.getUrl());
        });
    }

    @Test public void captureInputLaunchesCameraNotGallery() throws Exception {
        open();CountDownLatch returned=new CountDownLatch(1);int[] launches={0};WebCameraCapture[] output={null};
        String packageName=test.getTargetContext().getPackageName();
        boolean alreadyGranted=test.getTargetContext().checkSelfPermission(android.Manifest.permission.CAMERA)==android.content.pm.PackageManager.PERMISSION_GRANTED;
        Bundle permissionState=new Bundle();permissionState.putString("qa_camera_permission_was_granted",String.valueOf(alreadyGranted));test.sendStatus(0,permissionState);
        Instrumentation.ActivityMonitor monitor=new Instrumentation.ActivityMonitor(){
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent){
                if(!MediaStore.ACTION_IMAGE_CAPTURE.equals(intent.getAction()))return null;
                launches[0]++;
                try {
                    output[0]=(WebCameraCapture)get("cameraCapture");
                    try(java.io.OutputStream stream=host.getContentResolver().openOutputStream(intent.getParcelableExtra(MediaStore.EXTRA_OUTPUT))){stream.write(new byte[]{5,6,7});}
                }catch(Exception e){throw new RuntimeException(e);}
                return new Instrumentation.ActivityResult(Activity.RESULT_OK,null);
            }
        };
        test.addMonitor(monitor);
        try {
            if(!alreadyGranted)try(android.os.ParcelFileDescriptor descriptor=test.getUiAutomation().executeShellCommand("pm grant "+packageName+" android.permission.CAMERA");java.io.InputStream input=new android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)){input.readAllBytes();}
            main(()->{
                java.lang.reflect.Constructor<?> constructor=Class.forName(HomerActivity.class.getName()+"$LiveChromeClient").getDeclaredConstructor(HomerActivity.class);constructor.setAccessible(true);
                WebChromeClient chrome=(WebChromeClient)constructor.newInstance(host);
                WebChromeClient.FileChooserParams params=new WebChromeClient.FileChooserParams(){
                    public int getMode(){return MODE_OPEN;}public String[] getAcceptTypes(){return new String[]{"image/*"};}public boolean isCaptureEnabled(){return true;}
                    public CharSequence getTitle(){return null;}public String getFilenameHint(){return null;}
                    public Intent createIntent(){throw new AssertionError("Capture must not use the gallery picker");}
                };
                assertTrue(chrome.onShowFileChooser(view,value->{result=value;returned.countDown();},params));
            });
            assertTrue("Camera result callback",returned.await(10,TimeUnit.SECONDS));assertEquals(1,launches[0]);assertNotNull(result);assertEquals(output[0].uri,result[0]);
            try(java.io.InputStream input=host.getContentResolver().openInputStream(result[0])){assertArrayEquals(new byte[]{5,6,7},input.readAllBytes());}
        } finally {
            test.removeMonitor(monitor);
            main(()->{if(output[0]!=null&&output[0].file.exists())output[0].file.delete();view.destroy();host.finish();});
            // The external test driver restores a previously denied permission
            // after instrumentation finishes; revoking it here kills this runner.
        }
    }

    @Test public void fullPhotoResultCancelAndLateScopeAreBounded() throws Exception {
        open();WebCameraCapture[] capture={null};
        try {
            prepareCallback();
            main(()->{
                capture[0]=WebCameraCapture.create(host);set("cameraCapture",capture[0]);set("fileChooserInFlight",true);
                Intent intent=capture[0].intent();assertEquals(MediaStore.ACTION_IMAGE_CAPTURE,intent.getAction());
                assertEquals(capture[0].uri,intent.getParcelableExtra(MediaStore.EXTRA_OUTPUT));
                assertEquals(capture[0].uri,intent.getClipData().getItemAt(0).getUri());
                assertTrue((intent.getFlags()&Intent.FLAG_GRANT_WRITE_URI_PERMISSION)!=0);
                // Full file in the real private FileProvider, not a thumbnail
                // from Intent extras. The platform camera boundary is synthetic.
                try(java.io.OutputStream output=host.getContentResolver().openOutputStream(capture[0].uri)){output.write(new byte[]{1,2,3,4});}
                call("onActivityResult",new Class<?>[]{int.class,int.class,Intent.class},704,Activity.RESULT_OK,null);
            });
            assertEquals(1,completions);assertArrayEquals(new Uri[]{capture[0].uri},result);
            try(java.io.InputStream input=host.getContentResolver().openInputStream(result[0])){assertArrayEquals(new byte[]{1,2,3,4},input.readAllBytes());}
            // Only delete this exact synthetic fixture file, never user media.
            assertTrue(capture[0].file.delete());
            prepareCallback();
            main(()->{capture[0]=WebCameraCapture.create(host);set("cameraCapture",capture[0]);set("fileChooserInFlight",true);
                call("onActivityResult",new Class<?>[]{int.class,int.class,Intent.class},704,Activity.RESULT_CANCELED,null);});
            assertEquals(1,completions);assertNull(result);assertFalse(capture[0].file.exists());
            prepareCallback();
            main(()->{capture[0]=WebCameraCapture.create(host);set("cameraCapture",capture[0]);set("fileChooserInFlight",true);
                try(java.io.OutputStream output=host.getContentResolver().openOutputStream(capture[0].uri)){output.write(1);}
                ((Map<WebView,Object>)get("liveDocumentTokens")).put(view,new Object());
                call("onActivityResult",new Class<?>[]{int.class,int.class,Intent.class},704,Activity.RESULT_OK,null);});
            assertEquals(1,completions);assertNull(result);assertFalse(capture[0].file.exists());
            prepareCallback();
            main(()->{call("onRequestPermissionsResult",new Class<?>[]{int.class,String[].class,int[].class},705,new String[]{android.Manifest.permission.CAMERA},new int[]{android.content.pm.PackageManager.PERMISSION_DENIED});});
            assertEquals(1,completions);assertNull(result);
        } finally {main(()->{if(capture[0]!=null&&capture[0].file.exists())capture[0].file.delete();view.destroy();host.finish();});}
    }
}
