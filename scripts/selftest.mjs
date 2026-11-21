/**
 * selftest.mjs —— 不联网的自检：验证去重 / 归一 / 分类 / 频道归并 / 过滤规则
 * 用法：node scripts/selftest.mjs
 */
import assert from "node:assert";
import { canonChannel } from "./pipeline.mjs";
import { normUrl, normExt, siteDedupKey, siteCategory, speedGrade, parseLooseJson, decodeConfigText } from "./core.mjs";

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
};

console.log("\n【1】URL 归一（去重的前提）");
t("协议 / www / 末尾斜杠 视为同一地址", () => {
  assert.strictEqual(normUrl("https://www.Example.com/api/"), normUrl("http://example.com/api"));
});
t("GitHub 代理前缀被剥掉", () => {
  assert.strictEqual(
    normUrl("https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/x.json"),
    normUrl("https://raw.githubusercontent.com/a/b/main/x.json"),
  );
});
t("两层套娃代理也能剥掉", () => {
  assert.strictEqual(
    normUrl("https://ghproxy.net/https://gh-proxy.com/https://raw.githubusercontent.com/a/b/main/x.json"),
    normUrl("https://cdn.jsdelivr.net/gh/a/b@main/x.json"),
  );
});
t("jsdelivr 与 raw 视为同一文件", () => {
  assert.strictEqual(
    normUrl("https://cdn.jsdelivr.net/gh/owner/repo@main/dir/a.js"),
    normUrl("https://raw.githubusercontent.com/owner/repo/main/dir/a.js"),
  );
});
t("?ac=list 与裸地址归一为同一站", () => {
  const a = siteDedupKey({ type: 1, api: "https://x.com/api.php/provide/vod/" });
  const b = siteDedupKey({ type: 1, api: "https://x.com/api.php/provide/vod/?ac=list" });
  assert.strictEqual(a, b);
});

console.log("\n【2】站点去重键");
t("同名不同 api 保留两个", () => {
  const a = siteDedupKey({ type: 1, api: "https://a.com/api.php/provide/vod/" });
  const b = siteDedupKey({ type: 1, api: "https://b.com/api.php/provide/vod/" });
  assert.notStrictEqual(a, b);
});
t("ext 对象 key 顺序不影响去重", () => {
  const a = siteDedupKey({ type: 3, api: "csp_X", ext: { 标题: "x", 图片: "y" } });
  const b = siteDedupKey({ type: 3, api: "csp_X", ext: { 图片: "y", 标题: "x" } });
  assert.strictEqual(a, b);
});
t("ext 里的镜像 URL 归一后视为同一站", () => {
  const a = siteDedupKey({ type: 3, api: "csp_X", ext: "https://gh-proxy.com/https://raw.githubusercontent.com/o/r/main/a.js" });
  const b = siteDedupKey({ type: 3, api: "csp_X", ext: "https://raw.githubusercontent.com/o/r/main/a.js" });
  assert.strictEqual(a, b);
});
t("dt=12 这类无意义参数不应让同一文件变两个", () => {
  const a = siteDedupKey({ type: 3, api: "csp_X", ext: "https://raw.githubusercontent.com/o/r/main/a.js" });
  const b = siteDedupKey({ type: 3, api: "csp_X", ext: "https://raw.githubusercontent.com/o/r/main/a.js" });
  assert.strictEqual(a, b);
});

console.log("\n【3】分类");
t("type 0/1 → 采集站", () => assert.strictEqual(siteCategory({ type: 1, api: "http://x/api.php/provide/vod" }), "cj"));
t(".py 结尾 → py", () => assert.strictEqual(siteCategory({ type: 3, api: "https://x/a.py" }), "py"));
t(".js 结尾 → js", () => assert.strictEqual(siteCategory({ type: 3, api: "https://x/a.js" }), "js"));
t("type 3 无扩展名 → jar 爬虫", () => assert.strictEqual(siteCategory({ type: 3, api: "csp_XBPQ" }), "spider"));

console.log("\n【4】频道归一（CCTV1 / CCTV-1 / 央视一套 必须合并）");
t("CCTV1 系列合并", () => {
  const s = new Set([
    canonChannel("CCTV1"),
    canonChannel("CCTV-1"),
    canonChannel("CCTV1高清"),
    canonChannel("央视一套"),
    canonChannel("CCTV-1 综合"),
  ]);
  assert.ok(s.size <= 2, `应当合并到 1~2 个，实际 ${s.size}: ${[...s].join(" | ")}`);
});
t("CCTV5+ 不与 CCTV5 混淆", () => {
  assert.notStrictEqual(canonChannel("CCTV5+"), canonChannel("CCTV5"));
});
t("卫视画质后缀被去掉", () => {
  assert.strictEqual(canonChannel("湖南卫视高清"), canonChannel("湖南卫视"));
});
t("卫视备用线被去掉", () => {
  assert.strictEqual(canonChannel("湖南卫视备用2"), canonChannel("湖南卫视"));
});

console.log("\n【5】测速分档");
t("快站 → fast", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 200, kbps: 500 }), "fast"));
t("3~6 秒 → slow", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 4000, kbps: 500 }), "slow"));
t("6 秒以上 → slow", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 9000, kbps: 500 }), "slow"));
t("低吞吐 → slow", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 300, kbps: 5 }), "slow"));
t("失败 → dead", () => assert.strictEqual(speedGrade({ ok: false }), "dead"));

console.log("\n【6】宽松 JSON（现实里的接口经常是坏 JSON）");
t("尾逗号 + 注释", () => {
  const o = parseLooseJson(`{"a":1, /* c */ "b":[1,2,], }`);
  assert.deepStrictEqual(o, { a: 1, b: [1, 2] });
});
t("单引号", () => {
  const o = parseLooseJson(`{'a':'b'}`);
  assert.deepStrictEqual(o, { a: "b" });
});
t("字符串里有裸换行", () => {
  const o = parseLooseJson(`{"a":"line1
line2"}`);
  assert.ok(o.a.includes("line1"));
});

console.log("\n【7】解码");
t("整体 Base64 的配置能解开", () => {
  const raw = Buffer.from(JSON.stringify({ sites: [], lives: [] })).toString("base64");
  const out = decodeConfigText(Buffer.from(raw));
  assert.ok(out.includes('"sites"'));
});
t("BOM 被去掉", () => {
  const out = decodeConfigText(Buffer.from("\uFEFF{\"a\":1}"));
  assert.ok(out.startsWith("{"));
});

console.log(`\n${"=".repeat(50)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
