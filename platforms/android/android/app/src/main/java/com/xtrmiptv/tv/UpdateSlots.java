package com.xtrmiptv.tv;

import android.content.Context;
import android.util.Base64;
import android.webkit.WebResourceResponse;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The updates kept by the app (src/boot/loader.js): two slots, "a" and "b", of files in the app's private storage (files/slots/<slot>/),
 * written by the page through TvHostPlugin and served to it at http://localhost/__slot/<slot>/<path> (ProviderWebViewClient): the same
 * origin as the package's own files, so its workers and its databases are the same. Only the names the loader uses are accepted.
 */
final class UpdateSlots {

    private static final Pattern SLOT = Pattern.compile("^[ab]$");
    private static final Pattern FILE = Pattern.compile("^(slot\\.json|(js|css|fonts)/[\\w.-]+)$");
    private static final Pattern URL_PATH = Pattern.compile("^/__slot/([ab])/(.+)$");

    private UpdateSlots() {}

    private static File root(Context context) {
        return new File(context.getFilesDir(), "slots");
    }

    static boolean isSlotPath(String path) {
        return path != null && path.startsWith("/__slot/");
    }

    /** Writes a file of a slot (its bytes in base64). */
    static void write(Context context, String slot, String path, String base64) throws IOException {
        if (slot == null || path == null || base64 == null || !SLOT.matcher(slot).matches() || !FILE.matcher(path).matches()) {
            throw new IOException("invalid slot file");
        }
        File file = new File(new File(root(context), slot), path);
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("cannot create " + parent);
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        File temp = new File(file.getPath() + ".part");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
            out.getFD().sync();
        }
        if (file.exists() && !file.delete()) throw new IOException("cannot replace " + file);
        if (!temp.renameTo(file)) throw new IOException("cannot write " + file);
    }

    /** Empties a slot. */
    static void remove(Context context, String slot) throws IOException {
        if (slot == null || !SLOT.matcher(slot).matches()) throw new IOException("invalid slot");
        delete(new File(root(context), slot));
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** The answer to http://localhost/__slot/<slot>/<path>: the file, or 404. */
    static WebResourceResponse serve(Context context, String urlPath) {
        Matcher match = URL_PATH.matcher(urlPath);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        if (match.matches() && FILE.matcher(match.group(2)).matches()) {
            File file = new File(new File(root(context), match.group(1)), match.group(2));
            try {
                return new WebResourceResponse(mimeOf(file.getName()), null, 200, "OK", headers, new FileInputStream(file));
            } catch (FileNotFoundException e) {
                // 404 below
            }
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
