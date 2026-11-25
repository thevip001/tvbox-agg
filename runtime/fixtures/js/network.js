var rule = {
  homeContent: function () {
    var response = req("https://example.com/");
    return {
      class: [],
      list: [{
        vod_id: "network-js",
        http_status: response.status,
        example_domain: String(response.content || "").indexOf("Example Domain") >= 0
      }]
    };
  }
};
