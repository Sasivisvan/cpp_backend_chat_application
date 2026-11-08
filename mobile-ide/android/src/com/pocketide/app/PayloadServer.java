package com.pocketide.app;

import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

/**
 * Serves the Termux-side installer bundled inside the APK on 127.0.0.1:8786:
 *   /setup.sh            the installer script
 *   /pocket-ide.tar.gz   the IDE + phone bridge source
 * This lets Termux install Pocket IDE without downloading anything from GitHub,
 * so it works even when the source repository is private, and the installed IDE
 * always matches the app version.
 */
final class PayloadServer implements Runnable {
    static final int PORT = 8786;
    private final AssetManager assets;
    private static Thread thread;

    private PayloadServer(AssetManager assets) { this.assets = assets; }

    static synchronized void start(AssetManager assets) {
        if (thread != null && thread.isAlive()) return;
        thread = new Thread(new PayloadServer(assets), "payload-server");
        thread.setDaemon(true);
        thread.start();
    }

    @Override
    public void run() {
        try (ServerSocket ss = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"))) {
            while (true) {
                Socket s = ss.accept();
                new Thread(() -> handle(s), "payload-conn").start();
            }
        } catch (Exception ignored) {
            // Port busy (another copy running) or shut down: nothing to do.
        }
    }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(15000);
            BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), "ISO-8859-1"));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            String path = parts.length > 1 ? parts[1] : "/";
            while ((line = in.readLine()) != null && !line.isEmpty()) { /* skip headers */ }

            // "/x.raw" = body only, no HTTP headers, so plain bash can download it via
            // /dev/tcp even when Termux's curl is broken.
            boolean raw = path.endsWith(".raw");
            if (raw) path = path.substring(0, path.length() - 4);
            String asset = null, type = "application/octet-stream";
            if (path.equals("/setup.sh")) { asset = "payload/setup.sh"; type = "text/x-shellscript"; }
            else if (path.equals("/pocket-ide.tar.gz")) { asset = "payload/pocket-ide.tar.gz"; type = "application/gzip"; }

            OutputStream out = sock.getOutputStream();
            if (asset == null) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes("ISO-8859-1"));
                return;
            }
            byte[] body;
            try (InputStream is = assets.open(asset)) { body = readAll(is); }
            if (!raw) {
                String head = "HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                        + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                out.write(head.getBytes("ISO-8859-1"));
            }
            out.write(body);
            out.flush();
        } catch (Exception ignored) {
        }
    }

    private static byte[] readAll(InputStream is) throws java.io.IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }
}
