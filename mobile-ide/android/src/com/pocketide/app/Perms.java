package com.pocketide.app;

import android.app.Activity;
import android.app.AppOpsManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Everything Pocket IDE needs from Android, across three apps: this app, Termux
 * and Termux:API. status(): what's granted (true/false, or null when Android
 * doesn't let us check). open(id): takes the user to the right place to grant it.
 */
final class Perms {
    static final String TERMUX = "com.termux", API = "com.termux.api", BOOT = "com.termux.boot", ME = "com.pocketide.app";
    private final Activity a;
    private final PackageManager pm;

    Perms(Activity a) { this.a = a; this.pm = a.getPackageManager(); }

    private boolean installed(String pkg) {
        try { pm.getPackageInfo(pkg, 0); return true; } catch (Exception e) { return false; }
    }

    private boolean requests(String pkg, String perm) {
        try {
            PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS);
            if (pi.requestedPermissions == null) return false;
            for (String p : pi.requestedPermissions) if (perm.equals(p)) return true;
        } catch (Exception ignored) { }
        return false;
    }

    private Object granted(String pkg, String perm) {
        if (!installed(pkg)) return false;
        if (!requests(pkg, perm)) return JSONObject.NULL; // app doesn't ask for it: nothing to grant
        return pm.checkPermission(perm, pkg) == PackageManager.PERMISSION_GRANTED;
    }

    private Object batteryFree(String pkg) {
        if (!installed(pkg)) return false;
        PowerManager p = (PowerManager) a.getSystemService(Activity.POWER_SERVICE);
        return p.isIgnoringBatteryOptimizations(pkg);
    }

    private Object overlay(String pkg) {
        if (!installed(pkg)) return false;
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            AppOpsManager ao = (AppOpsManager) a.getSystemService(Activity.APP_OPS_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ao.unsafeCheckOpNoThrow("android:system_alert_window", ai.uid, pkg)
                    : ao.checkOpNoThrow("android:system_alert_window", ai.uid, pkg);
            if (mode == AppOpsManager.MODE_DEFAULT) return granted(pkg, "android.permission.SYSTEM_ALERT_WINDOW");
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return JSONObject.NULL; // not allowed to check on this Android version
        }
    }

    private void add(JSONArray out, String id, String app, String title, String why, Object ok, boolean required) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", id); o.put("app", app); o.put("title", title); o.put("why", why);
        o.put("ok", ok); o.put("required", required);
        out.put(o);
    }

    String status() {
        JSONArray out = new JSONArray();
        try {
            boolean t33 = Build.VERSION.SDK_INT >= 33;
            add(out, "app_run", "Pocket IDE", "Run commands in Termux", "So Start, Repair and Update work",
                    a.checkSelfPermission("com.termux.permission.RUN_COMMAND") == PackageManager.PERMISSION_GRANTED, true);
            if (t33) add(out, "app_notif", "Pocket IDE", "Notifications", "Update download progress",
                    a.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED, false);
            add(out, "app_install", "Pocket IDE", "Install updates", "One-tap app updates",
                    Build.VERSION.SDK_INT < 26 || pm.canRequestPackageInstalls(), true);

            if (t33) add(out, "termux_notif", "Termux", "Notifications", "Keeps Termux running in the background",
                    granted(TERMUX, "android.permission.POST_NOTIFICATIONS"), true);
            add(out, "termux_battery", "Termux", "Unrestricted battery", "Stops Android from killing the IDE and automations",
                    batteryFree(TERMUX), true);
            add(out, "termux_overlay", "Termux", "Display over other apps", "Lets Claude open apps, Maps, WhatsApp… from the background",
                    overlay(TERMUX), true);

            add(out, "api_location", "Termux:API", "Location", "Where am I, location reminders",
                    granted(API, "android.permission.ACCESS_FINE_LOCATION"), true);
            add(out, "api_bg_location", "Termux:API", "Location: Allow all the time", "Location reminders while the screen is off",
                    granted(API, "android.permission.ACCESS_BACKGROUND_LOCATION"), true);
            if (t33) add(out, "api_notif", "Termux:API", "Notifications", "Reminders and alerts Claude sets",
                    granted(API, "android.permission.POST_NOTIFICATIONS"), true);
            add(out, "api_battery", "Termux:API", "Unrestricted battery", "Reliable background location",
                    batteryFree(API), false);

            add(out, "termux_storage", "Termux", "Storage (optional)", "Use phone files (/sdcard) in projects",
                    granted(TERMUX, Build.VERSION.SDK_INT >= 33 ? "android.permission.READ_MEDIA_IMAGES" : "android.permission.READ_EXTERNAL_STORAGE"), false);
            add(out, "api_sensitive", "Termux:API", "Contacts, SMS, Calls (optional)", "WhatsApp/SMS by contact name, reading SMS, calling",
                    granted(API, "android.permission.READ_CONTACTS"), false);
            add(out, "boot", "Termux:Boot", "Start on boot (optional)", "Automations come back after a restart",
                    installed(BOOT), false);
        } catch (Exception ignored) { }
        return out.toString();
    }

    private void start(Intent i) {
        try { a.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { details(i.getData() != null ? i.getData().getSchemeSpecificPart() : ME); }
    }
    private void details(String pkg) {
        try { a.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception ignored) { }
    }
    private void notifSettings(String pkg) {
        try {
            a.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) { details(pkg); }
    }
    private void battery(String pkg) {
        try {
            a.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + pkg))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            try { a.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (Exception e2) { details(pkg); }
        }
    }

    /** Returns "" when handled natively, or a Termux command the page should run. */
    String open(String id) {
        switch (id) {
            case "app_run": a.requestPermissions(new String[]{"com.termux.permission.RUN_COMMAND"}, 1); return "";
            case "app_notif": a.requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2); return "";
            case "app_install": start(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ME))); return "";
            case "termux_notif": notifSettings(TERMUX); return "";
            case "termux_battery": battery(TERMUX); return "";
            case "termux_overlay": start(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + TERMUX))); return "";
            // Asking Termux:API for a location makes it show its own permission prompt.
            case "api_location": return "cmd:termux-location -p network -r once >/dev/null 2>&1 || true";
            case "api_bg_location": details(API); return "";
            case "api_notif": notifSettings(API); return "";
            case "api_battery": battery(API); return "";
            case "termux_storage": return "fg:termux-setup-storage";
            case "api_sensitive": return "sensitive";
            case "boot":
                if (installed(BOOT)) { Intent i = pm.getLaunchIntentForPackage(BOOT); if (i != null) start(i); else details(BOOT); }
                else start(new Intent(Intent.ACTION_VIEW, Uri.parse("https://f-droid.org/packages/com.termux.boot/")));
                return "";
            default: return "";
        }
    }
}
