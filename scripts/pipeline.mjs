/**
 * pipeline.mjs —— 筛选整理层：探活 → 测速 → 去重 → 分类 → 输出
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GRADE_ORDER,
  contentFingerprint,
  measureLatency,
  normUrl,
  pool,
  siteCategory,
  siteDedupKey,
  speedGrade,
  stableStringify,
} from "./core.mjs";
import { fetchTvboxConfig, probeCmsSite, probeJar, probeScript, extractExtTargets, probeHost } from "./tvbox.mjs";

/* ============================ 参数 ============================ */

export function readOptions(env = process.env) {
  return {
    // 剔除策略：strict = 只留快站 / balanced = 死站剔除、慢站保留在文末 / loose = 只剔死站
    strictness: (env.STRICTNESS || "balanced").toLowerCase(),
    // ===== 判慢只看首字节（TTFB），不看吞吐 =====
    // 原因：接口返回的就是几十 KB 的 JSON/脚本，KB/s 低只是「文件小、连接早断开」，
    // 用户点开几乎是秒开。实测过 MIN_KBPS=50 会把 TTFB 133~366ms 的健康站全删掉。
    // slowTtfb：超过就判「慢」（strict 下删除）
    slowTtfb: Number(env.SLOW_TTFB_MS || 1500),
    // fastTtfb：低于就是「精选」
    fastTtfb: Number(env.FAST_TTFB_MS || 300),
    // csp_* 内置爬虫站测的是目标站首页（HTML 更重），阈值放宽一些
    crawlerSlowTtfb: Number(env.CRAWLER_SLOW_TTFB_MS || 3000),
    // 预算用尽、本轮没测到的站不参与判慢（下轮补测），见 probeSkipped / grade=unsure
    keepUnprobed: (env.KEEP_UNPROBED || "1") !== "0",
    // 连续失败多少轮才永久剔除
    maxFails: Number(env.MAX_FAILS || 3),
    // 每个频道保留几个源
    livePerChannel: Number(env.LIVE_PER_CHANNEL || 3),
    // 是否过滤非直播内容（MV/音乐/公告等）
    filterNonTv: (env.FILTER_NON_TV || "1") !== "0",
    // 是否去掉 127.0.0.1 本地引用
    dropLocalRef: (env.DROP_LOCAL_REF || "1") !== "0",
    // 是否保留「｜来源」后缀（默认不加，改为重名加序号）
    keepSourceSuffix: (env.KEEP_SOURCE_SUFFIX || "0") === "1",
    concurrencyFetch: Number(env.FETCH_WORKERS || 8),
    concurrencyProbe: Number(env.PROBE_WORKERS || 24),
    concurrencyLive: Number(env.LIVE_WORKERS || 8),
    fetchTimeout: Number(env.FETCH_TIMEOUT_MS || 20000),
    probeTimeout: Number(env.PROBE_TIMEOUT_MS || 8000),
    // 分阶段预算（秒）：到点就收工，用已拿到的结果继续，不会把任务拖超时
    budgetFetch: Number(env.BUDGET_FETCH || 600),
    budgetProbe: Number(env.BUDGET_PROBE || 900),
    budgetLive: Number(env.BUDGET_LIVE || 420),
    // 每轮最多抓多少个候选接口
    maxCandidates: Number(env.MAX_CANDIDATES || 600),
    // 安全阀：不低于上次产物的这个比例才允许覆盖
    minRatio: Number(env.MIN_RATIO || 0.5),
    outDir: env.OUT_DIR || "聚合接口",
    poolFile: env.POOL_FILE || "data/pool.json",
    historyFile: env.HISTORY_FILE || "data/history.json",
  };
}

/* ============================ 小工具 ============================ */

function uniqueNamer({ keepSuffix = false } = {}) {
  const used = new Set();
  return (base, tag) => {
    let n = String(base || "未命名");
    if (used.has(n) && tag && keepSuffix) n = `${base}｜${tag}`;
    const root = n;
    let i = 2;
    while (used.has(n)) n = `${root}${i++}`;
    used.add(n);
    return n;
  };
}

const isLocalRef = (s) => /(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(JSON.stringify(s));

/** 解析播放列表（M3U 或 「名称,地址」TXT） */
export function parsePlaylist(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const out = [];
  if (/^\s*#EXTM3U/i.test(text) || /#EXTINF/i.test(text)) {
    let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#EXTINF/i.test(line)) {
        const group = /group-title="([^"]*)"/i.exec(line)?.[1] || "未分组";
        const logo = /tvg-logo="([^"]*)"/i.exec(line)?.[1] || "";
        const name =
          line.slice(line.lastIndexOf(",") + 1).trim() || /tvg-name="([^"]*)"/i.exec(line)?.[1] || "未命名";
        pending = { group, name, logo };
      } else if (!line.startsWith("#") && pending) {
        out.push({ ...pending, url: line });
        pending = null;
      }
    }
    return out;
  }
  let group = "未分组";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const idx = line.indexOf(",");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    if (rest === "#genre#") {
      group = name || "未分组";
      continue;
    }
    for (const u of rest.split("#")) {
      const url = u.trim();
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) out.push({ group, name, logo: "", url });
    }
  }
  return out;
}

/** 频道名归一：CCTV1 / CCTV-1 / 央视一套 / CCTV1高清 → 同一个频道 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17 };
export function canonChannel(name) {
  let n = String(name || "").trim();
  // 去掉台标 emoji / 装饰
  n = n.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "");
  n = n.replace(/[\s\-_·•|｜:：]+/g, "");
  // 央视各套
  const cctvCn = /^(?:CCTV|央视|中央)(十[一二三四五六七]|十|[一二三四五六七八九])(?:套|台|频道)?(综合|财经|综艺|中文国际|体育|电影|军事农业|军事|电视剧|纪录|科教|戏曲|社会与法|新闻|少儿)?/i.exec(n);
  if (cctvCn) {
    const num = CN_NUM[cctvCn[1]] ?? cctvCn[1];
    return `CCTV${num}${cctvCn[2] ? "|" + cctvCn[2] : ""}`;
  }
  const cctv = /^CCTV0?(\d{1,2})(\+|\-)?(.*)$/i.exec(n);
  if (cctv) {
    const suffix = cctv[2] === "+" ? "+" : "";
    return `CCTV${Number(cctv[1])}${suffix}`;
  }
  // 卫视/其它：去掉画质与备用后缀
  n = n.replace(/(高清|超清|蓝光|标清|原画|4K|8K|UHD|FHD|HD|SD)(备用|线路)?\d*$/i, "");
  n = n.replace(/(备用|线路)\d+$/i, "");
  // 只去掉「3 位以上」的尾部编号（比如 CCTV 系列的台标号），
  // 不要动 CCTV5+ 里的 5、CCTV-1 里的 1 这种有效信息
  n = n.replace(/(?<=[\u4e00-\u9fa5A-Z])\d{3,}$/i, "");
  return n.toUpperCase();
}

const NON_TV_RE = new RegExp(
  [
    "MV", "音乐", "短视频", "抖音", "快手", "公告", "官网", "广告", "福利", "测试", "回看", "一起看",
    "原创IP", "轮播", "电台", "收音", "斗鱼", "虎牙", "B站", "哔哩", "点播", "APP下载", "加群", "客服",
    // 实战新增：点歌台/歌单/歌手专辑这类「不是直播频道」的内容
    "点歌", "MTV", "劲爆", "歌单", "专辑", "歌手", "演唱会", "舞曲", "DJ", "慢摇", "情歌",
    "小品", "相声", "评书", "有声", "小说", "听书", "戏曲选段",
  ].join("|"),
  "i",
);

/** 单个分组里频道数超过这个值，基本不是电视直播（是点歌台/影音库），整组丢弃 */
const MAX_GROUP_CHANNELS = Number(process.env.MAX_GROUP_CHANNELS || 3000);

/**
 * 分组模式：
 *   tv  （默认）只保留「像电视频道」的分组 —— CCTV/卫视/地方/港澳台/体育/新闻/少儿/频道…
 *   all         保留全部分组，只丢掉明显垃圾分组
 * 实测：很多所谓"直播源"其实是影视轮播库（分组名是 动作片/战争片/李玟/原创/手工绘画），
 * 它们在 TVBox 的直播板块里没有意义，而且占了 80% 的体积。
 */
const LIVE_GROUP_MODE = (process.env.LIVE_GROUP_MODE || "tv").toLowerCase();

/** 像电视频道的分组名 */
const TV_GROUP_RE = new RegExp(
  [
    "CCTV", "央视", "中央", "卫视", "卫星", "地方", "国内", "国际", "港澳", "香港", "澳门", "台湾",
    "体育", "新闻", "少儿", "卡通", "纪录", "剧场", "频道", "综合", "影视", "电影", "电视剧",
    "4K", "8K", "超清", "高清", "HD", "IPTV", "数字", "咪咕", "移动", "联通", "电信",
    "省", "市", "县", "区", "广播", "戏曲", "财经", "生活", "法制", "军事", "农业", "教育",
  ].join("|"),
  "i",
);

/** 明确是影视点播/歌库的分组名（这些一定不是直播频道） */
const VOD_GROUP_RE = new RegExp(
  [
    "动作片", "喜剧片", "爱情片", "科幻片", "恐怖片", "战争片", "剧情片", "纪录片", "动画片",
    "悬疑片", "冒险片", "犯罪片", "奇幻片", "伦理片", "恐怖", "综艺", "动漫", "短剧", "电视剧",
    "电影", "轮播", "点播", "原创", "手工", "绘画", "歌", "舞", "MV", "MTV",
  ].join("|"),
  "i",
);

/* ============================ 主流程 ============================ */

export async function runPipeline({ candidates, liveSeedSources = [], opts, onProgress } = {}) {
  const t0 = Date.now();
  const out = [];
  const stats = {
    candidates: candidates.length,
    fetched: 0,
    rawSites: 0,
    rawLives: 0,
    rawParses: 0,
    afterDedupSites: 0,
    afterDedupLives: 0,
    dropped: { dead: 0, slow: 0, local: 0, dup: 0, nonTv: 0 },
    fetchFail: [],
    subSources: [],
    removed: [], // 剔除报告
    skippedByBudget: 0,
    probeSkipped: 0,
    liveSkipped: 0,
  };
  let phaseStart = Date.now();

  /* ---------- 1. 抓取接口（带重试） ---------- */
  const fetched = new Map(); // url -> {config, size}
  const fetchResults = [];

  const fetchOne = async (url) => {
    for (const [attempt, timeout] of [
      [1, opts.fetchTimeout],
      [2, opts.fetchTimeout * 2],
    ]) {
      try {
        const r = await fetchTvboxConfig(url, { timeoutMs: timeout, maxDepth: 2, maxSubs: 30 });
        if (r.config) return { ok: true, ...r, url };
        if (attempt === 2) return { ok: false, url, error: r.error };
      } catch (e) {
        if (attempt === 2) return { ok: false, url, error: e.message };
      }
    }
    return { ok: false, url, error: "未知错误" };
  };

  await pool(candidates, opts.concurrencyFetch, async (cand) => {
    if (Date.now() - phaseStart > opts.budgetFetch * 1000) {
      stats.skippedByBudget++;
      return;
    }
    const r = await fetchOne(cand.url);
    fetchResults.push(r);
    if (r.ok) {
      fetched.set(cand.url, r);
      stats.fetched++;
      if (r.subSources?.length) stats.subSources.push(...r.subSources);
      onProgress?.(`✅ ${cand.url.slice(0, 70)}  站点 ${r.config.sites.length} / 直播 ${r.config.lives.length}${r.multi ? " [多仓]" : ""}`);
    } else {
      stats.fetchFail.push({ url: cand.url, error: r.error });
      onProgress?.(`⚠️ ${cand.url.slice(0, 70)} 失败：${r.error}`);
    }
  });

  /* ---------- 2. 站点汇总（含本地引用清理 / 分类） ---------- */
  const siteMap = new Map();
  const liveMap = new Map();
  const parseMap = new Map();
  const flagSet = new Set();
  let wallpaper = "";

  for (const [, r] of fetched) {
    const cfg = r.config;
    wallpaper ||= cfg.wallpaper || "";
    for (const site of cfg.sites) {
      if (opts.dropLocalRef && isLocalRef({ api: site.api, ext: site.ext, jar: site.jar })) {
        stats.dropped.local++;
        stats.removed.push({ kind: "site", name: site.name, api: site.api, reason: "引用本机地址(127.0.0.1)" });
        continue;
      }
      stats.rawSites++;
      const k = siteDedupKey(site);
      const exist = siteMap.get(k);
      if (exist) {
        stats.dropped.dup++;
        for (const s of r.subSources || []) void s;
        continue;
      }
      siteMap.set(k, { key: k, site, category: siteCategory(site) });
    }
    for (const live of cfg.lives) {
      const url = String(live.url || "");
      if (!/^https?:\/\//i.test(url)) continue;
      stats.rawLives++;
      const k = normUrl(url);
      if (liveMap.has(k)) {
        stats.dropped.dup++;
        continue;
      }
      liveMap.set(k, { live, origin: r.url });
    }
    for (const p of cfg.parses) {
      stats.rawParses++;
      const k = normUrl(String(p.url));
      if (k && !parseMap.has(k)) parseMap.set(k, p);
    }
    for (const f of cfg.flags) flagSet.add(String(f));
  }
  stats.afterDedupSites = siteMap.size;
  stats.grades = { fast: 0, ok: 0, uncertain: 0, unsure: 0, slow: 0, dead: 0 };
  stats.afterDedupLives = liveMap.size;

  onProgress?.(`汇总：站点 ${stats.rawSites} → ${siteMap.size}；直播 ${stats.rawLives} → ${liveMap.size}`);

  /* ---------- 3. 站点探活 + 测速 ---------- */
  const entries = [...siteMap.values()];
  const probeCache = new Map(); // URL -> probe result（同一个 URL 只测一次）

  const probeSite = async (e) => {
    const site = e.site;
    const cat = e.category;
    const api = String(site.api || "");
    const ck = `${cat}|${normUrl(api)}|${normUrl(String(site.ext ?? ""))}`;
    if (probeCache.has(ck)) return probeCache.get(ck);

    let res;
    try {
      if (cat === "cj") {
        const p = await probeCmsSite(api, { timeoutMs: 10000 });
        res = { ...p, grade: p.alive ? "ok" : "dead", probe: "cms" };
      } else if (cat === "py" || cat === "js") {
        // 主文件 + ext 文件都查
        const main = await probeScript(api, cat, { timeoutMs: opts.probeTimeout });
        res = { ...main, probe: cat };
        if (main.alive && typeof site.ext === "string" && /^https?:\/\//i.test(site.ext)) {
          const extP = await probeScript(site.ext, cat, { timeoutMs: opts.probeTimeout });
          if (!extP.alive && cat === "js") {
            // drpy 的 api 是通用 lib，ext 才是真正规则；ext 挂了整个站就废
            res = { ...extP, probe: "js-ext", alive: false, grade: "dead" };
          }
        }
      } else if (cat === "spider") {
        // ① jar 必须可下 ② ext 目标域名要活
        const jarUrl = site.jar || (await guessSpiderJar(fetched));
        let jarP = { alive: true, ttfb: 0, ms: 0, kbps: 0, reason: "内联spider" };
        if (jarUrl && /^https?:\/\//i.test(String(jarUrl))) {
          jarP = await probeJar(String(jarUrl), { timeoutMs: 12000 });
          res = { ...jarP, probe: "jar", alive: jarP.alive, grade: jarP.alive ? "ok" : "dead" };
        } else {
          res = { ...jarP, probe: "jar", alive: true, grade: "ok" };
        }
        // ext 里的目标站点抽 1 个探测
        const targets = extractExtTargets(site);
        if (targets.length) {
          const hp = await probeHost(targets[0], { timeoutMs: 6000 });
          if (!hp.alive) {
            res = { ...res, alive: false, grade: "dead", reason: `ext 目标站不可达 ${targets[0]}` };
          }
        }
      } else {
        // 其它：api 是 URL 就查，是 csp_ 就当作库存在（只能信任）
        if (/^https?:\/\//i.test(api)) {
          const p = await probeScript(api, "js", { timeoutMs: opts.probeTimeout });
          res = { ...p, probe: "other", grade: p.alive ? "ok" : "dead" };
        } else {
          res = { alive: true, ttfb: 0, ms: 0, kbps: 0, probe: "builtin", grade: "ok", reason: "内置爬虫" };
        }
      }
    } catch (err) {
      res = { alive: false, grade: "dead", probe: cat, reason: err.message };
    }



    // 抗误杀：限流/403 属于"服务器活着但拒绝我"。
    // 单独一个档位 uncertain —— 不能被 strict 当成慢站删掉，报告里也要说清原因。
    if (res.uncertain) {
      res = { ...res, alive: true, grade: "uncertain" };
      probeCache.set(ck, res);
      return res;
    }

    // 测速分档
    // 关键点：对 JS/Py/Jar 站来说，规则文件本身很小，快慢几乎无所谓；
    // 真正决定用起来卡不卡的是 ext 里指向的「目标站域名」。所以优先测那个。
    if (res.alive) {
      const targets = extractExtTargets(site);
      const speedUrl = targets[0] || (api.startsWith("http") ? api : String(site.ext || ""));
      if (speedUrl) {
        const m = await measureLatency(speedUrl, { timeoutMs: opts.probeTimeout, rounds: 2, maxBytes: 128 * 1024 });
        if (m.ok) {
          res = { ...res, ttfb: m.ttfb, ms: m.ms, kbps: m.kbps, speedUrl };
        } else if (targets.length && res.alive) {
          // 目标站连测速都失败 → 这站实际不可用
          res = { ...res, alive: false, grade: "dead", reason: `目标站测速失败 ${targets[0]}` };
        }
      }
    }
    res = { ...res, grade: res.alive ? gradeWithOpts(res, opts, e.category, site.api) : "dead" };

    probeCache.set(ck, res);
    return res;
  };

  /**
   * 分档：只按首字节（TTFB），不按吞吐
   *
   *  - 采集站 / Py / JS / 其它（测的是接口本身）：TTFB > slowTtfb 判慢
   *  - csp_* 内置爬虫站（测的是目标站首页）：阈值放宽到 crawlerSlowTtfb
   *  - 吞吐只写进报告供参考，不参与判定（小文件 KB/s 天然低，会误杀健康站）
   */
  const gradeWithOpts = (res, o, category, api) => {
    if (!res || !res.alive) return "dead";
    const ttfb = Number(res.ttfb) || 0;

    const isCrawler = category === "spider" && !/^https?:\/\//i.test(String(api || ""));
    const limit = isCrawler ? o.crawlerSlowTtfb : o.slowTtfb;

    if (ttfb <= 0) return "ok"; // 没有测速数据（内置爬虫等），按普通保留
    if (ttfb > limit) return "slow";
    if (ttfb <= o.fastTtfb) return "fast";
    return "ok"; // 精选~慢档阈值之间一律算普通，保留
  };

  /** 预算用尽：本轮没测到，不能算慢站（算慢站等于随机删站） */
  const markUnprobed = (e) => {
    e.probe = { alive: true, grade: "unsure", probe: "skipped", ttfb: null, kbps: null, reason: "本轮预算用尽，未完成测速（下轮补测）" };
    e.grade = "unsure";
    stats.probeSkipped++;
  };

  let probed = 0;
  phaseStart = Date.now();
  await pool(entries, opts.concurrencyProbe, async (e) => {
    if (Date.now() - phaseStart > opts.budgetProbe * 1000) {
      // 预算用尽：本轮没测到 ≠ 站慢。旧版直接标 slow，strict 下会被批量误删
      // （本地实测 3,134 个「太慢」里 3,011 个根本没测过）。现在单独标 unsure、保留。
      if (opts.keepUnprobed) markUnprobed(e);
      else { e.probe = { alive: false, grade: "dead", reason: "本轮预算用尽，未测" }; e.grade = "dead"; stats.probeSkipped++; }
      return;
    }
    const r = await probeSite(e);
    e.probe = r;
    e.grade = r.grade;
    if (r.uncertain) stats.uncertain++;
    stats.grades[r.grade] = (stats.grades[r.grade] || 0) + 1;
    probed++;
    if (probed % 100 === 0) onProgress?.(`  探活进度 ${probed}/${entries.length}`);
  });

  /* ---------- 4. 按策略决定保留谁 ---------- */
  const kept = [];
  for (const e of entries) {
    const g = e.grade || "dead";
    if (g === "dead") {
      stats.dropped.dead++;
      const uncertain = e.probe?.uncertain ? "（测不准，下轮重试）" : "";
      stats.removed.push({
        kind: "site",
        name: e.site.name,
        api: e.site.api,
        category: e.category,
        reason: (e.probe?.reason || "不可用") + uncertain,
      });
      continue;
    }
    // 测不准（限流/403/预算用尽没测到）：永远保留，strict 也不删，但要排后面
    if (g === "uncertain" || g === "unsure") {
      kept.push(e);
      continue;
    }
    if (g === "slow" && opts.strictness === "strict") {
      stats.dropped.slow++;
      const p = e.probe || {};
      const why =
        p.ttfb != null && p.ttfb > 0
          ? `太慢 TTFB=${p.ttfb}ms 吞吐=${p.kbps ?? "?"}KB/s`
          : `太慢（${p.reason || "无测速数据"}）`;
      stats.removed.push({
        kind: "site",
        name: e.site.name,
        api: e.site.api,
        category: e.category,
        reason: why,
      });
      continue;
    }
    kept.push(e);
  }

  // 内容指纹二次去重（同一资源站换域名）
  const byFingerprint = new Map();
  const finalSites = [];
  for (const e of kept) {
    const fp = e.probe?.sampleTitle ? contentFingerprint([e.probe.sampleTitle, e.probe.classes || ""]) : "";
    if (fp && byFingerprint.has(fp)) {
      const prev = byFingerprint.get(fp);
      const better = (GRADE_ORDER[e.grade] ?? 3) < (GRADE_ORDER[prev.grade] ?? 3) || (e.probe?.ttfb ?? 9e9) < (prev.probe?.ttfb ?? 9e9);
      if (better) {
        stats.dropped.dup++;
        stats.removed.push({ kind: "site", name: prev.site.name, api: prev.site.api, reason: "与另一站点内容相同(更快者保留)" });
        finalSites[finalSites.indexOf(prev)] = e;
        byFingerprint.set(fp, e);
      } else {
        stats.dropped.dup++;
        stats.removed.push({ kind: "site", name: e.site.name, api: e.site.api, reason: "与另一站点内容相同" });
      }
    } else {
      if (fp) byFingerprint.set(fp, e);
      finalSites.push(e);
    }
  }

  // 按速度排序：快的在前
  finalSites.sort((a, b) => {
    const ga = GRADE_ORDER[a.grade] ?? 3;
    const gb = GRADE_ORDER[b.grade] ?? 3;
    if (ga !== gb) return ga - gb;
    return (a.probe?.ttfb ?? 9e9) - (b.probe?.ttfb ?? 9e9);
  });

  /* ---------- 5. 直播：探活 + 测速 + 频道归一 ---------- */
  const liveList = [...liveMap.values()];
  const liveInfo = new Map();
  phaseStart = Date.now();
  await pool(liveList, opts.concurrencyLive, async (v) => {
    if (Date.now() - phaseStart > opts.budgetLive * 1000) {
      stats.liveSkipped++;
      liveInfo.set(v.live.url, { alive: false, reason: "本轮预算用尽，未检测", channels: [], hash: null, budgetSkipped: true });
      return;
    }
    try {
      const r = await fetchLive(String(v.live.url), v.live.ua, opts);
      liveInfo.set(v.live.url, r);
    } catch (e) {
      liveInfo.set(v.live.url, { alive: false, reason: e.message, channels: [], hash: null });
    }
  });

  // 内容哈希去重（完全相同的播放列表只留一个）
  const owner = new Map();
  const liveKept = [];
  for (const v of liveList) {
    const info = liveInfo.get(v.live.url);
    if (!info?.alive) {
      // 预算用尽的源下一轮还会再测，不能算永久失效
      const reason = info?.budgetSkipped ? "本轮预算用尽，下轮重测" : info?.reason || "不可用";
      stats.removed.push({ kind: "live", name: v.live.name, api: v.live.url, reason });
      continue;
    }
    if (info.hash && owner.has(info.hash)) {
      stats.dropped.dup++;
      stats.removed.push({ kind: "live", name: v.live.name, api: v.live.url, reason: "播放列表与另一源完全相同" });
      continue;
    }
    if (info.hash) owner.set(info.hash, v.live.url);
    liveKept.push({ ...v, info });
  }
  liveKept.sort((a, b) => (a.info.ttfb ?? 9e9) - (b.info.ttfb ?? 9e9));

  // 先统计每个分组的规模，用于整组过滤
  const groupSize = new Map();
  for (const v of liveKept) {
    for (const ch of v.info.channels) groupSize.set(ch.group, (groupSize.get(ch.group) || 0) + 1);
  }
  const droppedGroups = new Map(); // group -> 原因
  if (opts.filterNonTv) {
    for (const [g, n] of groupSize) {
      if (n > MAX_GROUP_CHANNELS) {
        droppedGroups.set(g, "分组过大(影音库)");
        continue;
      }
      if (VOD_GROUP_RE.test(g)) {
        droppedGroups.set(g, "影视点播分组");
        continue;
      }
      if (NON_TV_RE.test(g)) {
        droppedGroups.set(g, "非直播内容");
        continue;
      }
      // tv 模式：分组名不像电视频道就不收
      if (LIVE_GROUP_MODE === "tv" && !TV_GROUP_RE.test(g)) {
        droppedGroups.set(g, "非电视频道分组");
      }
    }
    if (droppedGroups.size) {
      const lost = [...droppedGroups.keys()].reduce((a, g) => a + groupSize.get(g), 0);
      stats.droppedGroups = [...droppedGroups].slice(0, 100).map(([g, why]) => ({ group: g, channels: groupSize.get(g), reason: why }));
      onProgress?.(`  分组过滤(${LIVE_GROUP_MODE} 模式)：剔除 ${droppedGroups.size} 个分组，共 ${lost} 条频道`);
    }
  }

  // 频道归一 + 每台保留 N 个源
  const channelMap = new Map(); // canon -> [{...ch}]
  let totalChannels = 0;
  for (const v of liveKept) {
    for (const ch of v.info.channels) {
      if (opts.filterNonTv && (droppedGroups.has(ch.group) || NON_TV_RE.test(ch.name) || NON_TV_RE.test(ch.group))) {
        stats.dropped.nonTv++;
        continue;
      }
      const canon = canonChannel(ch.name);
      if (!canon) continue;
      const list = channelMap.get(canon) || [];
      const key = normUrl(ch.url);
      if (list.some((x) => normUrl(x.url) === key)) continue;
      list.push({ ...ch, canon, fromSource: v.live.name, sourceTtfb: v.info.ttfb ?? 9e9 });
      channelMap.set(canon, list);
      totalChannels++;
    }
  }
  const mergedChannels = [];
  for (const [canon, list] of channelMap) {
    list.sort((a, b) => a.sourceTtfb - b.sourceTtfb);
    for (const ch of list.slice(0, opts.livePerChannel)) mergedChannels.push(ch);
  }
  // 稳定排序，减少每日 diff
  mergedChannels.sort((a, b) => (a.group === b.group ? a.canon.localeCompare(b.canon, "zh") : a.group.localeCompare(b.group, "zh")));

  /* ---------- 6. 组装输出 ---------- */
  const parseNamer = uniqueNamer({ keepSuffix: opts.keepSourceSuffix });
  const parses = [...parseMap.values()].map((p) => ({ ...p, name: parseNamer(String(p.name || "解析")) }));
  const flags = mergeFlags([...flagSet]);

  const pick = (c) => finalSites.filter((e) => e.category === c);
  const cjEntries = pick("cj");
  const pyEntries = pick("py");
  const jsEntries = pick("js");
  const spiderEntries = pick("spider");
  const otherEntries = pick("other");
  const union = [...finalSites];

  /* ---------- jar 引擎可用性 ----------
   * TVBox（FongMi / takagen99 等）加载站点时：sites[].jar 为空 → 用顶层 spider 兜底
   * （见 Site.objectFrom: if (site.getJar().isEmpty()) site.setJar(spider)）。
   * 所以顶层 spider 选错，整批站点都会"加载失败"——在 TVBox 里直接不显示。
   *
   * 实测过的坑：n3rddd/N3RD 的 xbpg.jar 里没有 QuickJS 引擎，
   * 但上游配了 688 个 drpy2（type=3, api=*.min.js）站点全靠它 → 全部打不开。
   * 这里给这类站点补一个确定带 QuickJS 的 jar，不再依赖顶层 spider。
   */
  const QUICKJS_JAR = process.env.QUICKJS_JAR || "https://raw.githubusercontent.com/qist/tvbox/master/jar/spider.jar";
  /** 去掉 jar 地址里的 ";md5;xxx"：md5 一旦上游改了文件内容，TVBox 会整包拒绝，全文件站点一起挂 */
  const stripMd5 = (jar) => String(jar || "").split(";md5;")[0].split(";")[0];

  /* 已知带 QuickJS 引擎的 jar（解包看过 classes.dex，有 com/whl/quickjs/*）：
   *   qist/tvbox .../jar/spider.jar（3,665 个类，QuickJS + XBPQ 全有）
   *   gaotianliuyun/gao .../jar/pg.jar（2,353 个类）
   * 已知【没有】QuickJS 的：n3rddd/N3RD .../xbpg.jar —— 上游拿它当顶层 spider，
   * 但它的配置里 688 个 drpy2 站点全靠它，所以那批站全部打不开。
   * 线上真实数据也能佐证：766 个带 jar 的 drpy2 站，没有一个用 xbpg.jar。
   */
  const JS_ENGINE_JAR_RE = /(^|\/)(spider\.jar|pg\.jar|py\.jar|spider_?js\.jar)(;|$)|gaotianliuyun|qist\/tvbox/i;
  // 站点要跑 JS 引擎吗（drpy2 / 各类 .js 壳）
  const needsJsEngine = (site) => {
    const api = String(site.api || "");
    if (!/^https?:\/\//i.test(api)) return false;
    if (/\.(py|php)(\?|$)/i.test(api)) return false;      // Py 站走 PyLoader，不需要 QuickJS
    if (/\.js(\?|$)/i.test(api)) return true;
    return /drpy/i.test(api);
  };
  const isCspClass = (site) => /^csp_/i.test(String(site.api || ""));

  /** 这个 jar 够不够跑这个站点 */
  const jarOkForSite = (site, jar) => {
    if (!jar) return false;
    if (isCspClass(site)) return true;                     // 内置类：候选 jar 都带 XBPQ 一族
    if (needsJsEngine(site)) return JS_ENGINE_JAR_RE.test(jar);  // JS 站必须确定带 QuickJS
    return true;
  };

  const mostCommonJar = (items) => {
    const count = new Map();
    for (const e of items) if (e.site.jar) count.set(String(e.site.jar), (count.get(String(e.site.jar)) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  };

  /** 顶层 spider：谁能让最多站点跑起来就用谁（并列时用出现次数多的） */
  const pickTopJar = (items) => {
    if (!items.length) return "";
    const cands = new Map();
    const bump = (j) => j && cands.set(j, (cands.get(j) || 0) + 1);
    for (const e of items) bump(stripMd5(String(e.site.jar || "")));
    bump(mostCommonJar(items));
    bump(QUICKJS_JAR);
    let best = "";
    let bestScore = -1;
    let bestCount = -1;
    for (const j of cands.keys()) {
      const score = items.filter((e) => jarOkForSite(e.site, String(e.site.jar || j))).length;
      const cnt = cands.get(j) || 0;
      if (score > bestScore || (score === bestScore && cnt > bestCount)) {
        best = j;
        bestScore = score;
        bestCount = cnt;
      }
    }
    return best;
  };

  const buildVod = (items) => {
    const topRaw = pickTopJar(items);
    const top = stripMd5(topRaw);
    const keyNamer = uniqueNamer({ keepSuffix: opts.keepSourceSuffix });
    const nameNamer = uniqueNamer({ keepSuffix: opts.keepSourceSuffix });
    const sites = items.map((e) => {
      const s = { ...e.site };
      s.key = keyNamer(String(s.key), e.probe?.reason || "");
      s.name = nameNamer(String(s.name ?? s.key));
      if (s.jar) s.jar = stripMd5(s.jar);
      // 要跑 JS 引擎但自己的 jar 不够 → 补上确定带 QuickJS 的
      if (needsJsEngine(s) && !jarOkForSite(s, String(s.jar || top))) s.jar = QUICKJS_JAR;
      // 自己没有 jar 且顶层也不够 → 显式写
      if (!s.jar && !jarOkForSite(s, top)) s.jar = QUICKJS_JAR;
      if (top && s.jar === top) delete s.jar;   // 与顶层相同的可以省掉
      return s;
    });
    return {
      ...(top ? { spider: top } : {}),
      ...(wallpaper ? { wallpaper } : {}),
      sites,
      parses,
      flags,
    };
  };

  const liveConfig = {
    lives: [
      { name: "海量直播·频道合并去重", type: 0, url: "__M3U_PLACEHOLDER__" },
      ...liveKept.map((v) => {
        const l = { ...v.live };
        delete l.name;
        return { ...l, name: v.live.name };
      }),
    ],
  };

  return {
    stats,
    files: {
      all: buildVod(union),
      cj: buildVod(cjEntries),
      py: buildVod(pyEntries),
      js: buildVod(jsEntries),
      spider: buildVod(spiderEntries),
      live: liveConfig,
    },
    counts: {
      all: union.length,
      cj: cjEntries.length,
      py: pyEntries.length,
      js: jsEntries.length,
      spider: spiderEntries.length,
      other: otherEntries.length,
      liveSources: liveKept.length,
      channels: mergedChannels.length,
      rawChannels: totalChannels,
    },
    m3u: buildM3u(mergedChannels, liveKept),
    fetchResults,
    elapsed: Math.round((Date.now() - t0) / 1000),
  };
}

/* ============================ 直播辅助 ============================ */

async function fetchLive(url, ua, opts) {
  const { httpGet } = await import("./core.mjs");
  let cur = url;
  const t0 = Date.now();
  let channels = [];
  let size = 0;
  for (let depth = 0; depth < 5; depth++) {
    const r = await httpGet(cur, { ua: typeof ua === "string" && ua ? ua : undefined, timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) {
      if (!channels.length) return { alive: false, reason: r.error || `HTTP ${r.status}`, channels: [] };
      break;
    }
    size = r.body.length;
    channels = parsePlaylist(r.body.toString("utf8"));
    if (channels.length) {
      const uniq = [...new Set(channels.map((c) => normUrl(c.url)))].sort();
      return {
        alive: true,
        channels,
        size,
        ttfb: r.ttfb,
        ms: Date.now() - t0,
        hash: contentFingerprint(uniq),
      };
    }
    const t = r.body.toString("utf8").trim();
    if (/^https?:\/\/\S+$/.test(t) && t !== cur) {
      cur = t;
      continue;
    }
    break;
  }
  return { alive: false, reason: "解析不出频道", channels: [] };
}

function buildM3u(channels, sources) {
  const epg = sources.map((s) => s.live.epg).find((e) => typeof e === "string" && /^https?:\/\//.test(e) && !e.includes("{"));
  const esc = (s) => String(s || "").replace(/["\r\n]/g, " ").trim();
  const lines = [`#EXTM3U${epg ? ` x-tvg-url="${esc(epg)}"` : ""}`];
  for (const ch of channels) {
    lines.push(
      `#EXTINF:-1 tvg-name="${esc(ch.name)}"${ch.logo ? ` tvg-logo="${esc(ch.logo)}"` : ""} group-title="${esc(ch.group)}",${esc(ch.name)}`,
    );
    lines.push(ch.url);
  }
  return lines.join("\n") + "\n";
}

/** flags 归并：优 酷 / 优酷 / 优酷视频 → 优酷 */
function mergeFlags(flags) {
  const canon = new Map();
  for (const f of flags) {
    const k = String(f).replace(/\s+/g, "").toLowerCase();
    if (!k) continue;
    if (!canon.has(k)) canon.set(k, String(f).trim());
    else if (String(f).trim().length < canon.get(k).length) canon.set(k, String(f).trim());
  }
  return [...new Set(canon.values())];
}

/** 从已抓到的配置里找最常见的 jar 作为兜底 */
async function guessSpiderJar(fetched) {
  const count = new Map();
  for (const [, r] of fetched) {
    if (r.config?.spider) count.set(r.config.spider, (count.get(r.config.spider) || 0) + 1);
    for (const s of r.config?.sites || []) if (s.jar) count.set(String(s.jar), (count.get(String(s.jar)) || 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

/* ============================ 输出 ============================ */

const FILES = {
  all: "点播合集.json",
  cj: "点播-采集站.json",
  py: "点播-Py站.json",
  js: "点播-JS站.json",
  spider: "点播-Jar爬虫站.json",
  live: "live.json",
  m3u: "live.m3u",
  readme: "README.md",
  removed: "剔除报告.json",
};

export async function writeOutputs({ result, opts, rawUrl, when }) {
  const dir = opts.outDir;
  await mkdir(dir, { recursive: true });

  const live = { ...result.files.live };
  live.lives = live.lives.map((l) =>
    l.url === "__M3U_PLACEHOLDER__" ? { ...l, url: encodeURI(rawUrl(FILES.m3u)) } : l,
  );

  const payload = {
    [FILES.all]: result.files.all,
    [FILES.cj]: result.files.cj,
    [FILES.py]: result.files.py,
    [FILES.js]: result.files.js,
    [FILES.spider]: result.files.spider,
    [FILES.live]: live,
  };
  for (const [name, data] of Object.entries(payload)) {
    await writeFile(join(dir, name), JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  await writeFile(join(dir, FILES.m3u), result.m3u, "utf8");

  // 剔除报告（可追溯：谁、为什么、实测多快）
  const removed = {
    更新时间: when,
    统计: result.stats.dropped,
    剔除列表: result.stats.removed.slice(0, 5000),
  };
  await writeFile(join(dir, FILES.removed), JSON.stringify(removed, null, 2) + "\n", "utf8");

  // README —— 站点数量放在最前面，一眼可见
  const c = result.counts;
  const g = result.stats.grades || {};
  const d = result.stats.dropped || {};
  const modeName = { strict: "严格（只留快站，慢站也删）", balanced: "平衡（删死站，慢站留文末）", loose: "宽松（只删死站）" }[opts.strictness] || opts.strictness;

  const readme = [
    "# 聚合接口（每日自动更新）",
    "",
    `**更新时间**：${when}（北京时间）　**策略**：${modeName}`,
    "",
    "## 📊 站点数量总览",
    "",
    "| 分类 | 输出站点数 | 文件 |",
    "| --- | ---: | --- |",
    `| **点播合集（全部）** | **${c.all}** | [${FILES.all}](${rawUrl(FILES.all)}) |`,
    `| 　采集站 | ${c.cj} | [${FILES.cj}](${rawUrl(FILES.cj)}) |`,
    `| 　Py 站 | ${c.py} | [${FILES.py}](${rawUrl(FILES.py)}) |`,
    `| 　JS 站 | ${c.js} | [${FILES.js}](${rawUrl(FILES.js)}) |`,
    `| 　Jar 爬虫站 | ${c.spider} | [${FILES.spider}](${rawUrl(FILES.spider)}) |`,
    `| 　其它 | ${c.other} | 包含在合集内 |`,
    `| **直播源** | **${c.liveSources}** | [${FILES.live}](${rawUrl(FILES.live)}) |`,
    `| **直播频道** | **${c.channels}** | [${FILES.m3u}](${rawUrl(FILES.m3u)}) |`,
    "",
    `> 以上 ${c.all} 个点播站点全部通过存活检测${opts.strictness === "strict" ? "与测速筛选（慢站已剔除）" : ""}，按实测速度排序，快的在前。`,
    "",
    "## 🔍 本轮过滤明细",
    "",
    "| 环节 | 数量 | 说明 |",
    "| --- | ---: | --- |",
    `| 候选接口 | ${result.stats.candidates} | 从收集池挑选 |`,
    `| 接口抓取成功 | ${result.stats.fetched} | 含多仓递归 |`,
    `| 原始站点 | ${result.stats.rawSites} | 抓到的全部条目 |`,
    `| 去重后 | ${result.stats.afterDedupSites} | 去掉 ${d.dup || 0} 条重复 |`,
    `| 　├ 剔除·失效 | ${d.dead || 0} | 连不上/内容异常 |`,
    `| 　├ 剔除·太慢 | ${d.slow || 0} | 首字节超阈值（已实测） |`,
    `| 　├ 剔除·本机引用 | ${d.local || 0} | 127.0.0.1 等 |`,
    `| 　└ 剔除·非直播内容 | ${d.nonTv || 0} | 直播侧，MV/点歌台等 |`,
    `| **最终输出** | **${c.all}** | |`,
    "",
    "### 速度分档（探活结果）",
    "",
    "| 档位 | 数量 | 处理 |",
    "| --- | ---: | --- |",
    `| 🟢 精选（TTFB≤${opts.fastTtfb}ms） | ${g.fast || 0} | 保留，排最前 |`,
    `| 🔵 正常（${opts.fastTtfb}<TTFB≤${opts.slowTtfb}ms） | ${g.ok || 0} | 保留 |`,
    `| 🟡 偏慢（TTFB>${opts.slowTtfb}ms） | ${g.slow || 0} | ${opts.strictness === "strict" ? "**已剔除**" : "保留在文末"} |`,
    `| 🟠 测不准（限流/403） | ${g.uncertain || 0} | 保留（下轮重测） |`,
    `| ⚪ 未测到（本轮预算用尽） | ${g.unsure || 0} | 保留（下轮补测） |`,
    `| 🔴 失效 | ${g.dead || 0} | 已剔除 |`,
    "",
    `> 判定阈值（只看首字节，故意不看吞吐）：普通站 TTFB>${opts.slowTtfb}ms 判慢，内置爬虫站（csp_*）放宽到 ${opts.crawlerSlowTtfb}ms —— 内置站测的是目标站首页，HTML 更重。`,
    `> 不看吞吐的原因：接口本身就是几十 KB 的 JSON/脚本，KB/s 低只代表文件小，点开几乎秒开；按吞吐会把 TTFB 一两百毫秒的健康站误删。`,
    "",
    "## 📁 剔除报告",
    "",
    `完整明细见 [${FILES.removed}](${rawUrl(FILES.removed)})：每条被删站点都记录了名称、地址、原因和实测速度，方便你抽查有没有误杀。`,
    "",
    "---",
    "",
    "接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习。",
    "",
  ].join("\n");
  await writeFile(join(dir, FILES.readme), readme, "utf8");

  /* ---------- 根目录 README 的站点数量自动回写 ----------
   * 根 README 是静态文档，不会每天更新；这里只替换其中的「站点数量」标记块，
   * 保证文档里的数字永远和产物一致（不会出现"文档写 4653、实际 4234"）。
   */
  try {
    const rootReadme = await readFile("README.md", "utf8");
    const stats = [
      `<!-- 站点数量:start（由每日聚合自动生成，勿手改） -->`,
      `> **最新数量**（${when} 更新）：点播合集 **${c.all}**（采集 ${c.cj} · Py ${c.py} · JS ${c.js} · Jar ${c.spider} · 其它 ${c.other}）｜直播源 **${c.liveSources}**｜直播频道 **${c.channels}**`,
      `<!-- 站点数量:end -->`,
    ].join("\n");
    // 表格里的数量单元格：用「文件名 → 该行数量格」的方式定位，
    // 这样即使标记被误删/被替换成纯数字，也能自我修复（幂等）
    const numRows = [
      ["点播合集.json", "all", ""],
      ["点播-采集站.json", "cj", ""],
      ["点播-Py站.json", "py", ""],
      ["点播-JS站.json", "js", ""],
      ["点播-Jar爬虫站.json", "spider", ""],
      ["live.json", "liveSources", " 个源"],
      ["live.m3u", "channels", " 个频道"],
    ];
    let out = rootReadme;
    for (const [file, key, suffix] of numRows) {
      const val = c[key] ?? "?";
      const cell = `<!--NUM:${key}-->${val}${suffix}`;
      const re = new RegExp(
        `(\\|\\s*${file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\|[^\\n|]*\\|)\\s*[^|]*(\\|\\s*https://raw\\.githubusercontent)`,
      );
      if (re.test(out)) out = out.replace(re, (m, a, b) => `${a} ${cell} ${b}`);
    }

    if (out.includes("<!-- 站点数量:start")) {
      out = out.replace(/<!-- 站点数量:start[\s\S]*?<!-- 站点数量:end -->/, stats);
    } else {
      // 首次：插在第一个二级标题之前
      const idx = out.indexOf("\n## ");
      out = idx > 0 ? out.slice(0, idx) + "\n" + stats + "\n" + out.slice(idx) : out + "\n" + stats + "\n";
    }
    if (out !== rootReadme) await writeFile("README.md", out, "utf8");
  } catch {
    /* 根 README 不存在就算了 */
  }

  const sizes = [];
  for (const f of [...Object.keys(payload), FILES.m3u, FILES.readme, FILES.removed]) {
    try {
      const st = await stat(join(dir, f));
      sizes.push([f, st.size]);
    } catch {
      /* ignore */
    }
  }
  return sizes;
}

/** 与上次产物比较，防止异常时用空壳覆盖 */
export async function readPreviousCounts(outDir) {
  try {
    const raw = await readFile(join(outDir, FILES.all), "utf8");
    const d = JSON.parse(raw);
    return { sites: (d.sites || []).length };
  } catch {
    return null;
  }
}

export { FILES };
