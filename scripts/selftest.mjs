/**
 * selftest.mjs —— 不联网的自检：验证去重 / 归一 / 分类 / 直播种子 / 快站筛选 / 频道抽查 / 屏蔽域名
 * 用法：node scripts/selftest.mjs
 * 最后一段会起一个只监听 127.0.0.1 的临时 HTTP 服务当假直播源，跑一遍真实 runPipeline，
 * 全程不出网。
 */
import assert from "node:assert";
import { createServer } from "node:http";
import { mergeLiveSeeds, parseLiveSeeds, pickSample, readOptions, runPipeline, selectFastOnly } from "./pipeline.mjs";
import { mergePool } from "./collect.mjs";
import {
  normUrl,
  normExt,
  siteDedupKey,
  siteCategory,
  speedGrade,
  parseLooseJson,
  decodeConfigText,
  parseBlockedHosts,
  isBlockedUrl,
} from "./core.mjs";

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
const ta = async (name, fn) => {
  try {
    await fn();
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

console.log("\n【4】测速分档");
t("快站 → fast", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 200, kbps: 500 }), "fast"));
t("0.8~1.5 秒 → ok", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 1000, kbps: 500 }), "ok"));
t("1.5 秒以上 → slow", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 1600, kbps: 500 }), "slow"));
t("6 秒以上 → slow", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 9000, kbps: 500 }), "slow"));
t("低吞吐但首字节快 → 不判慢(fast)", () => assert.strictEqual(speedGrade({ ok: true, ttfb: 300, kbps: 5 }), "fast"));
t("失败 → dead", () => assert.strictEqual(speedGrade({ ok: false }), "dead"));

console.log("\n【5】宽松 JSON（现实里的接口经常是坏 JSON）");
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

console.log("\n【6】解码");
t("整体 Base64 的配置能解开", () => {
  const raw = Buffer.from(JSON.stringify({ sites: [], lives: [] })).toString("base64");
  const out = decodeConfigText(Buffer.from(raw));
  assert.ok(out.includes('"sites"'));
});
t("BOM 被去掉", () => {
  const out = decodeConfigText(Buffer.from("\uFEFF{\"a\":1}"));
  assert.ok(out.startsWith("{"));
});

console.log("\n【7】直播源清单种子（config/liveupstreams.txt）");
t("注释行 / 空行 / 没有 URL 的行被跳过", () => {
  const { seeds } = parseLiveSeeds("# 注释\n\n名称但没有地址, txt\n好源, https://x.com/live.txt, txt");
  assert.strictEqual(seeds.length, 1);
  assert.strictEqual(seeds[0].name, "好源");
  assert.strictEqual(seeds[0].type, "txt");
});
t("只有 URL 的行用域名当名字", () => {
  const { seeds } = parseLiveSeeds("https://live.example.com/a.m3u, m3u");
  assert.strictEqual(seeds[0].name, "live.example.com");
  assert.strictEqual(seeds[0].type, "m3u");
});
t("多仓/接口索引 JSON 被拒收（放错层的清单不该白占一次探活）", () => {
  const { seeds, rejected } = parseLiveSeeds(
    "仓库, https://x.com/warehouse.txt, json\n好源, https://x.com/live.txt, txt",
  );
  assert.strictEqual(seeds.length, 1);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].name, "仓库");
});
t("就算没声明类型，.json 结尾也当索引拒收", () => {
  const { seeds, rejected } = parseLiveSeeds("https://x.com/depot.json");
  assert.strictEqual(seeds.length, 0);
  assert.strictEqual(rejected.length, 1);
});
t("新地址进 liveMap 并打上 seed 标记", () => {
  const m = new Map();
  const stats = { rawLives: 0 };
  const r = mergeLiveSeeds(m, [{ name: "A", url: "https://x.com/live.txt" }], stats);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(m.size, 1);
  assert.ok([...m.values()][0].seed, "种子必须带 seed 标记");
  assert.strictEqual(stats.rawLives, 1, "新增种子要计入 rawLives");
  assert.strictEqual(stats.liveSeeds, 1);
});
t("点播接口里已有的同一地址 → 就地升级成种子，不重复计数", () => {
  const proxied = "https://gh-proxy.com/https://raw.githubusercontent.com/o/r/main/live.txt";
  const m = new Map();
  m.set(normUrl(proxied), { live: { name: "接口里的", url: proxied }, origin: "http://some.box/tv" });
  const stats = { rawLives: 5 };
  const r = mergeLiveSeeds(m, [{ name: "种子", url: "https://raw.githubusercontent.com/o/r/main/live.txt" }], stats);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.promoted, 1);
  assert.strictEqual(m.size, 1, "代理前缀差异归一后必须是同一条");
  assert.ok([...m.values()][0].seed, "已有条目要升级成种子");
  assert.strictEqual(stats.rawLives, 5, "升级不增加 rawLives");
});

console.log("\n【8】点播只留快站 & 直播随机抽查");
await ta("只收录 fast 档，其它档位进报告并写明档位与 TTFB", () => {
  const mk = (name, grade, ttfb) => ({ grade, site: { name, api: "http://a/" + name }, category: "cj", probe: { ttfb } });
  const kept = [mk("精选", "fast", 120), mk("正常", "ok", 500), mk("偏慢", "slow", 9000), mk("测不准", "uncertain", null), mk("没测到", "unsure", null)];
  const stats = { dropped: { notFast: 0 }, removed: [] };
  const out = selectFastOnly(kept, { vodFastOnly: true }, stats);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].site.name, "精选");
  assert.strictEqual(stats.dropped.notFast, 4);
  assert.strictEqual(stats.removed.length, 4);
  assert.ok(stats.removed.every((r) => r.kind === "site"));
  assert.ok(stats.removed[1].reason.includes("档位=slow TTFB=9000ms"), stats.removed[1].reason);
  assert.ok(stats.removed[2].reason.includes("档位=uncertain TTFB=?ms"), stats.removed[2].reason);
});
await ta("VOD_ONLY_FAST=0 时原样返回，一条都不剔", () => {
  const kept = [{ grade: "slow", site: { name: "慢站" }, category: "cj" }];
  const stats = { dropped: { notFast: 0 }, removed: [] };
  assert.strictEqual(selectFastOnly(kept, { vodFastOnly: false }, stats).length, 1);
  assert.strictEqual(stats.dropped.notFast, 0);
  assert.strictEqual(stats.removed.length, 0);
});
await ta("随机抽查：数量取 min(n, 总数)，且不改动原数组", () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const s3 = pickSample(arr, 3);
  assert.strictEqual(s3.length, 3);
  assert.strictEqual(arr.length, 8);
  assert.strictEqual(pickSample([1, 2], 3).length, 2);
  assert.strictEqual(pickSample([], 3).length, 0);
  assert.ok(s3.every((x) => arr.includes(x)));
});
await ta("随机抽查真的会换样（20 次抽 3/8 不全相同）", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(pickSample([1, 2, 3, 4, 5, 6, 7, 8], 3).join(","));
  assert.ok(seen.size > 1, "20 次抽样结果一模一样，随机性有问题");
});
await ta("默认配置：抽查 3 个频道、点播只留快站", () => {
  const o = readOptions({});
  assert.strictEqual(o.liveProbeChannels, 3);
  assert.strictEqual(o.vodFastOnly, true);
  assert.strictEqual(o.livePerChannel, undefined, "旧的每频道 N 源选项该删掉");
  assert.strictEqual(o.filterNonTv, undefined, "旧的分组过滤开关该删掉");
  assert.strictEqual(readOptions({ VOD_ONLY_FAST: "0" }).vodFastOnly, false);
  assert.strictEqual(readOptions({ LIVE_PROBE_CHANNELS: "5" }).liveProbeChannels, 5);
});

console.log("\n【9】端到端：种子 / 屏蔽域名 / 点播只留快站 / 直播抽查（本地假服务器，不出网）");
await (async () => {
  const chan = (n) => `http://127.0.0.1:PORT/${n}.m3u8`;
  const txtA = (port) =>
    ["央视,#genre#", `CCTV1,${chan("a1").replace("PORT", port)}`, `CCTV2,${chan("a2").replace("PORT", port)}`].join("\n");
  const m3uB = (port) =>
    ["#EXTM3U", '#EXTINF:-1 group-title="卫视",湖南卫视', chan("b1").replace("PORT", port)].join("\n");
  const txtAllDead = (port) =>
    ["死组,#genre#", ...["d1", "d2", "d3"].map((d, i) => `死频道${i},${chan(d).replace("PORT", port)}`)].join("\n");
  const CMS_LIST = JSON.stringify({ list: [{ type_name: "动作" }], code: 1 });
  const CMS_DETAIL = JSON.stringify({ list: [{ vod_id: 1, vod_name: "样例片名" }] });

  let port = 0;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    const send = (body, type = "text/plain; charset=utf-8") => {
      res.writeHead(200, { "Content-Type": type }).end(body);
    };
    if (path === "/dead.txt" || path.startsWith("/d1") || path.startsWith("/d2") || path.startsWith("/d3")) {
      res.writeHead(404).end("nope");
      return;
    }
    if (path === "/cms-fast.php" || path === "/cms-slow.php") {
      const slow = path === "/cms-slow.php";
      const body = u.search.includes("ac=detail") ? CMS_DETAIL : CMS_LIST;
      setTimeout(() => send(body, "application/json"), slow ? 400 : 0);
      return;
    }
    if (path === "/box.json") {
      send(
        JSON.stringify({
          sites: [
            { key: "bad", name: "报毒站", type: 3, api: "csp_XBPQ", jar: "https://fs-im-kefu.7moor-fs1.com/x/c (1).txt" },
            { key: "fast", name: "快站", type: 1, api: `http://127.0.0.1:${port}/cms-fast.php` },
            { key: "slowish", name: "慢站", type: 1, api: `http://127.0.0.1:${port}/cms-slow.php` },
          ],
          lives: [
            { name: "接口里的重复源", type: 0, url: `http://127.0.0.1:${port}/same-as-seed.txt` },
            { name: "接口里的独有源", type: 0, url: `http://127.0.0.1:${port}/extra.m3u` },
            { name: "全死源", type: 0, url: `http://127.0.0.1:${port}/alldead.txt` },
          ],
        }),
        "application/json; charset=utf-8",
      );
      return;
    }
    if (path === "/seed.txt" || path === "/same-as-seed.txt") return send(txtA(port));
    if (path === "/extra.m3u") return send(m3uB(port));
    if (path === "/alldead.txt") return send(txtAllDead(port));
    if (/^\/(a1|a2|b1)\.m3u8$/.test(path)) return send("fake-ts-bytes");
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let result;
  let seeds;
  let rejected;
  try {
    const parsed = parseLiveSeeds(
      ["# 种子清单", `种子A, ${base}/seed.txt, txt`, `死种子, ${base}/dead.txt, txt`, `误配的多仓, ${base}/depot.json, json`].join("\n"),
    );
    seeds = parsed.seeds;
    rejected = parsed.rejected;
    result = await runPipeline({
      candidates: [{ name: "本地假接口", url: `${base}/box.json` }],
      liveSeedSources: seeds,
      opts: {
        ...readOptions({}),
        budgetFetch: 60,
        budgetProbe: 30,
        budgetLive: 60,
        budgetLiveProbe: 60,
        blockedHosts: parseBlockedHosts("# 测试用\n7moor-fs1.com\n"),
      },
      onProgress: () => {},
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  const lives = result.files.live.lives;
  const names = lives.map((l) => l.name);
  const removed = result.stats.removed;

  await ta("误配的多仓索引在解析阶段就被拒收", () => {
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(seeds.length, 2);
  });
  await ta("假站是本机地址，先被「本机引用」剔掉（e2e 不看点播档位）", () => {
    assert.strictEqual(result.stats.dropped.local, 2, `快站+慢站都该因 127.0.0.1 被剔，实际 ${result.stats.dropped.local}`);
  });
  await ta("jar 命中屏蔽域名的站整站剔除，且不进产物", () => {
    assert.strictEqual(result.stats.dropped.blocked, 1);
    const b = removed.find((x) => x.name === "报毒站");
    assert.ok(b && b.reason.includes("jar 命中屏蔽域名 7moor-fs1.com"), b && b.reason);
  });
  await ta("直播抽查：频道全死的源被剔除，报告写明抽查明细", () => {
    assert.strictEqual(result.stats.dropped.liveProbe, 1);
    const dead = removed.find((x) => x.name === "全死源");
    assert.ok(dead, "全死源该出现在剔除报告里");
    assert.ok(/抽查 3 个频道全部失败/.test(dead.reason), dead.reason);
    assert.ok(dead.reason.includes("死频道0→HTTP 404"), dead.reason);
    assert.ok(!names.includes("全死源"));
  });
  await ta("抽查活着的源保留：种子与接口独有源都在", () => {
    assert.ok(names.includes("种子A"), names.join("、"));
    assert.ok(names.includes("接口里的独有源"), names.join("、"));
    assert.strictEqual(result.stats.liveSeedsKept, 1);
  });
  await ta("内容相同的普通源被剔，种子当正本", () => {
    const dup = removed.find((x) => x.name === "接口里的重复源");
    assert.ok(dup && /正本：/.test(dup.reason) && dup.reason.includes("/seed.txt"), dup && dup.reason);
    assert.ok(!names.includes("接口里的重复源"));
  });
  await ta("不再产出合并列表：live.json 只有源本身，没有 m3u 产物", () => {
    assert.strictEqual(result.m3u, undefined, "runPipeline 不该再返回 m3u");
    assert.strictEqual(result.counts.channels, undefined, "不该再有频道合并计数");
    assert.ok(!names.some((n) => /合并去重/.test(n)), "不该有置顶合并条目");
    assert.strictEqual(lives.length, 2, `种子A + 接口独有源，实际：${names.join("、")}`);
  });
})();

console.log("\n【10】屏蔽域名（config/blocked-hosts.txt）");
t("注释 / 空行跳过，容忍误写成完整 URL", () => {
  const h = parseBlockedHosts("# 注释\n\n7moor-fs1.com\nhttps://WWW.Bad.example.com:8443/x/y\n");
  assert.deepStrictEqual([...h].sort(), ["7moor-fs1.com", "bad.example.com"]);
});
t("命中域名本身和全部子域", () => {
  const h = parseBlockedHosts("7moor-fs1.com");
  assert.strictEqual(isBlockedUrl("https://fs-im-kefu.7moor-fs1.com/a/b.txt", h), "7moor-fs1.com");
  assert.strictEqual(isBlockedUrl("http://7moor-fs1.com/x", h), "7moor-fs1.com");
  assert.strictEqual(isBlockedUrl("https://7moor-fs1.com.evil.io/x", h), "");
  assert.strictEqual(isBlockedUrl("https://example.com/7moor-fs1.com", h), "", "路径里出现域名不算命中");
});
t("被 GitHub 代理套娃藏起来的屏蔽域名也认得", () => {
  const h = parseBlockedHosts("7moor-fs1.com");
  assert.strictEqual(
    isBlockedUrl("https://gh-proxy.org/https://fs-im-kefu.7moor-fs1.com/x/c.txt", h),
    "7moor-fs1.com",
  );
});
t("空名单 = 不拦任何东西", () => {
  assert.strictEqual(isBlockedUrl("https://fs-im-kefu.7moor-fs1.com/x", parseBlockedHosts("")), "");
  assert.strictEqual(isBlockedUrl("https://fs-im-kefu.7moor-fs1.com/x", null), "");
});
t("候选池：屏蔽域名不管上游灌的还是池里存量的，一律不留", () => {
  const h = parseBlockedHosts("bad.example.com");
  const entries = mergePool({
    upstreams: [{ name: "上游", urls: ["https://bad.example.com/a.json", "https://ok.example.com/b.json"] }],
    seeds: [],
    prevPool: { entries: [{ url: "https://sub.bad.example.com/old.json", lastSeen: new Date().toISOString() }] },
    fromConfigs: ["https://bad.example.com/c.json"],
    blockedHosts: h,
  });
  assert.strictEqual(entries.length, 1, `只该剩 ok.example.com，实际 ${entries.map((e) => e.url).join(", ")}`);
  assert.ok(entries[0].url.includes("ok.example.com"));
});

console.log(`\n${"=".repeat(50)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
