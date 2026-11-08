package com.pocketide.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Pocket IDE Android app.
 *
 * The heavy lifting (Ubuntu, Node, Claude Code, the phone bridge) runs inside
 * Termux. This app is the friendly front door: it walks the user through setup,
 * starts the IDE in Termux with one tap, shows it full-screen, and keeps itself
 * up to date from GitHub Releases.
 */
public class MainActivity extends Activity {
    static final String REPO = "sasivisvan/cpp_backend_chat_application";
    static final String BRANCH = "claude/tender-bardeen-qyata4";
    static final int PORT = 8787;
    static final String TERMUX = "com.termux";
    static final String TERMUX_BIN = "/data/data/com.termux/files/usr/bin";
    static final String SETUP_PAGE = "file:///android_asset/setup.html";

    private WebView web;
    private SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private long downloadId = -1;
    private BroadcastReceiver downloadReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("pocketide", MODE_PRIVATE);
        PayloadServer.start(getAssets()); // serves the bundled installer to Termux
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF16181D);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " PocketIDE/" + versionName());
        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(new Bridge(), "PocketIDE");
        web.setWebChromeClient(new WebChromeClient()); // default alert/confirm/prompt dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                boolean local = "file".equals(u.getScheme())
                        || ((host.equals("127.0.0.1") || host.equals("localhost")) && u.getPort() == PORT);
                if (local) return false;
                openExternal(u.toString()); // everything else (Claude login, docs, previews in new tab) -> browser
                return true;
            }

            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest req,
                                        android.webkit.WebResourceError err) {
                if (req.isForMainFrame() && !req.getUrl().toString().startsWith("file:")) {
                    view.loadUrl(SETUP_PAGE + "#offline");
                }
            }
        });

        if (!handleDeepLink(getIntent())) {
            if (savedInstanceState != null) web.restoreState(savedInstanceState);
            else web.loadUrl(SETUP_PAGE);
        }
        main.postDelayed(() -> checkForUpdate(false), 2500);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleDeepLink(intent);
    }

    /** pocketide://open?token=XYZ — sent by `pocket-ide --app` once the server is up. */
    private boolean handleDeepLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"pocketide".equals(data.getScheme())) return false;
        if (data.getQueryParameter("missing") != null) { // pocket-ide not installed in Termux yet
            main.post(() -> web.loadUrl(SETUP_PAGE + "#missing"));
            return true;
        }
        String token = data.getQueryParameter("token");
        if (token != null && token.matches("[a-fA-F0-9]{16,128}")) {
            prefs.edit().putString("token", token).apply();
        }
        openIde();
        return true;
    }

    private void openIde() {
        String token = prefs.getString("token", "");
        String url = "http://127.0.0.1:" + PORT + "/" + (token.isEmpty() ? "" : "?token=" + token);
        main.post(() -> web.loadUrl(url));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true); // keep the IDE (and terminals) alive
    }

    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) {}
        if (tokenReceiver != null) try { unregisterReceiver(tokenReceiver); } catch (Exception ignored) {}
        if (outputReceiver != null) try { unregisterReceiver(outputReceiver); } catch (Exception ignored) {}
        super.onDestroy();
    }

    // ------------------------------------------------------------------ helpers

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            toast("No app can open " + url);
        }
    }

    private void toast(String msg) {
        main.post(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
    }

    private boolean isInstalled(String pkg) {
        try {
            getPackageManager().getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private int versionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    private boolean hasRunCommandPermission() {
        return checkSelfPermission("com.termux.permission.RUN_COMMAND") == PackageManager.PERMISSION_GRANTED;
    }

    /** Runs a bash command in Termux through its RUN_COMMAND intent. */
    private String runInTermux(String command, boolean background) {
        if (!isInstalled(TERMUX)) return "Termux is not installed";
        if (!hasRunCommandPermission()) {
            requestPermissions(new String[]{"com.termux.permission.RUN_COMMAND"}, 1);
            return "permission";
        }
        Intent i = new Intent();
        i.setClassName(TERMUX, "com.termux.app.RunCommandService");
        i.setAction("com.termux.RUN_COMMAND");
        i.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BIN + "/bash");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-lc", command});
        i.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background);
        i.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0"); // open + switch to the new session
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            if (!background) {
                Intent open = getPackageManager().getLaunchIntentForPackage(TERMUX);
                if (open != null) startActivity(open);
            }
            return "ok";
        } catch (Exception e) {
            return "Termux refused the command: " + e.getMessage()
                    + "\nMake sure allow-external-apps=true is set in ~/.termux/termux.properties (the setup command does this).";
        }
    }

    /**
     * Reads ~/.pocket-ide/token from Termux and opens the IDE. Uses Termux's
     * RUN_COMMAND result callback (a PendingIntent that Termux fills with the
     * command's stdout), so it works even when Android blocks Termux from opening
     * apps from the background (which breaks the pocketide:// hand-off).
     */
    private BroadcastReceiver tokenReceiver;
    private String fetchToken() {
        if (!isInstalled(TERMUX)) return "Termux is not installed";
        if (!hasRunCommandPermission()) {
            main.post(() -> requestPermissions(new String[]{"com.termux.permission.RUN_COMMAND"}, 1));
            return "permission";
        }
        String action = getPackageName() + ".TOKEN_RESULT";
        if (tokenReceiver == null) {
            tokenReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    Bundle res = intent.getBundleExtra("result");
                    String out = res == null ? "" : String.valueOf(res.getString("stdout", "")).trim();
                    if (out.matches("[a-fA-F0-9]{16,128}")) {
                        prefs.edit().putString("token", out).apply();
                        toast("Connected to Pocket IDE");
                        openIde();
                    } else {
                        String err = res == null ? "no result" : String.valueOf(res.getString("stderr", "")).trim();
                        toast("Couldn't read the token from Termux" + (err.isEmpty() ? "" : ": " + err)
                                + ". Is setup finished?");
                    }
                }
            };
            IntentFilter f = new IntentFilter(action);
            // The PendingIntent is sent with this app's identity, so the receiver needn't be exported.
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(tokenReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(tokenReceiver, f);
        }
        Intent cb = new Intent(action).setPackage(getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getBroadcast(this, 7, cb, flags);
        Intent i = new Intent();
        i.setClassName(TERMUX, "com.termux.app.RunCommandService");
        i.setAction("com.termux.RUN_COMMAND");
        i.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BIN + "/cat");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"/data/data/com.termux/files/home/.pocket-ide/token"});
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        i.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pi);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            return "ok";
        } catch (Exception e) {
            return "Termux refused: " + e.getMessage();
        }
    }

    /**
     * Runs a bash script in Termux (background) and hands its stdout to the page via
     * window.__termuxResult(reqId, stdout, exitCode). Used for settings that live in
     * Termux, like which phone capabilities Claude may use.
     */
    private BroadcastReceiver outputReceiver;
    private int outputSeq = 100;
    private String termuxOutput(String reqId, String script) {
        if (!isInstalled(TERMUX)) return "Termux is not installed";
        if (!hasRunCommandPermission()) {
            main.post(() -> requestPermissions(new String[]{"com.termux.permission.RUN_COMMAND"}, 1));
            return "permission";
        }
        String action = getPackageName() + ".TERMUX_OUTPUT";
        if (outputReceiver == null) {
            outputReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    Bundle res = intent.getBundleExtra("result");
                    String id = intent.getStringExtra("reqId");
                    String out = res == null ? "" : String.valueOf(res.getString("stdout", ""));
                    int code = res == null ? -1 : res.getInt("exitCode", -1);
                    String js = "window.__termuxResult && window.__termuxResult(" + JSONObject.quote(id == null ? "" : id)
                            + "," + JSONObject.quote(out) + "," + code + ")";
                    main.post(() -> web.evaluateJavascript(js, null));
                }
            };
            IntentFilter f = new IntentFilter(action);
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(outputReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            else registerReceiver(outputReceiver, f);
        }
        Intent cb = new Intent(action).setPackage(getPackageName()).putExtra("reqId", reqId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getBroadcast(this, outputSeq++, cb, flags);
        Intent i = new Intent();
        i.setClassName(TERMUX, "com.termux.app.RunCommandService");
        i.setAction("com.termux.RUN_COMMAND");
        i.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BIN + "/bash");
        i.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", script});
        i.putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home");
        i.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        i.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", pi);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
            return "ok";
        } catch (Exception e) {
            return "Termux refused: " + e.getMessage();
        }
    }

    private static String httpGet(String url, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(timeoutMs);
        c.setReadTimeout(timeoutMs);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "PocketIDE-Android");
        int code = c.getResponseCode();
        if (code >= 400) throw new Exception("HTTP " + code);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private boolean serverUp() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + PORT + "/manifest.webmanifest").openConnection();
            c.setConnectTimeout(700);
            c.setReadTimeout(700);
            return c.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ updates

    /** Looks at the latest GitHub release; returns JSON {current, latest, newer, url, notes}. */
    private JSONObject latestRelease() throws Exception {
        JSONObject rel = new JSONObject(httpGet("https://api.github.com/repos/" + REPO + "/releases/latest", 8000));
        String tag = rel.optString("tag_name", "");
        int latestCode = 0;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+)$").matcher(tag);
        if (m.find()) latestCode = Integer.parseInt(m.group(1));
        String apkUrl = null;
        JSONArray assets = rel.optJSONArray("assets");
        if (assets != null) {
            for (int k = 0; k < assets.length(); k++) {
                JSONObject a = assets.getJSONObject(k);
                if (a.optString("name").endsWith(".apk")) { apkUrl = a.optString("browser_download_url"); break; }
            }
        }
        JSONObject out = new JSONObject();
        out.put("current", versionName());
        out.put("currentCode", versionCode());
        out.put("latest", tag);
        out.put("latestCode", latestCode);
        out.put("newer", apkUrl != null && latestCode > versionCode());
        out.put("url", apkUrl == null ? JSONObject.NULL : apkUrl);
        out.put("page", rel.optString("html_url"));
        out.put("notes", rel.optString("body", ""));
        return out;
    }

    private void checkForUpdate(boolean userAsked) {
        new Thread(() -> {
            try {
                JSONObject r = latestRelease();
                if (r.getBoolean("newer")) {
                    main.post(() -> new AlertDialog.Builder(this)
                            .setTitle("Update available: " + r.optString("latest"))
                            .setMessage("You have " + versionName() + ".\n\n" + trim(r.optString("notes"), 600))
                            .setPositiveButton("Update", (d, w) -> downloadAndInstall(r.optString("url"), r.optString("latest")))
                            .setNegativeButton("Later", null)
                            .show());
                } else if (userAsked) {
                    toast("Pocket IDE " + versionName() + " is up to date");
                }
            } catch (Exception e) {
                if (userAsked) toast("Could not check for updates: " + e.getMessage());
            }
        }).start();
    }

    private static String trim(String s, int n) { return s.length() > n ? s.substring(0, n) + "…" : s; }

    private void downloadAndInstall(String url, String tag) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            toast("Allow Pocket IDE to install updates, then tap Update again");
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            return;
        }
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                    .setTitle("Pocket IDE " + tag)
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "pocket-ide-" + tag + ".apk");
            downloadId = dm.enqueue(req);
            toast("Downloading update…");
            if (downloadReceiver == null) {
                downloadReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context ctx, Intent intent) {
                        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (id != downloadId) return;
                        Uri apk = dm.getUriForDownloadedFile(id);
                        if (apk == null) { toast("Download failed"); openExternal(url); return; }
                        Intent install = new Intent(Intent.ACTION_VIEW)
                                .setDataAndType(apk, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { startActivity(install); } catch (Exception e) { openExternal(url); }
                    }
                };
                IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver, f, Context.RECEIVER_EXPORTED);
                else registerReceiver(downloadReceiver, f);
            }
        } catch (Exception e) {
            openExternal(url); // fall back to the browser download
        }
    }

    // ------------------------------------------------------------------ JS bridge

    /** Exposed to setup.html and to the IDE page as window.PocketIDE. */
    class Bridge {
        @JavascriptInterface public String version() { return versionName() + " (" + versionCode() + ")"; }
        @JavascriptInterface public String repo() { return REPO; }
        @JavascriptInterface public String branch() { return BRANCH; }
        @JavascriptInterface public boolean isInstalled(String pkg) { return MainActivity.this.isInstalled(pkg); }
        @JavascriptInterface public boolean hasRunCommandPermission() { return MainActivity.this.hasRunCommandPermission(); }
        @JavascriptInterface public void requestRunCommandPermission() {
            main.post(() -> requestPermissions(new String[]{"com.termux.permission.RUN_COMMAND"}, 1));
        }
        @JavascriptInterface public String runInTermux(String cmd, boolean background) { return MainActivity.this.runInTermux(cmd, background); }
        @JavascriptInterface public boolean serverUp() { return MainActivity.this.serverUp(); }
        @JavascriptInterface public String termuxOutput(String reqId, String script) { return MainActivity.this.termuxOutput(reqId, script); }
        @JavascriptInterface public void openNotificationAccess() {
            main.post(() -> { try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); } catch (Exception e) { toast("Open Settings → Notifications → Device & app notifications → Termux:API"); } });
        }
        @JavascriptInterface public String permStatus() { return new Perms(MainActivity.this).status(); }
        @JavascriptInterface public String permOpen(String id) {
            final String[] r = {""};
            final Object lock = new Object();
            main.post(() -> { synchronized (lock) { r[0] = new Perms(MainActivity.this).open(id); lock.notify(); } });
            synchronized (lock) { try { lock.wait(3000); } catch (InterruptedException ignored) { } }
            return r[0];
        }
        @JavascriptInterface public String fetchToken() { return MainActivity.this.fetchToken(); }
        @JavascriptInterface public boolean hasToken() { return !prefs.getString("token", "").isEmpty(); }
        @JavascriptInterface public void setToken(String t) {
            if (t != null && t.matches("[a-fA-F0-9]{16,128}")) prefs.edit().putString("token", t).apply();
        }
        @JavascriptInterface public void openIde() { MainActivity.this.openIde(); }
        @JavascriptInterface public void openSetupAt(String hash) {
            String h = hash != null && hash.matches("#[a-z]{1,20}") ? hash : "#home";
            main.post(() -> web.loadUrl(SETUP_PAGE + h));
        }
        @JavascriptInterface public void openSetup() { main.post(() -> web.loadUrl(SETUP_PAGE + "#home")); }
        @JavascriptInterface public void openUrl(String url) { openExternal(url); }
        @JavascriptInterface public void openApp(String pkg) {
            Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
            if (i != null) startActivity(i); else toast(pkg + " is not installed");
        }
        @JavascriptInterface public void appSettings(String pkg) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)));
        }
        @JavascriptInterface public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("Pocket IDE", text));
            toast("Copied");
        }
        @JavascriptInterface public String readClipboard() {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            ClipData c = cm.getPrimaryClip();
            if (c == null || c.getItemCount() == 0) return "";
            CharSequence t = c.getItemAt(0).coerceToText(MainActivity.this);
            return t == null ? "" : t.toString();
        }
        @JavascriptInterface public String checkUpdate() {
            try { return latestRelease().toString(); }
            catch (Exception e) { return "{\"error\":" + JSONObject.quote(e.getMessage()) + "}"; }
        }
        @JavascriptInterface public void promptUpdate() { checkForUpdate(true); }
        @JavascriptInterface public void installUpdate(String url, String tag) { main.post(() -> downloadAndInstall(url, tag)); }
        @JavascriptInterface public void toast(String msg) { MainActivity.this.toast(msg); }
    }
}
