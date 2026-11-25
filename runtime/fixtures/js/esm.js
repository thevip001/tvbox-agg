import CryptoJS from 'crypto-js.js';
export default {
  homeContent: function () {
    return { class: [{ type_id: "esm", type_name: "ESM fixture" }],
      list: [{ vod_id: "esm-1", vod_name: "MisaTV ESM fixture",
        digest: CryptoJS.MD5("hello").toString() }] };
  }
};
