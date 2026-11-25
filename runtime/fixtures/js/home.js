var rule = {
  init: function (ext) { this.ext = ext; },
  homeContent: function () {
    local.set("runtime-fixture", "persisted");
    return {
      class: [{ type_id: "fixture", type_name: "QuickJS fixture" }],
      list: [{ vod_id: "js-1", vod_name: "MisaTV QuickJS runtime fixture",
        digest: md5("hello"), local_bridge: local.get("runtime-fixture") }]
    };
  }
};
