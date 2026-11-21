/**
 * collect.mjs —— 收集层（原项目完全没有这一层）
 *
 * 原项目的真相：它的「收集」= 读取本仓库里手写的 api_list.json / apilinks.txt，
 * 从不抓外部清单，也不处理多仓。所以「复刻原项目」只能复刻到「抓 API_LIST」。
 *
 * 本模块实现真正的收集：
 *   1. 上游清单：抓 config/upstreams.txt 里所有清单源（links/readme/json/apilinks 四种格式）
 *   2. 多仓递归：从已抓到的配置里抽出 urls / storeHouse 子仓地址
 *   3. 种子直连：apilinks.txt 里人工维护的地址
 * 全部结果写进 data/pool.json（发现池），记录来源、首次发现时间、连续失败次数。
 */
import { readFile } from "node:fs/promises";
import { httpGet, log, normUrl, pool } from "./core.mjs";

const URL_RE = /https?:\/\/[^\s"'`,，\t<>)\]}|｜]+/g;
const NOT_API =
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|apk|zip|rar|7z|mp4|m3u8|css|map)$|shields\.io|badge|visitor|\.github\.io\/?$|github\.com\/(?!.*\/(raw|blob)\/)[^/]+\/[^/]+\/?$|github\.com\/[^/]+\/[^/]+\/(issues|pulls|tree|releases|stargazers|forks|actions|wiki)|^\s*https?:\/\/(www\.)?(youtube|bilibili|twitter|x|t\.me|telegram)/i;

/** 这些路径片段基本是 APK 下载目录，不是接口配置 */
const APP_DIR_RE = /\/(影视|电视直播|娱乐应用|教育学习|工具|游戏|相册|音乐|网络检测|桌面|空壳|直播软件|点播软件|电视软件|浏览器|投屏)\//;
/** 明确像接口配置的扩展名 */
const CFG_EXT_RE = /\.(json|txt|webp|gif|xml|m3u|yaml|yml)$/i;

/** 解析 config/upstreams.txt */
export function parseUpstreamFile(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      // 只有 URL 的行也接受
      if (/^https?:\/\//i.test(line)) out.push({ name: "上游", url: line, type: "links" });
      continue;
    }
    const url = parts.find((p) => /^https?:\/\//i.test(p));
    if (!url) continue;
    const name = parts[0] === url ? "上游" : parts[0];
    const type = (parts.find((p) => /^(links|readme|json|apilinks)$/i.test(p)) || "links").toLowerCase();
    out.push({ name, url, type });
  }
  return out;
}

/**
 * README 类来源：只抓「接口 / 配置 / 订阅 / 多仓 / 路线」相关小节里的地址，
 * 否则会把整个 APK 下载表都当成接口（实测噪声率 90%+）。
 */
function extractFromMarkdown(text) {
  const lines = String(text).split(/\r?\n/);
  const urls = new Set();
  let inApiSection = false;
  let inCodeBlock = false;

  for (const raw of lines) {
    const line = raw.trim();

    // 代码块（```）里的地址一律收（README 常把接口清单放代码块）
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // 标题切换：命中接口关键词才进入收集态
    if (/^#{1,6}\s/.test(line)) {
      inApiSection = /(接口|配置|订阅|线路|多仓|单仓|api|config|source|数据源|tvbox|影视仓)/i.test(line);
      continue;
    }

    const isApiLine =
      inCodeBlock ||
      inApiSection ||
      /(接口|配置地址|订阅|单仓|多仓|路线|线路)/.test(line);
    if (!isApiLine) continue;

    for (const m of line.matchAll(URL_RE)) urls.add(cleanUrl(m[0]));
  }
  return [...urls];
}

const cleanUrl = (u) =>
  String(u)
    .replace(/[.,;:'")\]}]+$/, "")
    .replace(/[\\]+$/, "") // README 里有 "http://x.com\" 这种转义残留
    .trim();

/** 从清单文本里抽地址 */
function extractFromText(text) {
  const urls = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    for (const m of line.matchAll(URL_RE)) urls.add(cleanUrl(m[0]));
  }
  return [...urls];
}

/** 递归遍历 JSON，抽出所有 URL 字符串 */
function extractFromJson(obj) {
  const urls = new Set();
  const walk = (o) => {
    if (typeof o === "string") {
      for (const m of o.matchAll(URL_RE)) urls.add(cleanUrl(m[0]));
    } else if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o && typeof o === "object") {
      // 常见结构优先：直接取字段
      for (const k of ["url", "urls", "api", "ext", "spider", "sourceUrl", "storeHouse"]) {
        const v = o[k];
        if (typeof v === "string") for (const m of v.matchAll(URL_RE)) urls.add(cleanUrl(m[0]));
        else if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && urls.add(cleanUrl(x)));
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(obj);
  return [...urls];
}

/** 抓一个上游清单，返回候选地址 */
export async function harvestOne(src, timeoutMs = 20000) {
  const r = await httpGet(src.url, { ua: "Mozilla/5.0", timeoutMs, maxBytes: 4 * 1024 * 1024 });
  if (!r.ok) return { name: src.name, ok: false, error: r.error || `HTTP ${r.status}`, urls: [] };
  const text = r.body.toString("utf8");

  let urls = [];
  if (src.type === "json") {
    try {
      urls = extractFromJson(JSON.parse(text));
    } catch {
      urls = extractFromText(text); // 有些 json 源其实是坏 JSON，退化成正则
    }
  } else if (src.type === "readme") {
    urls = extractFromMarkdown(text);
  } else {
    urls = extractFromText(text);
  }

  // 过滤掉明显不是接口的
  urls = [...new Set(urls.map(cleanUrl))].filter((u) => {
    if (NOT_API.test(u)) return false;
    if (u.length > 300) return false;
    if (APP_DIR_RE.test(u)) return false; // APK 下载目录
    try {
      const p = new URL(u);
      if (!p.hostname.includes(".") || p.pathname === "") return false;
      // 没有路径又没有像配置的特征（目录式接口 http://xxx.top 属于正常，保留）
      return true;
    } catch {
      return false;
    }
  });

  return { name: src.name, ok: true, urls, size: r.body.length };
}

/** 判断一个已抓到的配置里有没有多仓子地址 */
export function subsFromConfig(cfg) {
  const subs = Array.isArray(cfg?.urls) ? cfg.urls : Array.isArray(cfg?.storeHouse) ? cfg.storeHouse : [];
  return subs
    .map((s) => (typeof s === "string" ? s : String(s?.url || s?.sourceUrl || "")))
    .filter((u) => /^https?:\/\//i.test(u))
    .map((u) => u.split(";")[0]);
}

/**
 * 跑完整收集：上游清单 + 种子 + 已有池，合并成候选列表
 * @param {object} o
 *   upstreams      上游清单数组
 *   seeds          人工种子（apilinks.txt）
 *   prevPool       上次运行留下的池（data/pool.json）
 *   fromConfigs    本次抓取的配置里冒出来的多仓子地址
 */
export function mergePool({ upstreams = [], seeds = [], prevPool = {}, fromConfigs = [] }) {
  const now = new Date().toISOString();
  const map = new Map(); // normKey -> entry

  // 池子保留策略（默认 30 天）：只接最近 N 天内出现过的地址，
  // 否则池子只增不减，仓库会被慢慢撑大。
  const keepDays = Number(process.env.POOL_KEEP_DAYS || 30);
  const maxFails = Number(process.env.MAX_FAILS || 3);
  const cutoffTs = Date.now() - keepDays * 86400 * 1000;
  const toTs = (v) => {
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? t : 0;
  };

  // 已判定「反复失败」的地址名单：上游每天又会把它们灌回来，
  // 记下来让新条目直接带上失败次数，避免"删了第二天又被加回来白测一轮"。
  const failedKeys = new Set(
    (prevPool.entries || [])
      .filter((e) => (Number(e.fails) || 0) >= maxFails)
      .map((e) => normUrl(e.url, { dropQuery: false }))
      .filter(Boolean)
  );

  const add = (url, source, weight) => {
    const clean = cleanUrl(url);
    if (!/^https?:\/\//i.test(clean)) return;
    const k = normUrl(clean, { dropQuery: false });
    if (!k) return;
    const hit = map.get(k);
    if (hit) {
      if (!hit.sources.includes(source)) hit.sources.push(source);
      hit.weight = Math.max(hit.weight, weight);
      return;
    }
    map.set(k, {
      url: clean,
      key: k,
      sources: [source],
      weight, // 3=多仓子源 2=结构化清单 1=普通清单 0=种子
      firstSeen: now,
      lastSeen: now,
      fails: failedKeys.has(k) ? maxFails : 0,
      ...(failedKeys.has(k) ? { blocked: true } : {}),
    });
  };

  // ① 上次的池（累计失败次数）
  //    超过保留期 → 直接丢；反复失败的 → 压缩成最小记录留着（不抓，但别让上游
  //    第二天重新灌回来时又白测一轮）。压缩后单条约 100 字节，不会撑大仓库。
  let droppedOld = 0;
  let compactedFail = 0;
  for (const e of prevPool.entries || []) {
    const k = normUrl(e.url, { dropQuery: false });
    if (!k) continue;
    const seen = Math.max(toTs(e.lastSeen), toTs(e.lastOk), toTs(e.firstSeen));
    if (seen && seen < cutoffTs) {
      droppedOld++;
      continue;
    }
    const fails = Number(e.fails) || 0;
    if (fails >= maxFails) {
      compactedFail++;
      map.set(k, {
        url: e.url,
        key: k,
        sources: Array.isArray(e.sources) ? e.sources : [],
        fails,
        lastSeen: e.lastSeen || now,
        weight: Number(e.weight) || 0,
        blocked: true,
      });
      continue;
    }
    map.set(k, {
      ...e,
      lastSeen: now,
      fails,
      weight: Number(e.weight) || 0,
    });
  }

  // ② 上游清单命中
  for (const u of upstreams) for (const url of u.urls || []) add(url, u.name, 2);
  // ③ 多仓子源
  for (const url of fromConfigs) add(url, "多仓递归", 3);
  // ④ 人工种子
  for (const s of seeds) add(s.url, s.name || "种子", 1);

  if (droppedOld || compactedFail) {
    log(`  池子清理：过期(>${keepDays}天) 删 ${droppedOld} 条、反复失败压缩保留 ${compactedFail} 条，剩余 ${map.size} 条`);
  }
  return [...map.values()];
}

/** 池子里挑本轮要抓的：按权重、连续失败次数排序 */
export function pickCandidates(poolEntries, { limit = 600, maxFails = 4 } = {}) {
  return poolEntries
    .filter((e) => e.fails < maxFails)
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (a.fails !== b.fails) return a.fails - b.fails;
      return a.lastSeen < b.lastSeen ? -1 : 1;
    })
    .slice(0, limit);
}

/** 把本轮抓取结果回写到池（成功清零，失败累加） */
export function updatePool(poolEntries, results) {
  const now = new Date().toISOString();
  const byKey = new Map(poolEntries.map((e) => [e.key, e]));
  for (const r of results) {
    const k = normUrl(r.url, { dropQuery: false });
    const e = byKey.get(k);
    if (!e) continue;
    e.lastSeen = now;
    if (r.ok) {
      e.fails = 0;
      e.lastOk = now;
      e.sites = r.sites ?? 0;
      e.lives = r.lives ?? 0;
    } else {
      e.fails = (Number(e.fails) || 0) + 1;
      e.lastErr = r.error || "失败";
    }
  }
  return poolEntries;
}

export async function loadUpstreams(path) {
  try {
    return parseUpstreamFile(await readFile(path, "utf8"));
  } catch {
    log(`⚠️ 读不到上游清单文件：${path}`);
    return [];
  }
}

/** 并发抓所有上游清单 */
export async function harvestAll(upstreams, concurrency = 6) {
  const out = [];
  await pool(upstreams, concurrency, async (src) => {
    try {
      const r = await harvestOne(src);
      out.push(r);
      log(r.ok ? `  ✓ 上游「${r.name}」抽取 ${r.urls.length} 条` : `  ✗ 上游「${r.name}」失败：${r.error}`);
    } catch (e) {
      out.push({ name: src.name, ok: false, error: e.message, urls: [] });
      log(`  ✗ 上游「${src.name}」异常：${e.message}`);
    }
  });
  return out;
}


/* ============================ GitHub 代码/仓库搜索（L3 层） ============================ */

/**
 * 用 GitHub API 搜索新出现的 TVBox 配置仓库。
 * 匿名调用限速 10 次/分钟；在 Actions 里会自动带 GITHUB_TOKEN，额度高得多。
 * 只在有 token 时启用，避免 CI 外跑不动还拖慢。
 */
export async function searchGithubRepos({ token, queries = [], perQuery = 8, maxAgeDays = 30 } = {}) {
  if (!token) return { skipped: true, reason: "未提供 GITHUB_TOKEN", repos: [] };
  const out = new Map();
  const cutoff = Date.now() - maxAgeDays * 86400_000;

  for (const q of queries) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perQuery}`;
    const r = await httpGet(url, {
      ua: "tvbox-agg-collector",
      timeoutMs: 20000,
      maxBytes: 2 * 1024 * 1024,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!r.ok) {
      log(`  ⚠️ GitHub 搜索「${q}」失败：HTTP ${r.status}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(r.body.toString("utf8"));
    } catch {
      continue;
    }
    // 自己 / 原项目 不要当上游抓（否则每次都把自己上次的产物又抓一遍）
    const SELF = new Set([
      (process.env.GITHUB_REPOSITORY || "thevip001/tvbox-agg").toLowerCase(),
      "lubin776/tvbox-api-backup",
      "lubin776/get_tvbox_api",
    ]);
    for (const repo of data.items || []) {
      if (!repo?.full_name) continue;
      if (SELF.has(String(repo.full_name).toLowerCase())) continue;
      const updated = Date.parse(repo.updated_at || 0) || 0;
      if (updated < cutoff) continue; // 太久没更新的仓库跳过
      out.set(repo.full_name, {
        name: repo.full_name,
        stars: repo.stargazers_count || 0,
        updated: repo.updated_at,
        desc: (repo.description || "").slice(0, 60),
        weight: repo.stargazers_count > 20 ? 3 : 2,
      });
    }
    // 搜索有速率限制，逐个之间歇一下
    await new Promise((r2) => setTimeout(r2, 1200));
  }
  return { skipped: false, repos: [...out.values()] };
}

/**
 * 把一个 GitHub 仓库转成「可能的清单地址」候选。
 * 不去猜文件内容，只按 TVBox 生态最常见的几种命名拼一遍，
 * 后面统一走抓取+解析验证，假的自然会被淘汰。
 */
export function repoToCandidates(repoName, branch = "main") {
  const base = `https://raw.githubusercontent.com/${repoName}/${branch}`;
  const names = [
    "apilinks.txt",
    "api_list.json",
    "tvboxapilinks.txt",
    "apilinks.json",
    "config.json",
    "api.json",
    "tvbox.json",
    "data/interfaces.json",
    "output/单仓聚合.json",
    "output/多仓订阅.json",
    "depot.json",
    "merged.json",
    "all.json",
  ];
  return names.map((n) => `${base}/${n}`);
}
