var rule = {
  init: function (ext) { this.ext = ext; },
  homeContent: function () {
    return { class: [{ type_id: "fixture", type_name: "QuickJS fixture" }],
      list: [{ vod_id: "js-1", vod_name: "MisaTV QuickJS runtime fixture" }] };
  }
};
