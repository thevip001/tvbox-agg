/**
 * pipeline.mjs —— 筛选整理层：探活 → 测速 → 去重 → 分类 → 输出
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GRADE_ORDER,
  contentFingerprint,
  httpGet,
  isBlockedUrl,
  measureLatency,
  normUrl,
  pool,
  siteCategory,
  siteDedupKey,
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
    // 直播：每个源随机抽查几个频道，全失败就剔除整个源（只剔不合，不产出合并列表）
    liveProbeChannels: Number(env.LIVE_PROBE_CHANNELS || 3),
    liveProbeTimeout: Number(env.LIVE_PROBE_TIMEOUT_MS || 6000),
    concurrencyLiveProbe: Number(env.LIVE_PROBE_WORKERS || 12),
    budgetLiveProbe: Number(env.BUDGET_LIVE_PROBE || 300),
    // 点播：输出只保留「精选(fast)」档，其余进剔除报告（池子不受影响，下轮重测还有机会）
    vodFastOnly: (env.VOD_ONLY_FAST || "1") !== "0",
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

/**
 * 站点的哪个功能字段命中屏蔽域名（config/blocked-hosts.txt）。
 * 只看 jar / api / ext / playUrl / url 这五个「真会发起连接」的字段；
 * logo 之类装饰字段不算（图挂了只是不显示，不该因此删掉整个站）。
 * 命中返回 { field, host }，没命中返回 null。
 */
function blockedFieldHit(site, hosts) {
  if (!hosts || !hosts.size) return null;
  for (const field of ["jar", "api", "ext", "playUrl", "url"]) {
    const v = site[field];
    if (typeof v !== "string" || !v) continue;
    const h = isBlockedUrl(v, hosts);
    if (h) return { field, host: h };
  }
  return null;
}

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

/* 频道归一 canonChannel() 与分组过滤的四个正则（NON_TV_RE / TV_GROUP_RE / VOD_GROUP_RE /
 * MAX_GROUP_CHANNELS）已于 2026-11-22 随「直播只剔不合、不再合并」一起删除：
 * 它们只服务于频道级合并输出，现在不产出合并列表，留着就是死代码。 */

/* ============================ 直播源清单种子 ============================ */

/**
 * 解析 config/liveupstreams.txt：每行「名称, URL, 类型」。
 *   类型 txt / m3u = 播放列表（直接产出频道）
 *   类型 json      = 多仓/接口索引（不是播放列表，会被明确拒绝并提示换文件）
 * 这是仓库里的静态文件，跟「去上游捞新接口」是两件事，所以 --no-collect 也该照常生效。
 */
export function parseLiveSeeds(text) {
  const out = [];
  const bad = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    const url = parts.find((x) => /^https?:\/\//i.test(x));
    if (!url) continue;
    const declared = (parts.find((x) => /^(txt|m3u|json|depot)$/i.test(x)) || "txt").toLowerCase();
    let name = parts[0] === url ? "" : parts[0];
    if (!name) {
      try {
        name = new URL(url).hostname;
      } catch {
        name = "直播源";
      }
    }
    if (declared === "json" || declared === "depot" || /\.json(\?|$)/i.test(url)) {
      // 这类文件里是「一堆接口地址」，不是频道列表；解析不出频道只会白占一次探活
      bad.push({ name, url });
      continue;
    }
    out.push({ name, url, type: declared === "m3u" ? "m3u" : "txt", origin: "config/liveupstreams.txt" });
  }
  return { seeds: out, rejected: bad };
}

/**
 * 把直播源清单种子并进 liveMap。
 *
 * 为什么要单独一层：这些清单是别人已经做过测速/筛选的公开直播源，质量比从点播接口
 * lives 里顺手捞出来的杂源高，所以给它们两个特权（在 runPipeline 里兑现）：
 *   1. 排在 liveList 最前 —— pool 按数组顺序取任务，预算不够时先保证种子被测到；
 *      内容哈希去重又是「先到先得」，所以种子优先当正本，副本被剔。
 *   2. 不受本轮直播预算限制 —— 绝不会因为「预算用尽」被判死。
 * 同一个地址如果点播接口里也有，就地升级成种子（不重复计一条）。
 */
export function mergeLiveSeeds(liveMap, seeds = [], stats = null) {
  let added = 0;
  let promoted = 0;
  for (const s of seeds || []) {
    const url = String(s?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const k = normUrl(url);
    const exist = liveMap.get(k);
    if (exist) {
      exist.seed = true;
      promoted++;
      continue;
    }
    const live = { name: String(s.name || "直播源"), type: 0, url };
    if (typeof s.ua === "string" && s.ua) live.ua = s.ua;
    if (typeof s.epg === "string" && s.epg) live.epg = s.epg;
    liveMap.set(k, { live, origin: s.origin || "config/liveupstreams.txt", seed: true });
    added++;
  }
  if (stats) {
    stats.rawLives = (stats.rawLives || 0) + added;
    stats.liveSeeds = added + promoted;
    stats.liveSeedsNew = added;
    stats.liveSeedsPromoted = promoted;
  }
  return { added, promoted };
}

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
    dropped: { dead: 0, slow: 0, local: 0, dup: 0, blocked: 0, notFast: 0, liveProbe: 0 },
    fetchFail: [],
    subSources: [],
    removed: [], // 剔除报告
    skippedByBudget: 0,
    probeSkipped: 0,
    liveSkipped: 0,
    // 直播源清单种子（config/liveupstreams.txt）
    liveSeeds: 0,
    liveSeedsNew: 0,
    liveSeedsPromoted: 0,
    liveSeedsKept: 0,
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
      // 屏蔽域名一票否决：典型场景是上游把 spider jar 挂在报毒/客服类域名下，
      // TVBox 的 java 进程一加载就去连，杀毒软件会一直拦。整站剔除，不给它换壳的机会。
      const bh = blockedFieldHit(site, opts.blockedHosts);
      if (bh) {
        stats.dropped.blocked++;
        stats.removed.push({
          kind: "site",
          name: site.name,
          api: site.api,
          reason: `${bh.field} 命中屏蔽域名 ${bh.host}（config/blocked-hosts.txt）`,
        });
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
      const bl = isBlockedUrl(url, opts.blockedHosts);
      if (bl) {
        stats.dropped.blocked++;
        stats.removed.push({ kind: "live", name: live.name, api: url, reason: `命中屏蔽域名 ${bl}（config/blocked-hosts.txt）` });
        continue;
      }
      stats.rawLives++;
      const k = normUrl(url);
      if (liveMap.has(k)) {
        stats.dropped.dup++;
        continue;
      }
      liveMap.set(k, { live, origin: r.url });
    }
    for (const p of cfg.parses) {
      const bp = isBlockedUrl(String(p.url || ""), opts.blockedHosts);
      if (bp) {
        stats.dropped.blocked++;
        stats.removed.push({ kind: "parse", name: p.name, api: p.url, reason: `命中屏蔽域名 ${bp}（config/blocked-hosts.txt）` });
        continue;
      }
      stats.rawParses++;
      const k = normUrl(String(p.url));
      if (k && !parseMap.has(k)) parseMap.set(k, p);
    }
    for (const f of cfg.flags) flagSet.add(String(f));
  }
  stats.afterDedupSites = siteMap.size;
  stats.grades = { fast: 0, ok: 0, uncertain: 0, unsure: 0, slow: 0, dead: 0 };

  /* 直播源清单种子（config/liveupstreams.txt）：独立于点播接口，本身就是频道列表 */
  const seedMerge = mergeLiveSeeds(liveMap, liveSeedSources, stats);
  if (seedMerge.added || seedMerge.promoted) {
    onProgress?.(
      `  直播种子：新增 ${seedMerge.added} 条，点播接口里已有、升级为种子 ${seedMerge.promoted} 条（优先测、优先当正本）`,
    );
  }
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
  let kept = [];
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

  /* ---------- 4b. 点播只留快站 ---------- */
  kept = selectFastOnly(kept, opts, stats);

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

  /* ---------- 5. 直播：探活 + 测速 + 内容去重（不合并频道） ---------- */
  // 种子源排最前：pool 按数组顺序派活，预算不够时先保证种子被测到；
  // 后面的内容哈希去重是「先到先得」，种子也就自然成了正本。（sort 稳定，其余顺序不变）
  const liveList = [...liveMap.values()].sort((a, b) => (b.seed ? 1 : 0) - (a.seed ? 1 : 0));
  const liveInfo = new Map();
  phaseStart = Date.now();
  await pool(liveList, opts.concurrencyLive, async (v) => {
    // 种子只有几条，且是人工确认过的清单，永远不受本轮预算限制
    if (!v.seed && Date.now() - phaseStart > opts.budgetLive * 1000) {
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
    const tag = v.seed ? "（直播源清单种子）" : "";
    if (!info?.alive) {
      // 预算用尽的源下一轮还会再测，不能算永久失效
      const reason = info?.budgetSkipped ? "本轮预算用尽，下轮重测" : info?.reason || "不可用";
      stats.removed.push({ kind: "live", name: v.live.name, api: v.live.url, reason: reason + tag });
      continue;
    }
    if (info.hash && owner.has(info.hash)) {
      stats.dropped.dup++;
      stats.removed.push({
        kind: "live",
        name: v.live.name,
        api: v.live.url,
        reason: `播放列表与另一源完全相同（正本：${owner.get(info.hash)}）${tag}`,
      });
      continue;
    }
    if (info.hash) owner.set(info.hash, v.live.url);
    liveKept.push({ ...v, info });
  }
  liveKept.sort((a, b) => (a.info.ttfb ?? 9e9) - (b.info.ttfb ?? 9e9));

  /* ---------- 5b. 频道抽查：每个源随机抽几个频道实测，全失败就剔除整个源 ----------
   * 只剔不合、不做合并：不产出任何频道级合并列表，live.json 里只留「源」本身。
   * 抽查的是频道流地址（m3u8/ts/flv…），看「能不能连通、有没有内容」；
   * 证书校验不在这层管（管道侧一律宽松），交给客户端自己的策略。 */
  const sampleSize = Math.max(1, opts.liveProbeChannels);
  phaseStart = Date.now();
  const probeInfo = new Map(); // url -> { sample, results, ok } | { skipped: true }
  await pool(liveKept, opts.concurrencyLiveProbe, async (v) => {
    if (!v.seed && Date.now() - phaseStart > opts.budgetLiveProbe * 1000) {
      stats.liveProbeSkipped = (stats.liveProbeSkipped || 0) + 1;
      probeInfo.set(v.live.url, { skipped: true });
      return;
    }
    const sample = pickSample(v.info.channels || [], sampleSize);
    if (!sample.length) {
      // 没频道可抽（理论上探活阶段就该被剔了），不凭 0 个样本判死
      probeInfo.set(v.live.url, { sample: [], results: [], ok: 0 });
      return;
    }
    const results = await Promise.all(sample.map((ch) => probeChannel(ch, v.live.ua, opts)));
    probeInfo.set(v.live.url, { sample, results, ok: results.filter((r) => r.ok).length });
  });

  const liveFinal = [];
  for (const v of liveKept) {
    const p = probeInfo.get(v.live.url);
    const tag = v.seed ? "（直播源清单种子）" : "";
    if (p?.skipped) {
      // 预算用尽 ≠ 频道全死：保留，下轮再抽
      liveFinal.push(v);
      continue;
    }
    if (p && p.ok === 0 && p.sample.length) {
      stats.dropped.liveProbe++;
      const detail = p.sample.map((ch, i) => `${ch.name}→${p.results[i].reason}`).join("；");
      stats.removed.push({
        kind: "live",
        name: v.live.name,
        api: v.live.url,
        reason: `抽查 ${p.sample.length} 个频道全部失败（${detail}）${tag}`,
      });
      continue;
    }
    if (v.seed) stats.liveSeedsKept++;
    stats.liveProbed = (stats.liveProbed || 0) + 1;
    liveFinal.push(v);
  }
  liveFinal.sort((a, b) => (a.info.ttfb ?? 9e9) - (b.info.ttfb ?? 9e9));
  onProgress?.(
    `  频道抽查：${liveKept.length} 个源各抽 ≤${sampleSize} 频道（实测 ${stats.liveProbed || 0} 源${stats.liveProbeSkipped ? `，预算跳过 ${stats.liveProbeSkipped} 源` : ""}），` +
      `全死剔除 ${stats.dropped.liveProbe} 个，剩 ${liveFinal.length} 个源`,
  );

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

  /* 直播接口 = 「通过抽查的源」本身，不再置顶任何合并列表 */
  const liveConfig = {
    lives: liveFinal.map((v) => {
      const l = { ...v.live };
      delete l.name;
      return { ...l, name: v.live.name };
    }),
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
      liveSources: liveFinal.length,
    },
    fetchResults,
    elapsed: Math.round((Date.now() - t0) / 1000),
  };
}

/* ============================ 直播辅助 ============================ */

/**
 * 「解析不出频道」太笼统，排查时根本看不出是配错了还是源挂了。
 * 把最常见的两种误配说清楚：多仓索引 JSON、HTML 页面。
 */
function noChannelReason(text) {
  const t = String(text || "").trim();
  if (!t) return "空内容";
  if (/^[{[]/.test(t) && /"(urls|sites|lives|storeHouse|API_LIST)"\s*:/.test(t)) {
    return "内容是多仓/接口索引 JSON，不是播放列表（这类清单应放进 config/upstreams.txt）";
  }
  if (/^<!doctype html|^<html/i.test(t)) return "返回的是 HTML 页面，不是播放列表";
  return "解析不出频道";
}

async function fetchLive(url, ua, opts) {
  const { httpGet } = await import("./core.mjs");
  let cur = url;
  const t0 = Date.now();
  let channels = [];
  let size = 0;
  let lastText = "";
  for (let depth = 0; depth < 5; depth++) {
    const r = await httpGet(cur, { ua: typeof ua === "string" && ua ? ua : undefined, timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) {
      if (!channels.length) return { alive: false, reason: r.error || `HTTP ${r.status}`, channels: [] };
      break;
    }
    size = r.body.length;
    lastText = r.body.toString("utf8");
    channels = parsePlaylist(lastText);
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
    const t = lastText.trim();
    if (/^https?:\/\/\S+$/.test(t) && t !== cur) {
      cur = t;
      continue;
    }
    break;
  }
  return { alive: false, reason: noChannelReason(lastText), channels: [] };
}

/**
 * 点播只留快站（VOD_ONLY_FAST，默认开）：
 * 其余档位（正常/偏慢/测不准/未测到）本轮不进产物，但**不进死名单** ——
 * 池子照旧保留它们，下轮探活测成 fast 还会回来，所以这不是「删除」而是「本轮不收录」。
 */
function selectFastOnly(kept, opts, stats) {
  if (!opts.vodFastOnly) return kept;
  const fast = [];
  for (const e of kept) {
    if (e.grade === "fast") {
      fast.push(e);
      continue;
    }
    stats.dropped.notFast++;
    stats.removed.push({
      kind: "site",
      name: e.site.name,
      api: e.site.api,
      category: e.category,
      reason: `非快站（档位=${e.grade} TTFB=${e.probe?.ttfb ?? "?"}ms），本轮只收录快站`,
    });
  }
  return fast;
}

/** 随机抽 n 条（Fisher–Yates 洗牌后取前 n）；抽查就是要随机，每轮重抽 */
function pickSample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

/**
 * 探一个频道流地址：只看「连通 + 有内容」，取前 64KB 就够。
 * 证书照样宽松（rejectUnauthorized:false 在 core.mjs 里统一管），这层只判断死没死。
 */
async function probeChannel(ch, ua, opts) {
  const r = await httpGet(ch.url, {
    ua: typeof ua === "string" && ua ? ua : undefined,
    timeoutMs: opts.liveProbeTimeout,
    maxBytes: 64 * 1024,
  });
  if (!r.ok) return { ok: false, reason: r.error || `HTTP ${r.status}` };
  if (!r.body.length) return { ok: false, reason: "空内容" };
  return { ok: true, ttfb: r.ttfb };
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
  readme: "README.md",
  removed: "剔除报告.json",
};

export async function writeOutputs({ result, opts, rawUrl, when }) {
  const dir = opts.outDir;
  await mkdir(dir, { recursive: true });

  const payload = {
    [FILES.all]: result.files.all,
    [FILES.cj]: result.files.cj,
    [FILES.py]: result.files.py,
    [FILES.js]: result.files.js,
    [FILES.spider]: result.files.spider,
    [FILES.live]: result.files.live,
  };
  for (const [name, data] of Object.entries(payload)) {
    await writeFile(join(dir, name), JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  // 剔除报告（可追溯：谁、为什么、实测多快）
  const removed = {
    更新时间: when,
    统计: result.stats.dropped,
    剔除列表: result.stats.removed.slice(0, 5000),
  };
  await writeFile(join(dir, FILES.removed), JSON.stringify(removed, null, 2) + "\n", "utf8");

  // README —— 站点数量放在最前面，一眼可见
  const c = result.counts;
  const s = result.stats;
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
    `| **直播源** | **${c.liveSources}**${s.liveSeedsKept ? `（含清单种子 ${s.liveSeedsKept}）` : ""} | [${FILES.live}](${rawUrl(FILES.live)}) |`,
    "",
    `> 以上 ${c.all} 个点播站点${opts.vodFastOnly ? `全部是实测 TTFB≤${opts.fastTtfb}ms 的快站（本轮只收录快站）` : "全部通过存活检测"}，按实测速度排序，快的在前。`,
    `> 直播源均通过「随机抽查 ${opts.liveProbeChannels} 个频道、全失败即剔除」；不再产出频道合并列表，live.json 里只有源本身。`,
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
    `| 　├ 剔除·屏蔽域名 | ${d.blocked || 0} | config/blocked-hosts.txt 一票否决（jar/api/ext/直播/解析） |`,
    `| 　├ 剔除·非快站 | ${d.notFast || 0} | 点播侧，本轮只收录快站（池子保留，下轮重测） |`,
    `| 　└ 剔除·直播抽查全死 | ${d.liveProbe || 0} | 每源随机抽 ${opts.liveProbeChannels} 个频道全部失败（实测 ${s.liveProbed || 0} 源${s.liveProbeSkipped ? `，预算跳过 ${s.liveProbeSkipped} 源` : ""}） |`,
    `| 直播源清单种子 | ${s.liveSeeds || 0} | config/liveupstreams.txt：新增 ${s.liveSeedsNew || 0}、点播接口里已有并升级 ${s.liveSeedsPromoted || 0}、存活保留 ${s.liveSeedsKept || 0} |`,
    `| **最终输出** | **${c.all}** | |`,
    "",
    "### 速度分档（探活结果）",
    "",
    "| 档位 | 数量 | 处理 |",
    "| --- | ---: | --- |",
    `| 🟢 精选（TTFB≤${opts.fastTtfb}ms） | ${g.fast || 0} | ${opts.vodFastOnly ? "**唯一收录档**，排最前" : "保留，排最前"} |`,
    `| 🔵 正常（${opts.fastTtfb}<TTFB≤${opts.slowTtfb}ms） | ${g.ok || 0} | ${opts.vodFastOnly ? "不收录（下轮重测）" : "保留"} |`,
    `| 🟡 偏慢（TTFB>${opts.slowTtfb}ms） | ${g.slow || 0} | ${opts.vodFastOnly ? "不收录" : opts.strictness === "strict" ? "**已剔除**" : "保留在文末"} |`,
    `| 🟠 测不准（限流/403） | ${g.uncertain || 0} | ${opts.vodFastOnly ? "不收录（下轮重测）" : "保留（下轮重测）"} |`,
    `| ⚪ 未测到（本轮预算用尽） | ${g.unsure || 0} | ${opts.vodFastOnly ? "不收录（下轮补测）" : "保留（下轮补测）"} |`,
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
      `> **最新数量**（${when} 更新）：点播合集 **${c.all}**（采集 ${c.cj} · Py ${c.py} · JS ${c.js} · Jar ${c.spider} · 其它 ${c.other}，只含快站）｜直播源 **${c.liveSources}**（抽查存活）`,
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
  for (const f of [...Object.keys(payload), FILES.readme, FILES.removed]) {
    try {
      const st = await stat(join(dir, f));
      sizes.push([f, st.size]);
    } catch {
      /* ignore */
    }
  }
  return sizes;
}

export { FILES, selectFastOnly, pickSample };
