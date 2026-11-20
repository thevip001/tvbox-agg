#!/usr/bin/env node
/**
 * TVBox 接口每日聚合脚本（零第三方依赖，需要 Node.js 18 及以上）
 *
 * 1. 读取 apilinks.txt：每行「名称, 地址1, 地址2 ...」，多个地址是镜像，按顺序自动选通
 * 2. 抓取每个接口：解码（图片套壳 / Base64 / 2423 加密）、容错解析、展开多仓
 * 3. 点播：按 type + api + ext 去重；采集站（type 0/1）检测可用性，剔除失效站
 * 4. 直播：按地址去重；逐个下载检测，再按频道内容去重，剔除失效源
 * 5. 输出：聚合接口/海量点播聚合接口.json、聚合接口/海量直播聚合接口.json
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIST_FILE = join(ROOT, "apilinks.txt");
const OUT_DIR = join(ROOT, "聚合接口");
const VOD_FILE = "海量点播聚合接口.json";
const LIVE_FILE = "海量直播聚合接口.json";
const TVBOX_UA = "okhttp/3.15";
// 安全阀：结果明显异常（例如上游全部挂掉）时不覆盖已有文件
const MIN_SITES = 100;
const MIN_LIVES = 3;

const beijingNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const log = (msg) => console.log(`[${beijingNow().toISOString().slice(11, 19)}] ${msg}`);

/* ---------------- 通用工具 ---------------- */

async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** 同名自动加后缀：xxx → xxx｜来源 → xxx｜来源2 */
function uniqueNamer() {
  const used = new Set();
  return (base, tag) => {
    let n = base;
    if (used.has(n) && tag) n = `${base}｜${tag}`;
    const root = n;
    let i = 2;
    while (used.has(n)) n = `${root}${i++}`;
    used.add(n);
    return n;
  };
}

/* ---------------- HTTP（模拟 TVBox 客户端，永不抛异常） ---------------- */

function httpGet(url, opts = {}) {
  const { ua = TVBOX_UA, timeoutMs = 20000, maxBytes = 15 * 1024 * 1024, redirects = 5 } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: 0, body: Buffer.alloc(0), finalUrl: url, ms: Date.now() - started, ...r });
    };

    let u;
    try {
      u = new URL(url);
    } catch {
      return settle({ error: "地址无效" });
    }
    const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
    if (!lib) return settle({ error: "不支持的协议" });

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: { "User-Agent": ua, Accept: "*/*", "Accept-Encoding": "gzip, deflate, br" },
        rejectUnauthorized: false, // 很多 TVBox 接口站的证书不规范
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (redirects > 0 && [301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return settle({ status, error: "重定向地址无效" });
          }
          return httpGet(next, { ua, timeoutMs, maxBytes, redirects: redirects - 1 }).then(settle);
        }
        const chunks = [];
        let total = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          let body = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (enc.includes("gzip")) body = zlib.gunzipSync(body);
            else if (enc.includes("deflate")) body = zlib.inflateSync(body);
            else if (enc.includes("br")) body = zlib.brotliDecompressSync(body);
          } catch {
            // 解压失败（例如内容被截断）就保留原始数据
          }
          settle({ ok: status >= 200 && status < 300, status, body, finalUrl: url });
        };
        res.on("data", (c) => {
          if (done) return;
          total += c.length;
          if (total > maxBytes) {
            chunks.push(c.subarray(0, Math.max(0, c.length - (total - maxBytes))));
            res.destroy();
            finish();
            return;
          }
          chunks.push(c);
        });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", (e) => settle({ error: e.message || String(e) }));
    timer = setTimeout(() => req.destroy(new Error("下载超时")), timeoutMs * 2);
    req.end();
  });
}

/* ---------------- 解码 & 宽松 JSON ---------------- */

const pad16 = (s) => Buffer.from((s + "0000000000000000").slice(0, 16), "utf8");
const looksJsonStart = (s) => /^[{[]/.test(s);

/** 2423 开头的 AES-128-CBC（FongMi / TVBox 常见加密格式） */
function cbcDecrypt(data) {
  const idxKey = data.indexOf("2324") + 4;
  const key = Buffer.from(data.slice(0, idxKey), "hex").toString("utf8").replace("$#", "").replace("#$", "");
  const idxIv = data.length - 26;
  const iv = Buffer.from(data.slice(idxIv).trim(), "hex").toString("utf8");
  const enc = Buffer.from(data.slice(idxKey, idxIv).trim(), "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", pad16(key), pad16(iv));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function decodeConfigText(buf) {
  let text = buf.toString("utf8").replace(/^\uFEFF/, "");
  // 图片套壳：图片字节 + "xxxxxxxx**" + base64 格式的配置
  if (!looksJsonStart(text.trimStart())) {
    const m = /[A-Za-z0-9]{8}\*\*/.exec(text);
    if (m) {
      const b64 = text.slice(m.index + m[0].length).replace(/[^A-Za-z0-9+/=_-]/g, "");
      const dec = Buffer.from(b64, "base64").toString("utf8").trim();
      if (looksJsonStart(dec)) text = dec;
    }
  }
  text = text.trim();
  if (text.startsWith("2423")) {
    try {
      text = cbcDecrypt(text);
    } catch {
      // 不是可解的 2423 格式，按原文处理
    }
  } else if (!/^[{[\/]/.test(text) && /^[A-Za-z0-9+/=\s_-]{32,}$/.test(text)) {
    // 整体是 Base64
    const dec = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8").trim();
    if (looksJsonStart(dec)) text = dec;
  }
  return text.replace(/^\uFEFF/, "").trim();
}

/** 宽松 JSON：去掉注释、尾逗号，单引号转双引号，修复字符串里的换行，并逐行剔除损坏的条目 */
function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 继续走宽松解析
  }
  let out = "";
  let i = 0;
  let inStr = false;
  let quote = "";
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      if (c === "\\") {
        out += c + (n ?? "");
        i += 2;
        continue;
      }
      if (c === quote) inStr = false;
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (c >= " ") out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      out += '"';
      i++;
      if (c === "'") {
        let s = "";
        while (i < text.length && text[i] !== "'") {
          if (text[i] === "\\") {
            s += text[i] + (text[i + 1] ?? "");
            i += 2;
            continue;
          }
          const ch = text[i];
          if (ch === '"') s += '\\"';
          else if (ch === "\n") s += "\\n";
          else if (ch === "\r") s += "\\r";
          else if (ch === "\t") s += "\\t";
          else if (ch >= " ") s += ch;
          i++;
        }
        out += s + '"';
        i++;
        continue;
      }
      inStr = true;
      quote = c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "#" && /(^|\n)[ \t]*$/.test(out.slice(-200))) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    out += c;
    i++;
  }
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) out = out.slice(start, end + 1);
  for (let attempt = 0; ; attempt++) {
    out = out.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(out);
    } catch (e) {
      if (attempt >= 40) throw e;
      let pos = Number((/position (\d+)/.exec(e.message) || [])[1]);
      if (!Number.isFinite(pos)) {
        const snip = (/, (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(e.message) || [])[1];
        const tok = (/Unexpected token '([\s\S])'/.exec(e.message) || [])[1];
        if (snip) {
          const at = out.indexOf(snip);
          if (at >= 0) pos = at + Math.max(0, tok ? snip.indexOf(tok) : 0);
        }
      }
      if (!Number.isFinite(pos)) throw e;
      const ls = out.lastIndexOf("\n", pos - 1);
      const le = out.indexOf("\n", pos);
      if (ls < 0 || le < 0) throw e;
      out = out.slice(0, ls) + out.slice(le); // 只丢掉出错的那一行
    }
  }
}

/* ---------------- 路径解析 & 配置规范化 ---------------- */

const isRelPath = (s) => /^(\.\.?\/|\/[^/])/.test(s);

/** 相对路径补全为绝对路径（备份后可以在任何地方使用） */
function resolveUrl(value, base) {
  if (typeof value !== "string" || !value) return value;
  const [head, ...rest] = value.split(";");
  if (!isRelPath(head.trim())) return value;
  try {
    return [decodeURI(new URL(head.trim(), base).toString()), ...rest].join(";");
  } catch {
    return value;
  }
}

/** 旧版 lives（group + channels，proxy 链接里带 base64 地址）统一为 {name, type, url} */
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
              // 解码失败就跳过
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

function normalizeConfig(cfg, base) {
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

async function loadRaw(url, timeoutMs) {
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

/** 拉取一个接口；如果它只是多仓入口（urls / storeHouse），就并发拉取子配置再合并 */
async function fetchTvboxConfig(url, timeoutMs) {
  const first = await loadRaw(url, timeoutMs);
  if (!first.data) return { size: first.size, error: first.error };
  const base = first.finalUrl || url;
  const d = first.data;
  if (Array.isArray(d.sites) || Array.isArray(d.lives)) {
    return { config: normalizeConfig(d, base), size: first.size };
  }
  const subs = Array.isArray(d.urls) ? d.urls : Array.isArray(d.storeHouse) ? d.storeHouse : [];
  const subUrls = subs
    .map((s) => (typeof s === "string" ? s : String(s?.url || s?.sourceUrl || "")))
    .filter(Boolean)
    .map((u) => String(resolveUrl(u, base)))
    .slice(0, 12);
  if (!subUrls.length) return { size: first.size, error: "未找到 sites / lives 字段" };

  const merged = { spider: undefined, wallpaper: undefined, sites: [], lives: [], parses: [], flags: [] };
  let size = first.size;
  const results = await Promise.all(subUrls.map((u) => loadRaw(u, timeoutMs)));
  results.forEach((r, i) => {
    if (!r.data || !(Array.isArray(r.data.sites) || Array.isArray(r.data.lives))) return;
    size += r.size;
    const n = normalizeConfig(r.data, r.finalUrl || subUrls[i]);
    merged.spider ??= n.spider;
    merged.wallpaper ??= n.wallpaper;
    merged.sites.push(...n.sites);
    merged.lives.push(...n.lives);
    merged.parses.push(...n.parses);
    merged.flags.push(...n.flags);
  });
  if (!merged.sites.length && !merged.lives.length) return { size, error: "多仓子接口均不可用" };
  return { config: merged, size };
}

/* ---------------- 去重规则 ---------------- */

const looksUrl = (s) => /^(https?:)?\/\//i.test(s) || /^[\w.-]+\.[a-z]{2,}\//i.test(s);

/** URL 规范化：忽略协议、www、末尾斜杠；GitHub 代理前缀统一去掉，方便判断是不是同一个地址 */
function normUrl(u) {
  let s = String(u || "").trim();
  if (!s) return "";
  s = s.split(";")[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    // 保持原样
  }
  const gh = /(raw\.githubusercontent\.com|github\.com|gist\.githubusercontent\.com|cdn\.jsdelivr\.net)\/.*/i.exec(s);
  if (gh) s = gh[0].replace(/\/{2,}/g, "/");
  s = s.replace(/^[a-z]+:\/\//i, "");
  const slash = s.indexOf("/");
  const host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  const path = slash < 0 ? "" : s.slice(slash);
  return (host + path).replace(/\/+$/, "").replace(/\/+(?=\?)/, "");
}

const stableStringify = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? "");
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
};

function normExt(ext) {
  if (ext === undefined || ext === null || ext === "") return "";
  if (typeof ext === "string") {
    const t = ext.trim();
    return looksUrl(t) ? normUrl(t) : t;
  }
  return stableStringify(ext);
}

/** 点播站点去重键：type + api + ext */
function siteDedupKey(site) {
  const type = Number(site.type ?? 0);
  const api = String(site.api || "").trim();
  return `${type}|${looksUrl(api) ? normUrl(api) : api}|${normExt(site.ext)}`;
}

function siteCategory(site) {
  const type = Number(site.type);
  const api = String(site.api || "");
  if (type === 0 || type === 1) return "cj";
  if (/\.py(\?|$)/i.test(api)) return "py";
  if (/\.js(\?|$)/i.test(api)) return "js";
  if (type === 3) return "spider";
  return "other";
}

/** 读取 apilinks.txt：同名接口的多行会合并成一个接口的多个镜像 */
function parseSourceText(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    let name = parts[0];
    let urls = parts.slice(1);
    if (/^https?:\/\//i.test(name)) {
      urls = parts;
      try {
        name = new URL(parts[0]).hostname;
      } catch {
        // 保持原名
      }
    }
    urls = urls.filter((u) => /^https?:\/\//i.test(u));
    if (!urls.length) continue;
    const list = map.get(name) ?? [];
    for (const u of urls) if (!list.includes(u)) list.push(u);
    map.set(name, list);
  }
  return [...map].map(([name, urls]) => ({ name, urls }));
}

/* ---------------- 直播源 ---------------- */

/** 解析 M3U 或 TXT（「名称,地址」格式）播放列表 */
function parsePlaylist(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out = [];
  if (/^\s*#EXTM3U/i.test(text) || /#EXTINF/i.test(text)) {
    let pending = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#EXTINF/i.test(line)) {
        const group = /group-title="([^"]*)"/i.exec(line)?.[1] || "未分组";
        const name = line.slice(line.lastIndexOf(",") + 1).trim() || "未命名";
        pending = { group, name };
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
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) out.push({ group, name, url });
    }
  }
  return out;
}

/** 下载并检测一个直播源：可用性 + 频道内容哈希（用于内容级去重） */
async function checkLive(url, ua) {
  let cur = url;
  let size = 0;
  let channels = [];
  for (let depth = 0; depth < 5; depth++) {
    const r = await httpGet(cur, { ua, timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 });
    if (!r.ok) break;
    const text = r.body.toString("utf8");
    size = r.body.length;
    channels = parsePlaylist(text);
    if (channels.length) break;
    const t = text.trim();
    // 套壳：返回内容只是另一个地址，继续跟进（最多 5 层）
    if (/^https?:\/\/\S+$/.test(t) && t !== cur) {
      cur = t;
      continue;
    }
    break;
  }
  if (!channels.length) return { alive: false, channelCount: 0, size, hash: null };
  const uniq = [...new Set(channels.map((c) => normUrl(c.url)))].sort();
  return {
    alive: true,
    channelCount: channels.length,
    size,
    hash: crypto.createHash("sha1").update(uniq.join("\n")).digest("hex"),
  };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const t0 = Date.now();
  const list = parseSourceText(await readFile(LIST_FILE, "utf8"));
  if (!list.length) throw new Error("apilinks.txt 里没有可用的接口");
  log(`接口列表：${list.length} 个`);

  /* 1. 抓取接口：第一轮；失败的接口再用更长超时重试一轮 */
  const fetched = new Map();
  const fetchSource = async (src, timeoutMs) => {
    let lastErr = "没有可用地址";
    for (const url of src.urls) {
      try {
        const r = await fetchTvboxConfig(url, timeoutMs);
        if (r.config) return { config: r.config, usedUrl: url };
        lastErr = `${url} → ${r.error}`;
      } catch (e) {
        lastErr = `${url} → ${e.message}`;
      }
    }
    return { error: lastErr };
  };
  await pool(list, 6, async (src) => {
    const r = await fetchSource(src, 20000);
    if (r.config) {
      fetched.set(src.name, r);
      log(`✅ ${src.name} ← ${r.usedUrl}  站点 ${r.config.sites.length} / 直播 ${r.config.lives.length}`);
    } else {
      log(`⚠️ ${src.name} 失败：${r.error}`);
    }
  });
  const retry = list.filter((s) => !fetched.has(s.name));
  if (retry.length) {
    log(`第二轮：重试 ${retry.length} 个失败接口（超时加倍）`);
    await pool(retry, 4, async (src) => {
      const r = await fetchSource(src, 40000);
      if (r.config) {
        fetched.set(src.name, r);
        log(`✅ 重试成功：${src.name} ← ${r.usedUrl}`);
      }
    });
  }
  log(`接口抓取完成：成功 ${fetched.size} / ${list.length}`);

  /* 2. 汇总去重（按接口列表顺序，先出现的保留） */
  const siteMap = new Map();
  const liveMap = new Map();
  const parseMap = new Map();
  const flagSet = new Set();
  const spiderCount = new Map();
  let wallpaper = "";
  let rawSites = 0;
  let rawLives = 0;
  let rawParses = 0;
  for (const src of list) {
    const hit = fetched.get(src.name);
    if (!hit) continue;
    const cfg = hit.config;
    wallpaper ||= cfg.wallpaper || "";
    for (const site of cfg.sites) {
      rawSites++;
      const k = siteDedupKey(site);
      const exist = siteMap.get(k);
      if (exist) {
        if (!exist.sources.includes(src.name)) exist.sources.push(src.name);
      } else {
        siteMap.set(k, { site, sources: [src.name], category: siteCategory(site) });
        if (site.jar) spiderCount.set(String(site.jar), (spiderCount.get(String(site.jar)) || 0) + 1);
      }
    }
    for (const live of cfg.lives) {
      const url = String(live.url || "");
      if (!/^https?:\/\//i.test(url)) continue;
      rawLives++;
      const k = normUrl(url);
      const exist = liveMap.get(k);
      if (exist) {
        if (!exist.sources.includes(src.name)) exist.sources.push(src.name);
      } else {
        liveMap.set(k, { live, sources: [src.name] });
      }
    }
    for (const p of cfg.parses) {
      rawParses++;
      const k = normUrl(String(p.url));
      if (k && !parseMap.has(k)) parseMap.set(k, p);
    }
    for (const f of cfg.flags) flagSet.add(f);
  }
  log(
    `点播站点去重：${rawSites} → ${siteMap.size}；直播源去重：${rawLives} → ${liveMap.size}；解析去重：${rawParses} → ${parseMap.size}`,
  );

  /* 3. 采集站可用性检测（type 0/1，请求 ?ac=list） */
  const cjList = [...siteMap].filter(([, v]) => v.category === "cj");
  const cjAlive = new Map();
  log(`检测 ${cjList.length} 个采集站（type 0/1）的可用性…`);
  await pool(cjList, 16, async ([k, v]) => {
    const api = String(v.site.api);
    const url = api + (api.includes("?") ? "&" : "?") + "ac=list";
    const r = await httpGet(url, { ua: "Mozilla/5.0", timeoutMs: 8000, maxBytes: 512 * 1024 });
    const body = r.body.toString("utf8");
    cjAlive.set(k, r.ok && body.length > 20 && /(class|list|vod|<rss|"code")/i.test(body));
  });
  const cjOk = [...cjAlive.values()].filter(Boolean).length;
  log(`采集站可用：${cjOk} / ${cjList.length}`);

  /* 4. 直播源：逐个下载检测，再按频道内容去重 */
  const liveList = [...liveMap];
  log(`检测 ${liveList.length} 个直播源（套壳最多穿透 5 层）…`);
  const liveInfo = new Map();
  await pool(liveList, 6, async ([k, v]) => {
    const ua = typeof v.live.ua === "string" && v.live.ua ? v.live.ua : undefined;
    try {
      liveInfo.set(k, await checkLive(String(v.live.url), ua));
    } catch {
      liveInfo.set(k, { alive: false, channelCount: 0, size: 0, hash: null });
    }
  });
  const contentOwner = new Map(); // 频道内容哈希 → 保留下来的源
  const dupOf = new Map(); // 被去掉的重复源 → 保留下来的源
  for (const [k, v] of liveList) {
    const info = liveInfo.get(k);
    if (!info.alive) continue;
    const owner = contentOwner.get(info.hash);
    if (owner) dupOf.set(k, owner);
    else contentOwner.set(info.hash, v.live.name || k);
  }
  const liveOk = liveList.filter(([k]) => liveInfo.get(k).alive).length;
  log(`直播源可用：${liveOk} / ${liveList.length}；内容完全相同的重复源：${dupOf.size}`);

  /* 5. 生成两个聚合接口 */
  const keyNamer = uniqueNamer();
  const nameNamer = uniqueNamer();
  const spider = [...spiderCount].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const sites = [];
  for (const [k, v] of siteMap) {
    if (v.category === "cj" && cjAlive.get(k) === false) continue;
    const s = { ...v.site };
    s.key = keyNamer(String(s.key), v.sources[0]);
    s.name = nameNamer(String(s.name ?? s.key), v.sources[0]);
    if (spider && s.jar === spider) delete s.jar; // 与顶层 spider 相同，省略即可
    sites.push(s);
  }
  const parseNamer = uniqueNamer();
  const parses = [...parseMap.values()].map((p) => ({ ...p, name: parseNamer(String(p.name || "解析")) }));

  const liveNamer = uniqueNamer();
  const lives = [];
  for (const [k, v] of liveList) {
    if (!liveInfo.get(k).alive || dupOf.has(k)) continue;
    const l = { ...v.live };
    l.name = liveNamer(String(l.name || "直播"), v.sources[0]);
    lives.push(l);
  }

  const vodConfig = {
    ...(spider ? { spider } : {}),
    ...(wallpaper ? { wallpaper } : {}),
    sites,
    parses,
    flags: [...flagSet],
  };
  const liveConfig = { lives };

  if (sites.length < MIN_SITES || lives.length < MIN_LIVES) {
    throw new Error(
      `结果异常（点播 ${sites.length} 条、直播 ${lives.length} 个），为避免覆盖已有文件，本次不写入`,
    );
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, VOD_FILE), JSON.stringify(vodConfig, null, 2) + "\n", "utf8");
  await writeFile(join(OUT_DIR, LIVE_FILE), JSON.stringify(liveConfig, null, 2) + "\n", "utf8");
  log(`已写入：点播 ${sites.length} 站 / ${parses.length} 个解析；直播 ${lives.length} 个源`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const when = beijingNow().toISOString().slice(0, 16).replace("T", " ");
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## 聚合结果（${when} 北京时间）`,
        "",
        "| 项目 | 结果 |",
        "| --- | --- |",
        `| 接口抓取成功 | ${fetched.size} / ${list.length} |`,
        `| 点播站点（原始 → 去重 → 输出） | ${rawSites} → ${siteMap.size} → ${sites.length} |`,
        `| 采集站可用（type 0/1） | ${cjOk} / ${cjList.length} |`,
        `| 解析（原始 → 去重） | ${rawParses} → ${parseMap.size} |`,
        `| 直播源（原始 → 去重 → 输出） | ${rawLives} → ${liveMap.size} → ${lives.length} |`,
        `| 直播源内容重复 | ${dupOf.size} |`,
        "",
      ].join("\n"),
    );
  }
  log(`全部完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

main().catch((e) => {
  console.error(`❌ ${e.stack || e.message || e}`);
  process.exit(1);
});
