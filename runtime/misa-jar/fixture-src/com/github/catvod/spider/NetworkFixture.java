package com.github.catvod.spider;

import com.github.catvod.crawler.Spider;
import java.net.HttpURLConnection;
import java.net.URL;

public final class NetworkFixture extends Spider {
    @Override
    public String homeContent(boolean filter) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("https://example.com/").openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            int status = connection.getResponseCode();
            StringBuilder body = new StringBuilder();
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(connection.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null && body.length() < 4096) body.append(line);
            }
            boolean example = body.toString().contains("Example Domain");
            return "{\"class\":[],\"list\":[{\"vod_id\":\"network-jar\",\"http_status\":" + status +
                    ",\"example_domain\":" + example + "}]}";
        } catch (Exception error) {
            return "{\"class\":[],\"list\":[],\"network_error\":\"request failed\"}";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
