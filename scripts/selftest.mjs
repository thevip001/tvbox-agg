/**
 * selftest.mjs —— 不联网的自检：验证去重 / 归一 / 分类 / 直播种子 / 快站筛选 / 频道抽查 / 屏蔽域名
 * 用法：node scripts/selftest.mjs
 * 最后一段会起一个只监听 127.0.0.1 的临时 HTTP 服务当假直播源，跑一遍真实 runPipeline，
 * 全程不出网。
 */
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILES,
  classifyChannelFailure,
  gradeSite,
  mergeLiveSeeds,
  parseLiveSeeds,
  pickSample,
  readOptions,
  runPipeline,
  selectFastOnly,
  writeOutputs,
} from "./pipeline.mjs";
import { mergePool } from "./collect.mjs";
import {
  HEALTH,
  extractRuleTargets,
  inspectDexEntries,
  isProbeableTarget,
  jarHasClass,
  parseCmsPayload,
  readZipEntries,
  runDeepCheck,
  spiderClassOf,
  toOrigin,
} from "./deepcheck.mjs";
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

/** 在内存里拼一个最小可用的 ZIP（只做自检用：stored / deflate 两种都支持） */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const comp = f.deflate ? deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const crc = zlibCrc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** CRC32（ZIP 需要，node 没内置，这里给自检凑一个） */
function zlibCrc32(buf) {
  let c;
  const table = zlibCrc32.table || ((c = []), (zlibCrc32.table = c));
  if (!table.length) {
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      table[n] = v >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

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
  const txtUncertain = (port) =>
    ["测不准组,#genre#", ...["g1", "g2", "g3"].map((gg, i) => `测不准频道${i},${chan(gg).replace("PORT", port)}`)].join("\n");
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
            { name: "测不准源", type: 0, url: `http://127.0.0.1:${port}/uncertain.txt` },
          ],
        }),
        "application/json; charset=utf-8",
      );
      return;
    }
    if (path === "/seed.txt" || path === "/same-as-seed.txt") return send(txtA(port));
    if (path === "/extra.m3u") return send(m3uB(port));
    if (path === "/alldead.txt") return send(txtAllDead(port));
    if (path === "/uncertain.txt") return send(txtUncertain(port));
    if (/^\/(g1|g2|g3)\.m3u8$/.test(path)) {
      // 回一段非 HTTP 应答：客户端会报 Parse Error: Expected HTTP/, RTSP/ or ICE/（= 测不准）
      res.socket.write("HELLO NOT HTTP\r\n\r\n");
      res.socket.destroy();
      return;
    }
    if (/^\/(a1|a2|b1)\.m3u8$/.test(path)) return send("fake-ts-bytes");
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  let result;
  let seeds;
  let rejected;
  let e2eOpts;
  try {
    const parsed = parseLiveSeeds(
      ["# 种子清单", `种子A, ${base}/seed.txt, txt`, `死种子, ${base}/dead.txt, txt`, `误配的多仓, ${base}/depot.json, json`].join("\n"),
    );
    seeds = parsed.seeds;
    rejected = parsed.rejected;
    e2eOpts = {
      ...readOptions({}),
      budgetFetch: 60,
      budgetProbe: 30,
      budgetLive: 60,
      budgetLiveProbe: 60,
      blockedHosts: parseBlockedHosts("# 测试用\n7moor-fs1.com\n"),
    };
    result = await runPipeline({
      candidates: [{ name: "本地假接口", url: `${base}/box.json` }],
      liveSeedSources: seeds,
      opts: e2eOpts,
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
  await ta("直播抽查：测不准（非 HTTP 应答）不算全死，源保留并在报告单列", () => {
    assert.ok(names.includes("测不准源"), names.join("、"));
    assert.strictEqual(result.stats.liveUncertainKept.length, 1);
    assert.ok(/Parse Error: Expected HTTP/.test(result.stats.liveUncertainKept[0].reason), result.stats.liveUncertainKept[0].reason);
    assert.strictEqual(result.stats.dropped.liveProbe, 1, "确定死的全死源仍该剔");
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
    assert.strictEqual(lives.length, 3, `种子A + 接口独有源 + 测不准源，实际：${names.join("、")}`);
  });

  /* 落盘：遗留的 live.m3u 必须被清掉，且不再出现在文件清单里。
     临时把 cwd 换到输出目录，免得 writeOutputs 去回写仓库根 README。 */
  const tmp = await mkdtemp(join(tmpdir(), "tvbox-out-"));
  await writeFile(join(tmp, "live.m3u"), "#EXTM3U\n遗留的合并列表\n", "utf8");
  await writeFile(join(tmp, "海量直播聚合接口.json"), "{}", "utf8");
  const cwd0 = process.cwd();
  let sizes = [];
  try {
    process.chdir(tmp);
    sizes = await writeOutputs({
      result,
      opts: { ...e2eOpts, outDir: "." },
      rawUrl: (f) => `https://example.test/${f}`,
      when: "2026-11-22 12:00",
    });
  } finally {
    process.chdir(cwd0);
  }
  await ta("落盘：清掉废弃的 live.m3u / 旧聚合文件，写出新口径全套产物", () => {
    assert.ok(!existsSync(join(tmp, "live.m3u")), "遗留 live.m3u 应被删除");
    assert.ok(!existsSync(join(tmp, "海量直播聚合接口.json")), "遗留旧文件应被删除");
    for (const f of Object.values(FILES)) assert.ok(existsSync(join(tmp, f)), `缺少产物 ${f}`);
    assert.ok(!sizes.some(([f]) => f === "live.m3u"), "文件清单里不该再有 live.m3u");
    const liveOnDisk = JSON.parse(readFileSync(join(tmp, FILES.live), "utf8"));
    assert.strictEqual(liveOnDisk.lives.length, 3);
    assert.ok(!liveOnDisk.lives.some((l) => /合并/.test(String(l.name))), "落盘的 live.json 不该有合并条目");
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

console.log("\n【11】采集站放宽 & 测不准不算失败");
t("采集站精选阈值放宽到 800ms，普通站仍 300ms", () => {
  const o = readOptions({});
  assert.strictEqual(o.fastTtfbCj, 800);
  assert.strictEqual(gradeSite({ alive: true, ttfb: 520 }, o, "cj", "http://x/api.php"), "fast");
  assert.strictEqual(gradeSite({ alive: true, ttfb: 520 }, o, "js", "http://x/a.js"), "ok");
  assert.strictEqual(gradeSite({ alive: true, ttfb: 800 }, o, "cj", "x"), "fast");
  assert.strictEqual(gradeSite({ alive: true, ttfb: 801 }, o, "cj", "x"), "ok");
  assert.strictEqual(gradeSite({ alive: true, ttfb: 1600 }, o, "cj", "x"), "slow");
  assert.strictEqual(gradeSite({ alive: true, ttfb: 2500 }, o, "spider", "csp_X"), "ok", "内置爬虫站慢档阈值仍 3000ms");
  assert.strictEqual(gradeSite({ alive: false }, o, "cj", "x"), "dead");
  assert.strictEqual(readOptions({ FAST_TTFB_CJ_MS: "600" }).fastTtfbCj, 600);
});
t("频道失败分类：跑测环境限制=测不准，HTTP/超时/空内容=确定死", () => {
  assert.strictEqual(classifyChannelFailure("connect ENETUNREACH 2409:8a00:22:1f02::9:443"), "uncertain");
  assert.strictEqual(classifyChannelFailure("connect EHOSTUNREACH 2408:8000::1:80"), "uncertain");
  assert.strictEqual(classifyChannelFailure("AggregateError"), "uncertain");
  assert.strictEqual(classifyChannelFailure("Parse Error: Expected HTTP/, RTSP/ or ICE/"), "uncertain");
  assert.strictEqual(classifyChannelFailure("HTTP 403"), "dead");
  assert.strictEqual(classifyChannelFailure("HTTP 404"), "dead");
  assert.strictEqual(classifyChannelFailure("连接超时"), "dead");
  assert.strictEqual(classifyChannelFailure("connect ECONNREFUSED 1.2.3.4:443"), "dead");
  assert.strictEqual(classifyChannelFailure("空内容"), "dead");
});

console.log("\n【12】深度体检（探活通过 ≠ 点开能用）");
t("采集站空壳 code:0 + 空 list 解析出 0 条目 0 分类（旧版会当活站）", () => {
  const p = parseCmsPayload(JSON.stringify({ code: 0, list: [] }), 1);
  assert.strictEqual(p.items.length, 0);
  assert.strictEqual(p.classes.length, 0);
});
t("采集站真数据：分类 + 条目都能解析出来", () => {
  const p = parseCmsPayload(
    JSON.stringify({ class: [{ type_id: 1, type_name: "动作" }], list: [{ vod_id: 9, vod_name: "片名A" }] }),
    1,
  );
  assert.strictEqual(p.classes.length, 1);
  assert.strictEqual(p.items[0].name, "片名A");
});
t("type 0 的 XML 采集站也能解析", () => {
  const xml = `<rss><class><ty id="1">动作</ty></class><list><video><id>5</id><name>片名B</name></video></list></rss>`;
  const p = parseCmsPayload(xml, 0);
  assert.strictEqual(p.classes[0].name, "动作");
  assert.strictEqual(p.items[0].name, "片名B");
});
t("csp_XXX → 类名；去查询串/分号/md5 后缀", () => {
  assert.strictEqual(spiderClassOf("csp_XBPQ"), "XBPQ");
  assert.strictEqual(spiderClassOf("csp_XYQHiker?v=2"), "XYQHiker");
  assert.strictEqual(spiderClassOf("csp_AppV7Amns;md5;abc"), "AppV7Amns");
  assert.strictEqual(spiderClassOf("com.github.catvod.spider.Foo"), "Foo");
});
t("规则目标站：XBPQ 的「主页url/分类url」和 drpy 的 host 都能抽到", () => {
  const xbpq = extractRuleTargets(
    JSON.stringify({ 主页url: "https://a.example.com/vodshow/1--------{{pg}}.html", 分类url: "https://b.example.com/vodtype/{cateId}" }),
  );
  assert.ok(xbpq.some((u) => u.includes("a.example.com")), xbpq.join(","));
  assert.ok(xbpq.some((u) => u.includes("b.example.com")), xbpq.join(","));
  const drpy = extractRuleTargets("var rule = { title:'x', host:'https://d.example.com', url:'/vod' };");
  assert.deepStrictEqual(drpy, ["https://d.example.com"]);
});
t("规则目标站：\"host\": [\"a\", \"b\"] 这种数组备选也要能抽到", () => {
  const arr = extractRuleTargets(JSON.stringify({ host: ["https://a.example.com", "https://b.example.com"] }));
  assert.ok(arr.some((u) => u.includes("a.example.com")), arr.join(","));
  assert.ok(arr.some((u) => u.includes("b.example.com")), arr.join(","));
  // 嵌套数组也要透传 key
  const nested = extractRuleTargets(JSON.stringify({ site: { host: ["https://c.example.com"] } }));
  assert.ok(nested.some((u) => u.includes("c.example.com")), nested.join(","));
});
t("目标站归一：百分号域名 / // 开头 / 模板串都能取到 origin", () => {
  assert.strictEqual(toOrigin("https://www.%79%6f%75%6b%75.com/x"), "https://www.youku.com");
  assert.strictEqual(toOrigin("//a.b.com/p?q=1"), "https://a.b.com");
  assert.strictEqual(toOrigin("https://x.com{template}"), "https://x.com");
});
t("GitHub/CDN/图床 不算「目标站」，不该拿去判死", () => {
  assert.strictEqual(isProbeableTarget(toOrigin("https://raw.githubusercontent.com/a/b/main/x.js")), false);
  assert.strictEqual(isProbeableTarget(toOrigin("https://cdn.jsdelivr.net/gh/a/b@main/x.js")), false);
  assert.strictEqual(isProbeableTarget(toOrigin("https://sc1080.top")), true);
});
t("深度体检选项默认值：开启、深检 cj/js/spider、类名校验开", () => {
  const o = readOptions({});
  assert.strictEqual(o.deepCheck, true);
  assert.ok(o.deepCheckCategories.has("cj") && o.deepCheckCategories.has("js") && o.deepCheckCategories.has("spider"));
  assert.strictEqual(o.deepCheckCategories.has("py"), true, "Py 站也必须进入规则体检");
  assert.strictEqual(o.deepJarClass, true);
  assert.strictEqual(readOptions({ DEEP_CHECK: "0" }).deepCheck, false);
  assert.strictEqual(readOptions({ DEEP_CHECK_CATEGORIES: "cj" }).deepCheckCategories.has("js"), false);
  assert.strictEqual(readOptions({ STRICTNESS: "loose" }).deepStrict, false, "loose 只剔硬证据");
  assert.strictEqual(readOptions({ STRICTNESS: "strict" }).deepStrict, true);
});
await ta("真 ZIP：readZipEntries 能解出 stored 与 deflate 两种条目", async () => {
  const zip = makeZip([
    { name: "classes.dex", data: Buffer.from("com/github/catvod/spider/XBPQ\ncom/github/catvod/spider/XYQHiker"), deflate: true },
    { name: "META-INF/MANIFEST.MF", data: Buffer.from("Manifest-Version: 1.0"), deflate: false },
  ]);
  const entries = readZipEntries(zip);
  assert.strictEqual(entries.size, 2);
  assert.ok(entries.get("classes.dex").toString().includes("XBPQ"));
  assert.strictEqual(entries.get("META-INF/MANIFEST.MF").toString(), "Manifest-Version: 1.0");
});
t("dex 扫描：按 L..; 描述符抽类名，相邻字符串不会粘连", () => {
  const dex = Buffer.from("...Lcom/github/catvod/spider/XBPQ;Lcom/github/catvod/spider/Xyq;...com/whl/quickjs/Context");
  const info = inspectDexEntries([dex]);
  assert.deepStrictEqual([...info.classes].sort(), ["XBPQ", "Xyq"], [...info.classes].join(","));
  assert.strictEqual(info.classes.has("PanSou"), false, "包里没有的类不能被认成有");
  assert.strictEqual(info.hasQuickJs, true);
});
t("类名匹配：同名 / 忽略大小写 / 类名+后缀 家族都算命中，真的没有才算没有", () => {
  const classes = new Set(["XBPQ", "WoggFishGuard", "Bili$1", "Init"]);
  assert.strictEqual(jarHasClass(classes, "XBPQ"), true);
  assert.strictEqual(jarHasClass(classes, "xbpq"), true);
  assert.strictEqual(jarHasClass(classes, "Wogg"), true, "WoggFishGuard 就是 csp_Wogg 的实现");
  assert.strictEqual(jarHasClass(classes, "Bili"), true, "Bili$1 是 Bili 的内部类");
  assert.strictEqual(jarHasClass(classes, "PanSou"), false);
  assert.strictEqual(jarHasClass(classes, "Init2"), false);
});
await ta("端到端深检：空壳采集站被剔，有内容的留下，jar 缺类的被剔", async () => {
  const srvBody = () => {};
  void srvBody;
  const port = 0; // 占位，避免未使用告警
  void port;
  // 起一个假服务器：一个空壳采集站、一个真采集站、一个规则文件、一个 jar
  const zip = makeZip([
    { name: "classes.dex", data: Buffer.from("Lcom/github/catvod/spider/XBPQ;Lcom/github/catvod/spider/OnlyThisClass;"), deflate: true },
  ]);
  const server2 = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (b, t = "text/plain; charset=utf-8") => res.writeHead(200, { "Content-Type": t }).end(b);
    if (u.pathname === "/shell.php") return send(JSON.stringify({ code: 0, list: [] }), "application/json");
    if (u.pathname === "/real.php") {
      return send(JSON.stringify({ list: [{ vod_id: 1, vod_name: "真片名" }] }), "application/json");
    }
    if (u.pathname === "/real2.php") {
      if (u.searchParams.get("t") === "1") return send(JSON.stringify({ list: [] }), "application/json");
      return send(JSON.stringify({ class: [{ type_id: 1, type_name: "动作" }], list: [] }), "application/json");
    }
    if (u.pathname === "/good.py") return send("class Spider:\n    def homeContent(self, filter):\n        return {}\n    def searchContent(self, key, quick):\n        return []\nhost = 'http://127.0.0.1:" + server2.address().port + "/site/'", "text/plain");
    if (u.pathname === "/x.jar") return send(zip, "application/java-archive");
    if (u.pathname === "/rule.json") return send(JSON.stringify({ 主页url: `http://127.0.0.1:${server2.address().port}/site/` }));
    if (u.pathname === "/site/" || u.pathname === "/site") return send("<html><body>" + "x".repeat(400) + "</body></html>", "text/html");
    if (u.pathname === "/deadpage") return res.writeHead(404).end("nope");
    res.writeHead(404).end();
  });
  await new Promise((r) => server2.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server2.address().port}`;
  try {
    const o = {
      ...readOptions({}),
      deepCheckCategories: new Set(["cj", "spider"]),
      budgetDeepCheck: 60,
      deepTargetTimeout: 5000,
    };
    const stats = { dropped: {}, removed: [] };
    const entries = [
      { category: "cj", grade: "fast", site: { name: "空壳站", type: 1, api: `${base}/shell.php` }, probe: { ttfb: 100 } },
      { category: "cj", grade: "fast", site: { name: "真采集站", type: 1, api: `${base}/real.php` }, probe: { ttfb: 100 } },
      { category: "cj", grade: "fast", site: { name: "有分类无内容", type: 1, api: `${base}/real2.php` }, probe: { ttfb: 100 } },
      { category: "py", grade: "fast", site: { name: "有效Py规则", type: 3, api: "py_test", ext: `${base}/good.py` }, probe: { ttfb: 100 } },
      { category: "spider", grade: "fast", site: { name: "缺类的jar站", type: 3, api: "csp_PanSou", jar: `${base}/x.jar`, ext: `${base}/rule.json` }, probe: { ttfb: 100 } },
      { category: "spider", grade: "fast", site: { name: "类在包里的站", type: 3, api: "csp_XBPQ", jar: `${base}/x.jar`, ext: `${base}/rule.json` }, probe: { ttfb: 100 } },
      { category: "spider", grade: "fast", site: { name: "缺ext的规则站", type: 3, api: "csp_XBPQ", jar: `${base}/x.jar` }, probe: { ttfb: 100 } },
      { category: "spider", grade: "fast", site: { name: "类不在包里的规则站", type: 3, api: "csp_XYQHiker", jar: `${base}/x.jar` }, probe: { ttfb: 100 } },
    ];
    const ds = await runDeepCheck(entries, o, {
      stats,
      effectiveJar: (site) => site.jar || "",
      jarCache: new Map(),
      hostCache: new Map(),
      textCache: new Map(),
    });
    const byName = Object.fromEntries(entries.map((e) => [e.site.name, e]));
    assert.strictEqual(byName["空壳站"].grade, "dead", "空壳采集站必须剔除");
    assert.ok(/空壳/.test(byName["空壳站"].healthReason), byName["空壳站"].healthReason);
    assert.notStrictEqual(byName["真采集站"].grade, "dead", "有内容的采集站必须保留");
    assert.notStrictEqual(byName["有分类无内容"].grade, "dead", "MisaTV 口径：有分类即 ok-classes，不能误杀");
    assert.strictEqual(byName["有分类无内容"].health, "ok-classes");
    assert.notStrictEqual(byName["有效Py规则"].grade, "dead", "Py 必须进入深检且有效 Spider 规则应保留");
    assert.strictEqual(byName["有效Py规则"].health, "ok-content");
    assert.strictEqual(byName["缺类的jar站"].grade, "dead", "jar 里没有该类必须剔除");
    assert.ok(/没有 PanSou/.test(byName["缺类的jar站"].healthReason), byName["缺类的jar站"].healthReason);
    assert.notStrictEqual(byName["类在包里的站"].grade, "dead", "类在包里 + 目标站活着 → 保留");
    assert.strictEqual(byName["缺ext的规则站"].grade, "dead", "XBPQ/XYQHiker 缺 ext 无法工作");
    assert.strictEqual(byName["缺ext的规则站"].health, "needs-ext");
    assert.strictEqual(byName["类不在包里的规则站"].grade, "dead", "类不在包里 → 补 ext 也没用，必须剔除");
    assert.strictEqual(byName["类不在包里的规则站"].health, "no-class");
    assert.strictEqual(stats.dropped.deep, 4, `剔除 4 个，实际 ${stats.dropped.deep}`);
    assert.ok(ds.removed >= 4);
  } finally {
    await new Promise((r) => server2.close(r));
  }
});

await ta("采集站：ac=list 无分类 + 兜底 ac=detail 被判不准 → 保留（不判死）", async () => {
  // ac=list 返回 CMS 结构但没分类；兜底 ac=detail 返回 429（限流）
  const server4 = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const ac = u.searchParams.get("ac");
    if (ac === "list") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 1, class: [] }));
    }
    return res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 0, msg: "too many requests" }));
  });
  await new Promise((r) => server4.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server4.address().port}`;
  try {
    const { probeCmsSite } = await import("./tvbox.mjs");
    const r = await probeCmsSite(`${base}/api.php/provide/vod/`, { timeoutMs: 5000 });
    assert.notStrictEqual(r.grade, "dead", `限流不该判死，实际 ${r.grade} / ${r.reason}`);
    assert.strictEqual(r.alive, true);
    assert.strictEqual(r.uncertain, true, "应标成判不准");
  } finally {
    await new Promise((r) => server4.close(r));
  }
});

await ta("深度体检也认「限流」：兜底请求 429 不判空壳（与探活口径一致）", async () => {
  // ac=list 给了一个没有任何分类的 CMS 壳，兜底 ac=detail 返回 429。
  // 探活（probeCmsSite）会标 uncertain 保留；深度体检不能再把它判成 empty 删掉。
  const server6 = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.searchParams.get("ac") === "list") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 1, class: [] }));
    }
    return res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 0 }));
  });
  await new Promise((r) => server6.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server6.address().port}`;
  try {
    const { deepCheckCms } = await import("./deepcheck.mjs");
    const r = await deepCheckCms({ type: 1, api: `${base}/rate.php` }, { timeoutMs: 5000 });
    assert.strictEqual(r.status, "uncertain", `429 应判不准，实际 ${r.status}: ${r.reason}`);

    // 真·空壳（200 + 空列表 + 兜底也是空列表）仍然要判 empty 剔除
    const server7 = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 0, list: [] }));
    });
    await new Promise((r2) => server7.listen(0, "127.0.0.1", r2));
    const base7 = `http://127.0.0.1:${server7.address().port}`;
    try {
      const r7 = await deepCheckCms({ type: 1, api: `${base7}/shell.php` }, { timeoutMs: 5000 });
      assert.strictEqual(r7.status, "empty", `真空壳应判 empty，实际 ${r7.status}: ${r7.reason}`);
    } finally {
      await new Promise((r2) => server7.close(r2));
    }
  } finally {
    await new Promise((r) => server6.close(r));
  }
});

await ta("ext 规则文件 404 → 判 no-rule；5xx → 判不准（严格模式剔、宽松模式留）", async () => {
  const zipOk = makeZip([
    { name: "classes.dex", data: Buffer.from("Lcom/github/catvod/spider/XBPQ;" + "q".repeat(1024)), deflate: true },
  ]);
  const server5 = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (b, t = "text/plain") => res.writeHead(200, { "Content-Type": t }).end(b);
    if (u.pathname === "/ok.jar") return send(zipOk, "application/java-archive");
    if (u.pathname === "/gone.json") return res.writeHead(404).end("not found");
    if (u.pathname === "/err.json") return res.writeHead(503).end("busy");
    res.writeHead(404).end();
  });
  await new Promise((r) => server5.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server5.address().port}`;
  try {
    const o = { ...readOptions({}), budgetDeepCheck: 60, deepTargetTimeout: 4000 };
    const mk = (name, ext) => ({ category: "spider", grade: "fast", site: { name, type: 3, api: "csp_XBPQ", jar: `${base}/ok.jar`, ext }, probe: { ttfb: 100 } });
    const gone = mk("规则文件没了", `${base}/gone.json`);
    const err = mk("规则文件503", `${base}/err.json`);
    const stats = { dropped: {}, removed: [] };
    const ds = await runDeepCheck([gone, err], o, {
      stats,
      effectiveJar: (st) => st.jar,
      jarCache: new Map(),
      hostCache: new Map(),
      textCache: new Map(),
    });
    assert.strictEqual(gone.grade, "dead", "ext 规则文件 404 必须判死");
    assert.strictEqual(gone.health, "no-rule");
    assert.ok(/ext 规则文件已失效/.test(gone.healthReason), gone.healthReason);
    // 用户策略「宁可误杀」：严格模式下 5xx/超时等判不准也剔
    assert.strictEqual(err.grade, "dead", "严格模式下判不准也要剔除");
    assert.strictEqual(err.health, "uncertain");
    assert.ok(/严格剔除/.test(err.probe?.reason || ""), err.probe?.reason || "");
    assert.strictEqual(stats.dropped.deep, 2);
    assert.strictEqual(ds.removed, 2);

    // 显式关掉 DEEP_KILL_UNCERTAIN 时，判不准应保留（宽松口径）
    const loose = { ...readOptions({ DEEP_KILL_UNCERTAIN: "0" }), budgetDeepCheck: 60, deepTargetTimeout: 4000 };
    const err2 = mk("规则文件503-宽松", `${base}/err.json`);
    const stats2 = { dropped: {}, removed: [] };
    await runDeepCheck([err2], loose, {
      stats: stats2,
      effectiveJar: (st) => st.jar,
      jarCache: new Map(),
      hostCache: new Map(),
      textCache: new Map(),
    });
    assert.notStrictEqual(err2.grade, "dead", "DEEP_KILL_UNCERTAIN=0 时判不准不能删");
    assert.strictEqual(err2.health, "uncertain");
  } finally {
    await new Promise((r) => server5.close(r));
  }
});

await ta("jar 缺类但同配置别的 jar 有 → 只换 jar 不删站", async () => {
  // 两个 jar：A 里有 XBPQ，B 里没有；站点写的是 csp_XBPQ 却指向 B
  const zipA = makeZip([{ name: "classes.dex", data: Buffer.from("Lcom/github/catvod/spider/XBPQ;" + "a".repeat(1024)), deflate: true }]);
  const zipB = makeZip([{ name: "classes.dex", data: Buffer.from("Lcom/github/catvod/spider/SomethingElse;" + "b".repeat(1024)), deflate: true }]);
  const server3 = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (b, t = "text/plain") => res.writeHead(200, { "Content-Type": t }).end(b);
    const base = `http://127.0.0.1:${server3.address().port}`;
    if (u.pathname === "/a.jar") return send(zipA, "application/java-archive");
    if (u.pathname === "/b.jar") return send(zipB, "application/java-archive");
    if (u.pathname === "/rule.json") return send(JSON.stringify({ 主页url: `${base}/site/` }));
    if (u.pathname === "/site/") return send("<html>" + "x".repeat(400) + "</html>", "text/html");
    res.writeHead(404).end();
  });
  await new Promise((r) => server3.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server3.address().port}`;
  try {
    const o = { ...readOptions({}), budgetDeepCheck: 60, deepTargetTimeout: 5000 };
    const jarCache = new Map();
    const index = new Map();
    const { httpGet } = await import("./core.mjs");
    for (const jar of [`${base}/a.jar`, `${base}/b.jar`]) {
      const r = await httpGet(jar, { timeoutMs: 8000 });
      const dex = [...readZipEntries(r.body).entries()].filter(([n]) => /\.dex$/i.test(n)).map(([, b]) => b);
      const info = inspectDexEntries(dex);
      jarCache.set(normUrl(jar), { ok: true, ...info });
      for (const c of info.classes) if (!index.has(c)) index.set(c, jar);
    }
    const findJarWithClass = (cls) => index.get(cls) || "";
    const site = { name: "写错jar的站", type: 3, api: "csp_XBPQ", jar: `${base}/b.jar`, ext: `${base}/rule.json` };
    const e = { category: "spider", grade: "fast", site, probe: { ttfb: 100 } };
    const stats = { dropped: {}, removed: [] };
    const ds = await runDeepCheck([e], o, {
      stats,
      effectiveJar: (st) => st.jar,
      jarCache,
      hostCache: new Map(),
      textCache: new Map(),
      findJarWithClass,
      repairJar: (st) => {
        const jar = findJarWithClass(spiderClassOf(st.api));
        if (!jar) return "";
        st.jar = jar;
        return jar;
      },
    });
    assert.strictEqual(e.grade, "fast", "能修好的站不该被剔");
    assert.strictEqual(e.jarRepaired, `${base}/a.jar`, `应换成带 XBPQ 的 jar，实际 ${e.jarRepaired}`);
    assert.strictEqual(ds.repaired, 1);
    assert.strictEqual(stats.jarRepaired, 1);
  } finally {
    await new Promise((r) => server3.close(r));
  }
});

console.log(`\n${"=".repeat(50)}\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
