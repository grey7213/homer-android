package org.nebula.horizon.composeai.ctf;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import org.junit.Test;
import static org.junit.Assert.*;

public class PatchUpgradeTest {
    @Test public void newApkStopsServingOldSlotsWithoutTouchingAccountData() {
        Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Context isolated = new ContextWrapper(base) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences("update_test_" + name, mode);
            }
            @Override public File getFilesDir() { return new File(super.getCacheDir(), "update_test_files"); }
        };
        SharedPreferences prefs = isolated.getSharedPreferences("homer-patches", 0);
        SharedPreferences account = isolated.getSharedPreferences("account", 0);
        try {
            prefs.edit().clear().putString("active_slot", "slot-a").putString("pending_slot", "slot-a")
                    .putString("installed_version", "old").putInt("bundled_app_version", BuildConfig.VERSION_CODE - 1).commit();
            account.edit().putString("sentinel", "preserve").commit();
            PatchManager manager = new PatchManager(isolated);
            assertEquals("file:///android_asset/offline/index.html", manager.offlineEntryUrl());
            assertFalse(prefs.contains("active_slot"));
            assertFalse(prefs.contains("pending_slot"));
            assertFalse(prefs.contains("installed_version"));
            assertEquals("preserve", account.getString("sentinel", ""));
            prefs.edit().putString("active_slot", "slot-b").commit();
            new PatchManager(isolated);
            assertEquals("slot-b", prefs.getString("active_slot", ""));
        } finally { prefs.edit().clear().commit(); account.edit().clear().commit(); }
    }
}
