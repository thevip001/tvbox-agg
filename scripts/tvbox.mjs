/**
 * tvbox.mjs —— TVBox 配置的解析与规范化
 *
 * 相比你的旧脚本，这里补齐了原项目完全没有的两个能力：
 *  1. 多仓递归：响应里是 { urls: [...] } 或 { storeHouse: [...] }（多仓入口）时，
 *     递归拉取所有子仓，并把子仓地址回传出来（作为下一轮的种子）。
 *  2. 规范化：相对路径补全、lives 新旧格式统一、type3 自动继承顶层 spider。
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { decodeConfigText, httpGet, normUrl, parseLooseJson, resolveUrl } from "./core.mjs";

/* ---------------- 抓取缓存 ---------------- */
/**
 * 每日定时任务里，单次运行不需要缓存；
 * 但本地反复调试 / 同一天多次运行 时，缓存能省掉 80% 的抓取时间。
 * 用 CACHE_DIR 指定目录启用（设为空字符串即关闭）。
 */
const CACHE_DIR = process.env.CACHE_DIR ?? "data/cache";

export async function cachedLoadRaw(url, timeoutMs, ttlSec = Number(process.env.CACHE_TTL || 1800)) {
  if (!CACHE_DIR) return loadRaw(url, timeoutMs);
  const key = createHash("sha1").update(url).digest("hex");
  const file = `${CACHE_DIR}/${key}.json`;

  // 1) 命中缓存
  try {
    const o = JSON.parse(await readFile(file, "utf8"));
    if (o.at && Date.now() - o.at < ttlSec * 1000 && o.url === url) {
      const buf = Buffer.from(o.body, "base64");
      try {
        const data = parseLooseJson(decodeConfigText(buf));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("bad");
        return { data, size: buf.length, finalUrl: o.finalUrl || url, cached: true };
      } catch {
        /* 缓存内容坏了就当没命中 */
      }
    }
  } catch {
    /* 未命中 */
  }

  // 2) 走网络（只发一次请求）
  const r = await httpGet(url, { timeoutMs });
  if (!r.ok) return { size: 0, error: r.error || `HTTP ${r.status}`, finalUrl: r.finalUrl };
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ at: Date.now(), url, finalUrl: r.finalUrl, body: r.body.toString("base64") }),
      "utf8",
    );
  } catch {
    /* 缓存写失败不影响主流程 */
  }

  // 3) 复用同一份响应体解析，不再发第二次请求
  const text = decodeConfigText(r.body);
  let data;
  try {
    data = parseLooseJson(text);
  } catch {
    return { size: r.body.length, error: "JSON 解析失败", finalUrl: r.finalUrl };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { size: r.body.length, error: "不是有效的 JSON 对象", finalUrl: r.finalUrl };
  }
  return { data, size: r.body.length, finalUrl: r.finalUrl };
}

/** 单次拉取并解析，不递归 */
export async function loadRaw(url, timeoutMs = 20000) {
  const r = await httpGet(url, { timeoutMs });
  if (!r.ok) return { size: 0, error: r.error || `HTTP ${r.status}`, finalUrl: r.finalUrl };
  const text = decodeConfigText(r.body);
  let data;
  try {
    data = parseLooseJson(text);
  } catch {
    return { size: r.body.length, error: "JSON 解析失败", finalUrl: r.finalUrl };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { size: r.body.length, error: "不是有效的 JSON 对象", finalUrl: r.finalUrl };
  }
  return { data, size: r.body.length, finalUrl: r.finalUrl };
}

/** 旧版 lives（group + channels，proxy 链接里带 base64 地址）统一成 {name,type,url} */
function normalizeLives(lives, base) {
  if (!Array.isArray(lives)) return [];
  const out = [];
  for (const l of lives) {
    if (!l || typeof l !== "object") continue;
    if (typeof l.url === "string" && l.url) {
      const live = { ...l, name: String(l.name || l.group || "直播"), url: resolveUrl(l.url, base) };
      if (l.epg) live.epg = resolveUrl(l.epg, base);
      if (l.logo) live.logo = resolveUrl(l.logo, base);
      out.push(live);
      continue;
    }
    if (Array.isArray(l.channels)) {
      for (const ch of l.channels) {
        const urls = Array.isArray(ch?.urls) ? ch.urls : [];
        for (const u of urls) {
          const m = /ext=([^&]+)/.exec(String(u));
          let url = "";
          if (m) {
            try {
              url = Buffer.from(decodeURIComponent(m[1]), "base64").toString("utf8").trim();
            } catch {
              /* 解码失败跳过 */
            }
          } else if (/^https?:\/\//.test(String(u))) {
            url = String(u);
          }
          if (/^https?:\/\//.test(url)) out.push({ name: String(ch.name || l.group || "直播"), type: 0, url });
        }
      }
    }
  }
  return out;
}

/** 把一份配置整理成统一结构 */
export function normalizeConfig(cfg, base) {
  const spider = typeof cfg.spider === "string" ? resolveUrl(cfg.spider, base) : undefined;
  const sites = [];
  for (const raw of Array.isArray(cfg.sites) ? cfg.sites : []) {
    if (!raw || typeof raw !== "object" || !raw.api || !raw.key) continue;
    const s = { ...raw };
    s.api = resolveUrl(s.api, base);
    if (typeof s.ext === "string") s.ext = resolveUrl(s.ext, base);
    if (s.jar) s.jar = resolveUrl(s.jar, base);
    if (Number(s.type) === 3 && !s.jar && spider) s.jar = spider;
    sites.push(s);
  }
  return {
    spider,
    wallpaper: typeof cfg.wallpaper === "string" ? resolveUrl(cfg.wallpaper, base) : undefined,
    sites,
    lives: normalizeLives(cfg.lives, base),
    parses: (Array.isArray(cfg.parses) ? cfg.parses : []).filter(
      (p) => p && typeof p === "object" && typeof p.url === "string",
    ),
    flags: (Array.isArray(cfg.flags) ? cfg.flags : []).filter((f) => typeof f === "string"),
  };
}

/** 从一份配置里抽出多仓子地址（原项目完全没处理这块） */
export function extractSubSources(cfg, base) {
  const subs = Array.isArray(cfg?.urls) ? cfg.urls : Array.isArray(cfg?.storeHouse) ? cfg.storeHouse : [];
  return subs
    .map((s) => (typeof s === "string" ? s : String(s?.url || s?.sourceUrl || "")))
    .filter(Boolean)
    .map((u) => String(resolveUrl(u, base)))
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * 拉取一个接口，自动穿透多仓（默认最多 2 层，单个多仓最多 30 个子仓）。
 * 返回值 extra.subSources 会被收集进「发现池」，作为下一轮的候选。
 */
export async function fetchTvboxConfig(url, opts = {}) {
  const { timeoutMs = 20000, maxDepth = 2, maxSubs = 30, cache = true } = opts;
  const load = cache ? cachedLoadRaw : loadRaw;
  const first = await load(url, timeoutMs);
  if (!first.data) return { size: first.size, error: first.error };

  const base = first.finalUrl || url;
  const d = first.data;
  const subSources = extractSubSources(d, base);

  if (Array.isArray(d.sites) || Array.isArray(d.lives) || Array.isArray(d.parses)) {
    const cfg = normalizeConfig(d, base);
    return { config: cfg, size: first.size, subSources, multi: false };
  }
  if (!subSources.length) return { size: first.size, error: "未找到 sites / lives / urls 字段", subSources };

  // 多仓：并发拉子仓
  const merged = { spider: undefined, wallpaper: undefined, sites: [], lives: [], parses: [], flags: [] };
  let size = first.size;
  const use = subSources.slice(0, maxSubs);
  const results = await Promise.all(use.map((u) => load(u, timeoutMs)));
  const deeper = [];

  results.forEach((r, i) => {
    if (!r.data) return;
    const subBase = r.finalUrl || use[i];
    const subSubs = extractSubSources(r.data, subBase);
    if (maxDepth > 1 && subSubs.length) deeper.push(...subSubs);

    if (!(Array.isArray(r.data.sites) || Array.isArray(r.data.lives))) return;
    size += r.size;
    const n = normalizeConfig(r.data, subBase);
    merged.spider ??= n.spider;
    merged.wallpaper ??= n.wallpaper;
    merged.sites.push(...n.sites);
    merged.lives.push(...n.lives);
    merged.parses.push(...n.parses);
    merged.flags.push(...n.flags);
  });

  // 第二层多仓（若允许）
  if (maxDepth > 1 && deeper.length) {
    const useDeeper = [...new Set(deeper)].slice(0, maxSubs * 2);
    const res2 = await Promise.all(useDeeper.map((u) => load(u, timeoutMs)));
    res2.forEach((r, i) => {
      if (!r.data) return;
      if (!(Array.isArray(r.data.sites) || Array.isArray(r.data.lives))) return;
      size += r.size;
      const n = normalizeConfig(r.data, r.finalUrl || useDeeper[i]);
      merged.spider ??= n.spider;
      merged.wallpaper ??= n.wallpaper;
      merged.sites.push(...n.sites);
      merged.lives.push(...n.lives);
      merged.parses.push(...n.parses);
      merged.flags.push(...n.flags);
    });
  }

  if (!merged.sites.length && !merged.lives.length) {
    return { size, error: "多仓子接口均不可用", subSources };
  }
  return { config: merged, size, subSources: [...subSources, ...deeper], multi: true };
}

/** 采集站接口探活：先 ?ac=list 看分类，再 ?ac=detail&pg=1 确认有真实数据（抗误杀） */
export async function probeCmsSite(api, opts = {}) {
  const clean = String(api).split(";")[0];
  const withAc = (ac) => clean + (clean.includes("?") ? "&" : "?") + ac;

  const r1 = await getWithRetry(withAc("ac=list"), { ua: "Mozilla/5.0", timeoutMs: opts.timeoutMs || 8000, maxBytes: 512 * 1024, retries: 1 });
  if (isUncertain(r1)) {
    return { alive: true, uncertain: true, grade: "slow", ttfb: r1.ttfb, ms: r1.ms, reason: `ac=list 限流/拒绝 HTTP ${r1.status}（保留）` };
  }
  const body1 = r1.body.toString("utf8");
  const classOk = r1.ok && body1.length > 20 && /(class|list|vod|<rss|"code")/i.test(body1);
  if (!classOk) return { alive: false, reason: r1.error || `ac=list HTTP ${r1.status}`, grade: "dead", ttfb: r1.ttfb };

  const r2 = await getWithRetry(withAc("ac=detail&pg=1"), { ua: "Mozilla/5.0", timeoutMs: opts.timeoutMs || 8000, maxBytes: 768 * 1024, retries: 1 });
  if (isUncertain(r2)) {
    return { alive: true, uncertain: true, grade: "slow", ttfb: r1.ttfb, ms: r1.ms, reason: `ac=detail 限流/拒绝 HTTP ${r2.status}（保留）` };
  }
  const body2 = r2.body.toString("utf8");
  const hasVod = r2.ok && /vod_id|vod_name|"list"|<\?xml/i.test(body2);
  const title = (/"vod_name"\s*:\s*"([^"]+)"/.exec(body2) || [])[1] || "";
  return {
    alive: hasVod,
    reason: hasVod ? "ok" : r2.error || `ac=detail HTTP ${r2.status}`,
    grade: hasVod ? "ok" : "dead",
    ttfb: r1.ttfb,
    ms: r1.ms + r2.ms,
    sampleTitle: title,
    classes: (/"type_name"\s*:\s*"([^"]+)"/.exec(body1) || [])[1] || "",
  };
}

/** Py / JS 文件探活：200 + 大小 + 内容特征（带 429/403 退避重试，避免误杀） */
export async function probeScript(url, kind, opts = {}) {
  const clean = String(url).split(";")[0];
  const r = await getWithRetry(clean, { timeoutMs: opts.timeoutMs || 8000, maxBytes: 400 * 1024, retries: 2 });
  const txt = r.body.toString("utf8");
  const tooSmall = r.body.length < 150;
  const looksHtml = /^\s*<(!doctype|html)/i.test(txt);
  const looksErr = /(page not found|页面不存在|404\s*error|error\s*code|access\s*denied|forbidden)/i.test(txt.slice(0, 600));
  const hasCode =
    kind === "py"
      ? /(import\s+\w|def\s+\w+\s*\(|class\s+\w+|module\.exports)/.test(txt)
      : /(function|var\s|let\s|const\s|rule|js:|=>)/.test(txt);

  // 关键：429/403 等属于「服务器活着但拒绝我」，不能判定为死站
  if (isUncertain(r)) {
    return {
      alive: true,
      uncertain: true,
      ttfb: r.ttfb,
      ms: r.ms,
      bytes: r.body.length,
      kbps: 0,
      grade: "slow", // 降级保留，不打到精选，也不删除
      reason: `限流/拒绝访问 HTTP ${r.status}（判定不确定，保留）`,
    };
  }

  const alive = r.ok && !tooSmall && !looksHtml && !looksErr && hasCode;
  return {
    alive,
    ttfb: r.ttfb,
    ms: r.ms,
    bytes: r.body.length,
    kbps: r.ms > 0 ? Math.round((r.body.length / 1024) * (1000 / r.ms)) : 0,
    reason: alive
      ? "ok"
      : !r.ok
        ? r.error || `HTTP ${r.status}`
        : tooSmall
          ? "内容过小"
          : looksHtml
            ? "返回网页"
            : looksErr
              ? "错误页"
              : "内容不像脚本",
  };
}

/** Jar 探活：必须是 ZIP（PK 魔数）且够大（同样抗误杀） */
export async function probeJar(url, opts = {}) {
  const clean = String(url).split(";")[0];
  const r = await getWithRetry(clean, { timeoutMs: opts.timeoutMs || 12000, maxBytes: 4 * 1024 * 1024, retries: 1 });
  if (isUncertain(r)) {
    return { alive: true, uncertain: true, ttfb: r.ttfb, ms: r.ms, kbps: 0, grade: "slow", reason: `限流/拒绝 HTTP ${r.status}（保留）` };
  }
  const isZip = r.body.length > 4 && r.body[0] === 0x50 && r.body[1] === 0x4b;
  const alive = r.ok && isZip && r.body.length > 10 * 1024;
  return {
    alive,
    ttfb: r.ttfb,
    ms: r.ms,
    bytes: r.body.length,
    kbps: r.ms > 0 ? Math.round((r.body.length / 1024) * (1000 / r.ms)) : 0,
    reason: alive ? "ok" : !r.ok ? r.error || `HTTP ${r.status}` : !isZip ? "不是有效的 jar" : "文件过小",
  };
}

const TVBOX_UA_FALLBACK = "okhttp/3.15";

/** 从 ext 里抽出可能的目标站点地址（用于判断 spider 是否真能用） */
export function extractExtTargets(site) {
  const out = new Set();
  const push = (v) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) out.add(v.trim().split(";")[0]);
  };
  const e = site.ext;
  if (typeof e === "string") push(e);
  else if (e && typeof e === "object") {
    for (const k of ["分类url", "分类URL", "主页url", "主页URL", "url", "homeUrl", "api", "分类"]) {
      const v = e[k];
      if (typeof v === "string") {
        // "分类url": "https://x.com/vodshow/{cateId}..." 这类模板，只取域名部分
        const m = /^(https?:\/\/[^/{}]+)/i.exec(v.trim());
        if (m) out.add(m[1]);
      }
    }
  }
  return [...out];
}

/** ext 指向的域名是否可达（HEAD/GET 根路径） */
export async function probeHost(rootUrl, opts = {}) {
  const { timeoutMs = 6000 } = opts;
  const r = await httpGet(rootUrl, { ua: "Mozilla/5.0", timeoutMs, maxBytes: 64 * 1024 });
  // 403/503 也算"站点活着"，只要有响应
  const alive = r.status > 0 && r.status < 500;
  return { alive, status: r.status, ttfb: r.ttfb, ms: r.ms, reason: alive ? "ok" : r.error || `HTTP ${r.status}` };
}

export { normUrl };


/* ============================ 抗误杀：429/403/5xx 重试 ============================ */

const RETRY_STATUS = new Set([403, 408, 423, 425, 429, 500, 502, 503, 504, 521, 522, 523]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带退避重试的 GET。
 * 429/403/5xx 默认「不确定是否真死」，所以要重试 + 换 UA，不能直接判定失效。
 * 返回的 attempts 让上层知道是否属于「测不准」。
 */
export async function getWithRetry(url, opts = {}) {
  const { timeoutMs = 8000, retries = 2, maxBytes = 512 * 1024, uaList = null } = opts;
  const uas = uaList || ["Mozilla/5.0", "okhttp/3.15", "okhttp/4.9.3"];
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const r = await httpGet(url, { timeoutMs, maxBytes, ua: uas[Math.min(i, uas.length - 1)] });
    last = r;
    if (r.ok) return { ...r, attempts: i + 1 };
    // 连接层的错误（DNS/超时/重置）也值得再试一次
    const retryable = RETRY_STATUS.has(r.status) || (!r.status && r.error);
    if (!retryable) return { ...r, attempts: i + 1 };
    if (i < retries) await sleep(400 * (i + 1) + Math.random() * 300);
  }
  return { ...last, attempts: retries + 1, uncertain: RETRY_STATUS.has(last.status) };
}

/** 判定一个失败是否属于「测不准」（限流/反爬），不能当作真失效删掉 */
export function isUncertain(r) {
  if (!r) return false;
  if (r.uncertain) return true;
  return RETRY_STATUS.has(r.status);
}
