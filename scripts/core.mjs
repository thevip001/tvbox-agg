/**
 * core.mjs —— 基础库：HTTP、解码、宽松 JSON、URL 归一化、去重键、测速评分
 * 零第三方依赖，Node.js 18+（用内置 fetch 之外的 http/https，方便控制 TLS 与超时）
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export const TVBOX_UA = "okhttp/3.15";
export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 9; Pixel 3 XL Build/PQ3A.190801.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.120 Mobile Safari/537.36";

export const beijingNow = () => new Date(Date.now() + 8 * 3600 * 1000);
export const stamp = () => beijingNow().toISOString().slice(0, 19).replace("T", " ");
export const log = (msg) => console.log(`[${stamp().slice(11, 19)}] ${msg}`);

/* ============================ 并发池 ============================ */

export async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        /* 单项异常不影响整体 */
      }
    }
  });
  await Promise.all(workers);
}

/* ============================ HTTP ============================ */

/**
 * GET 请求，永不抛异常。
 * 返回 { ok, status, body, finalUrl, ms, ttfb, error }
 *   ms   = 总耗时毫秒
 *   ttfb = 首字节耗时毫秒（用于测速）
 */
export function httpGet(url, opts = {}) {
  const {
    ua = TVBOX_UA,
    headers = {},
    timeoutMs = 20000,
    maxBytes = 15 * 1024 * 1024,
    redirects = 5,
    measure = false, // 是否计量 TTFB
  } = opts;

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 0,
        body: Buffer.alloc(0),
        finalUrl: url,
        ms: Date.now() - started,
        ttfb: Date.now() - started,
        ...r,
      });
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
        headers: {
          "User-Agent": ua,
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "zh-CN,zh;q=0.9",
          ...headers,
        },
        rejectUnauthorized: false, // 大量 TVBox 接口站证书不规范
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        const ttfb = Date.now() - started;
        if (redirects > 0 && [301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return settle({ status, error: "重定向地址无效", ttfb });
          }
          return httpGet(next, { ua, headers, timeoutMs, maxBytes, redirects: redirects - 1, measure }).then(
            (r) => settle({ ...r, ms: Date.now() - started }),
          );
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
            /* 解压失败就保留原始数据 */
          }
          settle({ ok: status >= 200 && status < 300, status, body, ttfb, finalUrl: url });
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
        void measure; // 已通过 ttfb 覆盖
      },
    );
    req.on("timeout", () => req.destroy(new Error("连接超时")));
    req.on("error", (e) => settle({ error: e.message || String(e) }));
    timer = setTimeout(() => req.destroy(new Error("下载超时")), timeoutMs * 2);
    req.end();
  });
}

/** 三次取样取中位数，用于测速（减少网络抖动误杀） */
export async function measureLatency(url, opts = {}) {
  const samples = [];
  let lastErr = "";
  const rounds = opts.rounds ?? 3;
  for (let i = 0; i < rounds; i++) {
    const r = await httpGet(url, { ...opts, measure: true, maxBytes: opts.maxBytes ?? 256 * 1024 });
    if (r.ok && r.body.length >= (opts.minBytes ?? 50)) {
      samples.push({ ttfb: r.ttfb, ms: r.ms, bytes: r.body.length });
    } else {
      lastErr = r.error || `HTTP ${r.status}`;
    }
  }
  if (!samples.length) return { ok: false, error: lastErr || "全部失败" };
  const pick = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const ttfb = pick("ttfb");
  const ms = pick("ms");
  const bytes = pick("bytes");
  const kbps = ms > 0 ? Math.round((bytes / 1024) * (1000 / ms)) : 0;
  return { ok: true, ttfb, ms, bytes, kbps, samples: samples.length };
}

/* ============================ 解码 & 宽松 JSON ============================ */

const pad16 = (s) => Buffer.from((s + "0000000000000000").slice(0, 16), "utf8");
const looksJsonStart = (s) => /^[{[]/.test(s);

/** 2423 开头的 AES-128-CBC（FongMi / TVBox 常见加密格式） */
function cbcDecrypt(data) {
  const idxKey = data.indexOf("2324") + 4;
  const key = Buffer.from(data.slice(0, idxKey), "hex")
    .toString("utf8")
    .replace("$#", "")
    .replace("#$", "");
  const idxIv = data.length - 26;
  const iv = Buffer.from(data.slice(idxIv).trim(), "hex").toString("utf8");
  const enc = Buffer.from(data.slice(idxKey, idxIv).trim(), "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", pad16(key), pad16(iv));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/** 把响应体还原成配置文本：处理 BOM / 图片套壳 / 2423 AES / 整体 Base64 */
export function decodeConfigText(buf) {
  let text = buf.toString("utf8").replace(/^\uFEFF/, "");

  // 图片套壳：图片字节 + "xxxxxxxx**" + base64 配置
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
      /* 解不开就按原文 */
    }
  } else if (!/^[{[/]/.test(text) && /^[A-Za-z0-9+/=\s_-]{32,}$/.test(text)) {
    const dec = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8").trim();
    if (looksJsonStart(dec)) text = dec;
  }
  return text.replace(/^\uFEFF/, "").trim();
}

/** 宽松 JSON：去注释/尾逗号、单引号转双引号、修复字符串内换行、逐行剔除损坏条目 */
export function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* 继续宽松解析 */
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
      out = out.slice(0, ls) + out.slice(le);
    }
  }
}

/* ============================ URL 归一化 ============================ */

/** 常见 GitHub 代理 / CDN 前缀（2026 年仍在用的） */
export const GH_MIRRORS = [
  "gh-proxy\\.com",
  "gh-proxy\\.org",
  "ghproxy\\.net",
  "ghproxy\\.com",
  "ghproxy\\.monkeyray\\.net",
  "ghfast\\.top",
  "ghp\\.ci",
  "gh\\.api\\.mirror\\.gh-proxy\\.com",
  "cdn\\.gitmirror\\.com",
  "gitmirror\\.com",
  "mirror\\.ghproxy\\.com",
  "hub\\.fastgit\\.org",
];
const GH_MIRROR_RE = new RegExp(`^(${GH_MIRRORS.join("|")})/`, "i");

const looksUrl = (s) => /^(https?:)?\/\//i.test(String(s)) || /^[\w.-]+\.[a-z]{2,}\//i.test(String(s));

/**
 * 归一化 URL —— 这是「去重精进」的核心：
 * 1. 去协议、去 www、去末尾斜杠
 * 2. 剥掉 nesting 的 GitHub 代理前缀（可多层，如 gh-proxy 套 jsdelivr）
 * 3. raw.githubusercontent.com / github.com/raw / jsdelivr 三种写法统一成 G/owner/repo/...
 * 4. 可选：去掉无语义的查询串
 */
export function normUrl(u, opts = {}) {
  let s = String(u ?? "").trim();
  if (!s) return "";
  s = s.split(";")[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 保持原样 */
  }

  s = s.replace(/^[a-z]+:\/\//i, "");

  // 反复剥代理前缀（可能两层）
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s.replace(GH_MIRROR_RE, "");
    // 代理后面紧跟的又是一个完整 URL
    s = s.replace(/^https?:\/\//i, "");
    if (s === before) break;
  }
  // 剥掉 CDN 上叠的 github 前缀
  s = s.replace(/^raw\.githubusercontent\.com\//i, "G/");
  s = s.replace(/^gist\.githubusercontent\.com\//i, "G/gist/");
  s = s.replace(/^cdn\.jsdelivr\.net\/gh\//i, "G/");
  // jsdelivr 用 @main 指向分支，raw 用 /main/；统一成后一种写法，否则同一个文件会被算成两个
  s = s.replace(/^G\/([^/]+)\/([^/]+)@([^/]+)\//i, "G/$1/$2/$3/");
  s = s.replace(/^github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\//i, "G/$1/$2/raw/");

  // 去掉 /refs/heads/ 与 /raw/ 的差异
  s = s.replace(/^G\/([^/]+)\/([^/]+)\/refs\/heads\//i, "G/$1/$2/");
  s = s.replace(/^G\/([^/]+)\/([^/]+)\/raw\//i, "G/$1/$2/");

  const slash = s.indexOf("/");
  let host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  let path = slash < 0 ? "" : s.slice(slash);
  path = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\/+(?=\?)/, "");

  if (opts.dropQuery) path = path.split("?")[0];

  return host + path;
}

/** 相对路径补全（备份后到处都能用） */
const isRelPath = (s) => /^(\.\.?\/|\/[^/])/.test(s);
export function resolveUrl(value, base) {
  if (typeof value !== "string" || !value) return value;
  const [head, ...rest] = value.split(";");
  if (!isRelPath(head.trim())) return value;
  try {
    return [decodeURI(new URL(head.trim(), base).toString()), ...rest].join(";");
  } catch {
    return value;
  }
}

export const stableStringify = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? "");
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
};

/** ext 归一化：字符串型 URL 也做镜像归一，对象递归 */
export function normExt(ext) {
  if (ext === undefined || ext === null || ext === "") return "";
  if (typeof ext === "string") {
    const t = ext.trim();
    return looksUrl(t) ? normUrl(t) : t;
  }
  if (typeof ext === "object") {
    const out = Array.isArray(ext) ? [] : {};
    for (const k of Object.keys(ext).sort()) out[k] = normExt(ext[k]);
    return out;
  }
  return ext;
}

/* ============================ 站点分类 / 去重键 ============================ */

export function siteCategory(site) {
  const type = Number(site.type);
  const api = String(site.api || "");
  if (type === 0 || type === 1) return "cj";
  if (/\.py(\?|$)/i.test(api)) return "py";
  if (/\.js(\?|$)/i.test(api)) return "js";
  if (type === 3) return "spider";
  if (/\.py(\?|$)/i.test(String(site.ext || ""))) return "py";
  if (/\.js(\?|$)/i.test(String(site.ext || ""))) return "js";
  return "other";
}

/** 去掉 cms 接口上的 ac=list / ac=detail 之类查询串，避免同一个站被当成两个 */
function stripCmsQuery(api) {
  const s = String(api || "");
  if (!/\/api\.php\/provide\/vod/i.test(s) && !/\?ac=/i.test(s)) return s;
  const base = s.split("?")[0];
  const q = s.includes("?") ? s.slice(s.indexOf("?") + 1) : "";
  const keep = q
    .split("&")
    .filter((kv) => kv && !/^ac=/i.test(kv))
    .join("&");
  return keep ? `${base}?${keep}` : base;
}

/**
 * 站点去重键。
 * 相比原脚本，这里额外做了：
 *  - cms 的 ?ac=list / ?ac=detail 归一（原脚本会当成不同站）
 *  - ext 内部 URL 的镜像前缀归一（更彻底）
 */
export function siteDedupKey(site) {
  const type = Number(site.type ?? 0);
  const rawApi = stripCmsQuery(String(site.api || "").trim());
  const api = looksUrl(rawApi) ? normUrl(rawApi) : rawApi;
  const ext = normExt(site.ext);
  return `${type}|${api}|${typeof ext === "string" ? ext : stableStringify(ext)}`;
}

/** 内容指纹：用于检测「同一个资源站换了域名」的重复（仅在拿到响应时可用） */
export function contentFingerprint(samples) {
  const clean = [...new Set(samples.map((s) => String(s).trim()).filter(Boolean))].sort();
  if (!clean.length) return "";
  return crypto.createHash("sha1").update(clean.join("\n")).digest("hex").slice(0, 16);
}

/* ============================ 测速分档 ============================ */

export const SPEED = {
  FAST_TTFB: Number(process.env.FAST_TTFB_MS || 800),
  OK_TTFB: Number(process.env.OK_TTFB_MS || 3000),
  SLOW_TTFB: Number(process.env.SLOW_TTFB_MS || 6000),
  MIN_KBPS: Number(process.env.MIN_KBPS || 30),
};

/** 返回 fast | ok | slow | dead */
export function speedGrade(m) {
  if (!m || !m.ok) return "dead";
  if (m.ttfb > SPEED.SLOW_TTFB) return "slow";
  if (m.ttfb > SPEED.OK_TTFB) return "slow";
  if (m.kbps && m.kbps < SPEED.MIN_KBPS) return "slow";
  if (m.ttfb <= SPEED.FAST_TTFB) return "fast";
  return "ok";
}

/** 排序权重：fast < ok < slow < dead */
export const GRADE_ORDER = { fast: 0, ok: 1, slow: 2, dead: 3 };
