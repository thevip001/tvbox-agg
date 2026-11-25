package com.github.catvod.spider;

import com.github.catvod.crawler.Spider;

public final class RuntimeFixture extends Spider {
    @Override
    public String homeContent(boolean filter) {
        return "{\"class\":[{\"type_id\":\"fixture\",\"type_name\":\"Runtime fixture\"}],\"list\":[{\"vod_id\":\"fixture-jar-1\",\"vod_name\":\"MisaTV JVM fixture\"}]}";
    }
}
