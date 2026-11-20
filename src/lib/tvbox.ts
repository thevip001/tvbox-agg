import crypto from "node:crypto";
import { Agent, fetch as ufetch } from "undici";

export const TVBOX_UA = "okhttp/3.15";

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false, timeout: 10_000 },
  headersTimeout: 20_000,
  bodyTimeout: 30_000,
});

export type AnyObj = Record<string, unknown>;

export interface FetchResult {
  ok: boolean;
  status: number;
  body: Buffer;
  finalUrl: string;
  error?: string;
  ms: number;
}

/** 模拟 TVBox 客户端请求 */
export async function httpGet(
  url: string,
  opts: { ua?: string; timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {},
): Promise<FetchResult> {
  const start = Date.now();
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;
  try {
    const target = new URL(url).toString();
    const res = await ufetch(target, {
      dispatcher: insecureAgent,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { "User-Agent": opts.ua || TVBOX_UA, Accept: "*/*", ...(opts.headers || {}) },
    });
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        const b = Buffer.from(chunk as Uint8Array);
        total += b.length;
        if (total > maxBytes) break;
        chunks.push(b);
      }
    }
    return { ok: res.ok, status: res.status, body: Buffer.concat(chunks), finalUrl: res.url || target, ms: Date.now() - start };
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    return { ok: false, status: 0, body: Buffer.alloc(0), finalUrl: url, error: err.cause?.message || err.message, ms: Date.now() - start };
  }
}

/* ---------------- 解码 ---------------- */

function hexToStr(hex: string) {
  return Buffer.from(hex, "hex").toString("utf8");
}
function pad16(s: string) {
  return Buffer.from((s + "0000000000000000").slice(0, 16), "utf8");
}

/** FongMi/TVBox 的 2423 开头 AES-CBC 加密 */
function cbcDecrypt(data: string): string {
  const idxKey = data.indexOf("2324") + 4;
  const key = hexToStr(data.slice(0, idxKey)).replace("$#", "").replace("#$", "");
  const idxIv = data.length - 26;
  const iv = hexToStr(data.slice(idxIv).trim());
  const enc = Buffer.from(data.slice(idxKey, idxIv).trim(), "hex");
  const decipher = crypto.createDecipheriv("aes-128-cbc", pad16(key), pad16(iv));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function decodeConfigText(buf: Buffer): string {
  let text = buf.toString("utf8");
  // 图片套壳：xxxxxxxx** 后面是 base64
  const m = /[A-Za-z0-9]{8}\*\*/.exec(text);
  if (m) {
    const b64 = text.slice(m.index + m[0].length).replace(/[^A-Za-z0-9+/=_-]/g, "");
    text = Buffer.from(b64, "base64").toString("utf8");
  }
  text = text.replace(/^\uFEFF/, "").trim();
  if (text.startsWith("2423")) {
    try {
      text = cbcDecrypt(text);
    } catch {
      /* ignore */
    }
  } else if (!/^[{[\/]/.test(text) && /^[A-Za-z0-9+/=\s_-]{32,}$/.test(text)) {
    try {
      const d = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8").trim();
      if (d.startsWith("{")) text = d;
    } catch {
      /* ignore */
    }
  }
  return text.replace(/^\uFEFF/, "").trim();
}

/** 宽松 JSON：去掉注释、尾逗号 */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fallthrough */
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
      else if (c < " ") out += "";
      else out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += '"';
      i++;
      // 单引号字符串转为双引号
      if (c === "'") {
        let s = "";
        while (i < text.length && text[i] !== "'") {
          if (text[i] === "\\") {
            s += text[i] + (text[i + 1] ?? "");
            i += 2;
            continue;
          }
          s += text[i] === '"' ? '\\"' : text[i];
          i++;
        }
        out += s + '"';
        inStr = false;
        i++;
      }
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
  // 容错：逐行剔除损坏的条目（多数配置一行一个站点）
  for (let attempt = 0; ; attempt++) {
    out = out.replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(out);
    } catch (e) {
      const msg = (e as Error).message;
      let pos = Number(/position (\d+)/.exec(msg)?.[1]);
      if (!Number.isFinite(pos)) {
        const snip = /, (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(msg)?.[1];
        const tok = /Unexpected token '([\s\S])'/.exec(msg)?.[1];
        if (snip) {
          const at = out.indexOf(snip);
          if (at >= 0) pos = at + Math.max(0, tok ? snip.indexOf(tok) : 0);
        }
      }
      if (!Number.isFinite(pos) || attempt >= 40) throw e;
      const ls = out.lastIndexOf("\n", pos - 1);
      const le = out.indexOf("\n", pos);
      if (ls < 0 || le < 0) throw e;
      out = out.slice(0, ls) + out.slice(le);
    }
  }
}

/* ---------------- 路径 & 规范化 ---------------- */

const isRel = (s: string) => /^(\.\.?\/|\/[^/])/.test(s);

export function resolveUrl(value: unknown, base: string): unknown {
  if (typeof value !== "string" || !value) return value;
  const [head, ...rest] = value.split(";");
  if (isRel(head.trim())) {
    try {
      const abs = new URL(head.trim(), base).toString();
      return [decodeURI(abs), ...rest].join(";");
    } catch {
      return value;
    }
  }
  return value;
}

/** 用于去重的 URL 规范化：忽略协议、大小写主机、尾斜杠、GitHub 代理前缀 */
export function normUrl(u: string): string {
  let s = (u || "").trim();
  if (!s) return "";
  s = s.split(";")[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* ignore */
  }
  // 去掉 gh 代理前缀，只保留 raw.githubusercontent.com / github.com 部分
  const gh = /(raw\.githubusercontent\.com|github\.com|gist\.githubusercontent\.com|cdn\.jsdelivr\.net)\/.*/i.exec(s);
  if (gh) s = gh[0].replace(/\/{2,}/g, "/");
  s = s.replace(/^[a-z]+:\/\//i, "");
  const slash = s.indexOf("/");
  const host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  const path = slash < 0 ? "" : s.slice(slash);
  return (host + path).replace(/\/+$/, "").replace(/\/+(?=\?)/, "");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? "");
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as AnyObj;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

const looksUrl = (s: string) => /^(https?:)?\/\//i.test(s) || /^[\w.-]+\.[a-z]{2,}\//i.test(s);

export function normExt(ext: unknown): string {
  if (ext === undefined || ext === null || ext === "") return "";
  if (typeof ext === "string") {
    const t = ext.trim();
    return looksUrl(t) ? normUrl(t) : t;
  }
  return stableStringify(ext);
}

export function siteCategory(site: AnyObj): string {
  const type = Number(site.type);
  const api = String(site.api || "");
  if (type === 0 || type === 1) return "cj";
  if (/\.py(\?|$)/i.test(api)) return "py";
  if (/\.js(\?|$)/i.test(api) || /drpy|\.js$/i.test(String(site.ext || ""))) return "js";
  if (type === 3) return "spider";
  return "other";
}

export function siteDedupKey(site: AnyObj): string {
  const type = Number(site.type ?? 0);
  const api = String(site.api || "").trim();
  const apiN = looksUrl(api) ? normUrl(api) : api;
  return `${type}|${apiN}|${normExt(site.ext)}`;
}

export function liveDedupKey(url: string): string {
  return normUrl(url);
}

/* ---------------- 配置规范化 ---------------- */

export interface NormalizedConfig {
  spider?: string;
  wallpaper?: string;
  sites: AnyObj[];
  lives: AnyObj[];
  parses: AnyObj[];
  flags: string[];
  rules?: unknown[];
  doh?: unknown[];
  subConfigs?: string[];
}

/** 把旧版 lives（group/channels + proxy://...ext=base64）转成新版 */
function normalizeLives(lives: unknown, base: string): AnyObj[] {
  if (!Array.isArray(lives)) return [];
  const out: AnyObj[] = [];
  for (const raw of lives) {
    if (!raw || typeof raw !== "object") continue;
    const l = raw as AnyObj;
    if (typeof l.url === "string" && l.url) {
      const live: AnyObj = { ...l };
      live.name = String(l.name || l.group || "直播");
      live.url = resolveUrl(l.url, base);
      if (l.epg) live.epg = resolveUrl(l.epg, base);
      if (l.logo) live.logo = resolveUrl(l.logo, base);
      out.push(live);
      continue;
    }
    if (Array.isArray(l.channels)) {
      for (const ch of l.channels as AnyObj[]) {
        const urls = Array.isArray(ch?.urls) ? (ch.urls as string[]) : [];
        for (const u of urls) {
          const m = /ext=([^&]+)/.exec(String(u));
          let url = "";
          if (m) {
            try {
              url = Buffer.from(decodeURIComponent(m[1]), "base64").toString("utf8").trim();
            } catch {
              /* ignore */
            }
          } else if (/^https?:\/\//.test(String(u))) url = String(u);
          if (url && /^https?:\/\//.test(url)) {
            out.push({ name: String(ch.name || l.group || "直播"), type: 0, url });
          }
        }
      }
    }
  }
  return out;
}

export function normalizeConfig(cfg: AnyObj, base: string): NormalizedConfig {
  const spider = typeof cfg.spider === "string" ? (resolveUrl(cfg.spider, base) as string) : undefined;
  const sites: AnyObj[] = [];
  for (const raw of Array.isArray(cfg.sites) ? cfg.sites : []) {
    if (!raw || typeof raw !== "object") continue;
    const s: AnyObj = { ...(raw as AnyObj) };
    if (!s.api || !s.key) continue;
    s.api = resolveUrl(s.api, base);
    if (typeof s.ext === "string") s.ext = resolveUrl(s.ext, base);
    if (s.jar) s.jar = resolveUrl(s.jar, base);
    if (Number(s.type) === 3 && !s.jar && spider) s.jar = spider;
    sites.push(s);
  }
  const parses = (Array.isArray(cfg.parses) ? cfg.parses : []).filter(
    (p): p is AnyObj => !!p && typeof p === "object" && typeof (p as AnyObj).url === "string",
  );
  const flags = (Array.isArray(cfg.flags) ? cfg.flags : []).filter((f): f is string => typeof f === "string");
  return {
    spider,
    wallpaper: typeof cfg.wallpaper === "string" ? (resolveUrl(cfg.wallpaper, base) as string) : undefined,
    sites,
    lives: normalizeLives(cfg.lives, base),
    parses,
    flags,
    rules: Array.isArray(cfg.rules) ? cfg.rules : undefined,
    doh: Array.isArray(cfg.doh) ? cfg.doh : undefined,
  };
}

async function loadRaw(url: string): Promise<{ data?: AnyObj; size: number; error?: string; finalUrl: string }> {
  const r = await httpGet(url, { timeoutMs: 20_000 });
  if (!r.ok) return { size: 0, error: r.error || `HTTP ${r.status}`, finalUrl: r.finalUrl };
  const text = decodeConfigText(r.body);
  try {
    const data = parseLooseJson(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { size: r.body.length, error: "不是有效的 JSON 对象", finalUrl: r.finalUrl };
    return { data: data as AnyObj, size: r.body.length, finalUrl: r.finalUrl };
  } catch {
    return { size: r.body.length, error: "JSON 解析失败", finalUrl: r.finalUrl };
  }
}

/** 拉取一个接口（自动展开多仓 urls/storeHouse，最多 12 个子仓） */
export async function fetchTvboxConfig(url: string): Promise<{ config?: NormalizedConfig; size: number; error?: string }> {
  const first = await loadRaw(url);
  if (!first.data) return { size: first.size, error: first.error };
  const base = first.finalUrl || url;
  const d = first.data;
  if (Array.isArray(d.sites) || Array.isArray(d.lives)) {
    return { config: normalizeConfig(d, base), size: first.size };
  }
  const subs = (Array.isArray(d.urls) ? d.urls : Array.isArray(d.storeHouse) ? d.storeHouse : []) as AnyObj[];
  const subUrls = subs
    .map((s) => (typeof s === "string" ? s : String(s?.url || s?.sourceUrl || "")))
    .filter(Boolean)
    .map((u) => String(resolveUrl(u, base)))
    .slice(0, 12);
  if (!subUrls.length) return { size: first.size, error: "未找到 sites/lives 字段" };
  const merged: NormalizedConfig = { sites: [], lives: [], parses: [], flags: [], subConfigs: subUrls };
  let size = first.size;
  const results = await Promise.all(subUrls.map((u) => loadRaw(u)));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.data || !(Array.isArray(r.data.sites) || Array.isArray(r.data.lives))) continue;
    size += r.size;
    const n = normalizeConfig(r.data, r.finalUrl || subUrls[i]);
    merged.spider ??= n.spider;
    merged.wallpaper ??= n.wallpaper;
    merged.sites.push(...n.sites);
    merged.lives.push(...n.lives);
    merged.parses.push(...n.parses);
    merged.flags.push(...n.flags);
  }
  if (!merged.sites.length && !merged.lives.length) return { size, error: "多仓子接口均不可用" };
  return { config: merged, size };
}

/* ---------------- 直播列表解析 ---------------- */

export interface Channel {
  group: string;
  name: string;
  url: string;
  logo?: string;
  tvgName?: string;
}

export function parsePlaylist(text: string): Channel[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out: Channel[] = [];
  if (/^\s*#EXTM3U/i.test(text) || /#EXTINF/i.test(text)) {
    let pending: Omit<Channel, "url"> | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^#EXTINF/i.test(line)) {
        const group = /group-title="([^"]*)"/i.exec(line)?.[1] || "未分组";
        const logo = /tvg-logo="([^"]*)"/i.exec(line)?.[1];
        const tvgName = /tvg-name="([^"]*)"/i.exec(line)?.[1];
        const name = line.slice(line.lastIndexOf(",") + 1).trim() || tvgName || "未命名";
        pending = { group, name, logo, tvgName };
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

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
