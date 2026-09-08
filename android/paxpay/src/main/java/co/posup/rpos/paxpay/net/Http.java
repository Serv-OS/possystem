package co.posup.rpos.paxpay.net;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * The whole HTTP layer, in one small synchronous helper.
 *
 * java.net.HttpURLConnection from the JDK — NO new third-party dependency. UpdateChecker already
 * uses exactly this, and pulling OkHttp/Retrofit into a payment terminal for eight REST calls
 * would be a worse trade than the fifty lines below.
 *
 * Every method here BLOCKS. Callers must be on a background thread; {@link SupabaseClient} owns
 * the executor and is the only thing that should call this class directly.
 */
public final class Http {

    private Http() {}

    /** Connect + read timeouts. Generous: hospitality wifi is routinely bad (see PaymentFlow). */
    public static final int CONNECT_TIMEOUT_MS = 10_000;
    public static final int READ_TIMEOUT_MS = 15_000;

    public static final class Response {
        public final int code;
        /** Response body, or "" — never null, so callers never NPE parsing an error. */
        public final String body;
        /** Non-null ONLY for a transport failure (no HTTP response at all). */
        public final String transportError;

        Response(int code, String body, String transportError) {
            this.code = code;
            this.body = body == null ? "" : body;
            this.transportError = transportError;
        }

        public boolean ok() { return transportError == null && code >= 200 && code < 300; }

        /**
         * TRUE when we genuinely could not reach the server — as opposed to reaching it and being
         * told no. The distinction is load-bearing: a transport failure on a payment-result write
         * means RETRY FOREVER; a 4xx means the server has an opinion and retrying will not help.
         */
        public boolean isTransportFailure() { return transportError != null; }

        public String describe() {
            if (transportError != null) return "network: " + transportError;
            String b = body.length() > 300 ? body.substring(0, 300) + "…" : body;
            return "HTTP " + code + (b.isEmpty() ? "" : " " + b);
        }
    }

    public static Response request(String method, String url,
                                   Map<String, String> headers, String jsonBody) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setUseCaches(false);
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    c.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            if (jsonBody != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] payload = jsonBody.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(payload.length);
                OutputStream os = c.getOutputStream();
                try {
                    os.write(payload);
                    os.flush();
                } finally {
                    os.close();
                    // Best-effort scrub: this buffer may have held a staff PIN on its way to
                    // terminal_staff_login. See PinScreen for why that is only best-effort.
                    java.util.Arrays.fill(payload, (byte) 0);
                }
            }

            int code = c.getResponseCode();
            InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
            return new Response(code, readAll(in), null);
        } catch (Exception e) {
            String msg = e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : ": " + e.getMessage());
            return new Response(0, null, msg);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) sb.append(line);
        } catch (Exception ignored) {
        }
        return sb.toString();
    }

    /** Percent-encode a PostgREST query-string value. */
    public static String enc(String raw) {
        try {
            return java.net.URLEncoder.encode(raw, "UTF-8");
        } catch (Exception e) {
            return raw;
        }
    }
}
