/**
 * deepcheck.mjs —— 「这个站到底能不能用」的能力体检
 *
 * 背景（2026-11-22）：旧流程只验到「接口文件能下载 / jar 是 ZIP / ext 第一个域名能连」，
 * 于是产物里仍混着一堆在 TVBox 里点开就报错的站：
 *
 *   · 采集站（type 0/1）：只要求 `ac=list` 响应里出现 list/code 字样、`ac=detail&pg=1`
 *     里出现 "list" —— 而失效站常见返回 `{"code":0,"list":[]}`，两个条件全中，
 *     于是「活着但一条内容都没有」的空壳站被当成健康站收录。
 *   · Jar 爬虫站：只验 jar 是 ZIP。但 `csp_XBPQ` 要的是 jar 里真的存在
 *     `com.github.catvod.spider.XBPQ` 这个类。类不在包里，TVBox 一加载就是
 *     ClassNotFoundException（站点列表里看得见、点开全报错），而我们的 HTTP 探活看不出任何异常。
 *   · XBPQ / XYQHiker 这类「规则驱动」的爬虫：真正干活的是 ext 里的规则 + 规则指向的目标站。
 *     规则 JSON 缺字段、目标站换域名 / 挂掉，探活都照样通过。
 *   · JS / Py 站：只验文件像脚本，不看规则里写的 host 是否还活着、ext 规则是否完整。
 *
 * 这里补上 MisaTV（yagami-hue/MisaTV）那套「体检」思路，并按「宁可误杀」收紧：
 *   - 采集站：必须「有内容」且「搜索有结果」（ac=search&wd=… 返回条目），否则剔除；
 *   - 按源类型分别判定：CMS 看内容+搜索、Py 看 `class Spider`、JS 看规则、Jar 看类是否在包里；
 *   - 规则里的目标站要「有活着的一个」才算可用（全死才算死）；
 *   - 严格模式：判不准（403/429/超时）也剔除，不把「测不准」当成可用。
 *
 * 产出统一成 health 状态，写进剔除报告，能看到「为什么不可用」而不是一句「失效」。
 * 零第三方依赖：ZIP 解包用 node:zlib 自己读中央目录。
 */
import { inflateRawSync } from "node:zlib";
import { httpGet, normUrl, parseLooseJson } from "./core.mjs";

/* ============================ health 状态 ============================ */

/** 判定为「确定不可用」的状态（strict 模式下会剔除） */
export const HEALTH = {
  OK_CONTENT: "ok-content", // 有内容 + 搜索有结果（唯一「确定可用」档）
  OK_CLASSES: "ok-classes", // 有分类能刷出条目，但搜索无结果 / 未验搜索（严格模式当死）
  OK_UNKNOWN: "ok-unknown", // 没有可验的抓手（内置类且无需 ext），信任保留
  NEEDS_EXT: "needs-ext", // 这类爬虫必须有 ext 才能工作，但 ext 是空的
  EMPTY: "empty", // 请求成功，但没有条目也没有分类（空壳站）
  NO_SEARCH: "no-search", // 有分类/条目，但搜索接口返回空（用不了搜索）
  NO_CLASS: "no-class", // jar 里根本没有这个爬虫类（ClassNotFoundException）
  NO_TARGET: "no-target", // 规则里的目标站全部不可达 / 已停站
  NO_RULE: "no-rule", // JS/Py 规则文件不完整（不是规则、缺 Spider 类）
  ERROR: "error", // 请求或解析直接报错
  UNCERTAIN: "uncertain", // 403 / 429 / 超时：判不准（严格模式也剔，宁可误杀）
};

/** 这些状态属于「确定不可用」（严格模式全部剔除） */
export const DEAD_HEALTH = new Set([
  HEALTH.NEEDS_EXT,
  HEALTH.EMPTY,
  HEALTH.NO_SEARCH,
  HEALTH.NO_CLASS,
  HEALTH.NO_TARGET,
  HEALTH.NO_RULE,
  HEALTH.ERROR,
  HEALTH.OK_CLASSES, // 严格：没有搜索结果不算「好用」
]);

/** 状态 → 中文短标签（报告里用） */
export const HEALTH_LABEL = {
  [HEALTH.OK_CONTENT]: "有内容+可搜",
  [HEALTH.OK_CLASSES]: "有分类无搜索",
  [HEALTH.OK_UNKNOWN]: "无需验",
  [HEALTH.NEEDS_EXT]: "缺 ext",
  [HEALTH.EMPTY]: "空壳",
  [HEALTH.NO_SEARCH]: "搜索无结果",
  [HEALTH.NO_CLASS]: "类不存在",
  [HEALTH.NO_TARGET]: "目标站全挂",
  [HEALTH.NO_RULE]: "规则无效",
  [HEALTH.ERROR]: "报错",
  [HEALTH.UNCERTAIN]: "判不准",
};

/**
 * 必须有 ext 才能真正工作的内置爬虫类（已核对过 jar 里的实现：这些类的 init 会
 * 把 ext 当规则/站点地址解析，空 ext 时 homeContent 直接返回空）。
 *
 * 刻意不写全集：像 csp_Bili / csp_PanSou 这类自带默认站点的类，空 ext 也能用，
 * 一律塞进名单就会误杀。名单只放「实测空 ext 必空」的规则型爬虫。
 */
export const NEEDS_EXT_CLASSES = new Set([
  "XBPQ",
  "HBPQ",
  "XYQHiker",
  "WebRule",
  "MacCmsApi",
  "DmBus",
  "DMbusAmns",
  "FirstAid",
  "FirstAidGuard",
  "Wogg",
  "Mogg",
  "AppV7Amns",
  "Market",
  "Getapp",
  "Duopan",
  "Kongbai",
  "XBPQAmns",
]);

/** 规则里代表「目标站」的字段名（XBPQ / drpy / 通用 JSON 规则都覆盖） */
const TARGET_KEYS = [
  "host",
  "homeUrl",
  "home_url",
  "homepage",
  "homePage",
  "siteUrl",
  "site_url",
  "siteurl",
  "baseUrl",
  "base_url",
  "url",
  "网址",
  "主页url",
  "主页URL",
  "分类url",
  "分类URL",
  "域名",
  "site",
];

/* ============================ 小工具 ============================ */

const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const trimmed = (s, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** 去掉 `;md5;xxx` / `;json` 之类的后缀，只留地址本体 */
export function cleanResourceUrl(u) {
  return String(u ?? "").trim().split(";")[0].trim();
}

/**
 * 从任意字符串里抽出「目标站 origin」。
 * 兼容 `//host/path`、`https://www.%79%6f%75%6b%75.com`（百分号编码的域名）、
 * 以及带 `{{fl.cateId}}` 模板的地址（只取到路径前的 origin）。
 */
export function toOrigin(u) {
  const full = toProbeUrl(u);
  return full ? originOf(full) : "";
}

/**
 * 把规则里的地址变成「可以真的去请求」的 URL：
 *   - 补协议、解百分号域名
 *   - 把 drpy / XBPQ 的模板占位符（`{cateId}`、`{{pg}}`、`fyclass`）去掉
 *   - 模板把路径搞坏时（如 `/vodshow/1--------{{pg}}---.html`），退到 origin
 */
export function toProbeUrl(u) {
  let s = String(u ?? "").trim();
  if (!s) return "";
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 保持原样 */
  }
  if (/^\/\//.test(s)) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) return "";
  // 带模板占位符的地址（`/vodshow/1--------{{pg}}---.html`）没法直接请求：
  // 有 `{` 就把路径整个去掉退到 origin；没有占位符的普通地址保留完整路径。
  if (/[{}]/.test(s)) s = s.replace(/^((?:https?:\/\/)?[^/{]+)[\s\S]*$/, "$1");
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

/** 明显不是「目标影视站」的域名：图床/CDN/播放器/GitHub 资源 */
const IGNORED_HOST_RE =
  /(^|\.)((githubusercontent|jsdelivr|gitee|ghproxy\w*|kkgithub|gitmirror|gh-proxy|ghfast)\.[a-z.]+|(bilibili|iqiyi|qq|youku|mgtv|1905|pptv|le|sohu|douban|weibo|zhihu|baidu|google|cloudflare|gstatic|akamai|alicdn|myqcloud|qiniu|upyun|bcebos|meitudata|moji)\.(com|cn|net|tv))$/i;
const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|ts|mkv|m4a|mp3|jpg|jpeg|png|gif|webp|svg|css|woff2?)(\?|$)/i;

/** 取 origin（含端口）：`https://a.com:8080/x` → `https://a.com:8080` */
function originOf(probeUrl) {
  try {
    const x = new URL(probeUrl);
    return `${x.protocol}//${x.host}`;
  } catch {
    return "";
  }
}

/** 只取主机名（不含端口），给「值不值得探」的判断用 */
function hostOnly(probeUrl) {
  try {
    return new URL(probeUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 这个 origin 值不值得去探活 */
export function isProbeableTarget(origin) {
  const host = hostOnly(String(origin || "").replace(/^https?:\/\//i, "https://"));
  if (!host || !host.includes(".")) return false;
  if (IGNORED_HOST_RE.test(host)) return false;
  if (MEDIA_EXT_RE.test(host)) return false;
  return true;
}

/* ============================ ZIP / dex 读取 ============================ */

function findEocd(buf) {
  // End of Central Directory：签名 0x06054b50，从尾部往前找（注释最长 64KB）
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

/**
 * 读 ZIP（jar）里的条目。只支持 stored(0) / deflate(8) —— TVBox 的 jar 全是这两种。
 * 返回 Map<名字, Buffer>；解不开的条目直接跳过（不抛异常，jar 是外来的）。
 */
export function readZipEntries(buf) {
  const out = new Map();
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return out;
  const eocd = findEocd(buf);
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) break;
    if (!(buf[p] === 0x50 && buf[p + 1] === 0x4b && buf[p + 2] === 0x01 && buf[p + 3] === 0x02)) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (localOff + 30 > buf.length) continue;
    if (!(buf[localOff] === 0x50 && buf[localOff + 1] === 0x4b)) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    if (!raw.length) continue;
    try {
      out.set(name, method === 0 ? raw : method === 8 ? inflateRawSync(raw) : raw);
    } catch {
      /* 单条解压失败不影响别的条目 */
    }
  }
  return out;
}

/**
 * dex 里的类描述符是 `Lcom/github/catvod/spider/XBPQ;` 这种形式。
 * 必须带首尾的 L/;，否则相邻的字符串会连成一串（实测 `XBPQ` 后面紧跟别的类名，
 * 不带分隔符就会抽成 `XBPQcom`，然后整批站点被误判成「类不存在」）。
 */
const SPIDER_CLASS_RE = /Lcom\/github\/catvod\/spider\/([A-Za-z0-9_$]{2,60});/g;
const JS_ENGINE_RE = /(com\/whl\/quickjs|quickjs\/Context|com\/github\/catvod\/crawler|com\/github\/catvod\/spider\/js)/i;

/**
 * 从 jar 的 dex 里抽出「这个包到底带了哪些爬虫类」。
 *
 * dex 的字符串池就是明文（长度前缀 + 原文），按字节搜描述符即可
 * （已用 HCCX.jar / xiaobudian.jar / fty.jar 三个真实 jar 逐个核对）。
 */
export function inspectDexEntries(buffers) {
  const classes = new Set();
  let hasQuickJs = false;
  for (const b of buffers) {
    if (!b || !b.length) continue;
    const text = b.toString("latin1");
    if (!hasQuickJs && JS_ENGINE_RE.test(text)) hasQuickJs = true;
    SPIDER_CLASS_RE.lastIndex = 0;
    let m;
    while ((m = SPIDER_CLASS_RE.exec(text))) classes.add(m[1]);
  }
  return { classes, hasQuickJs };
}

/**
 * 包里有没有「这个类」。
 *
 * 只做严格同名判断会误杀：同一个爬虫经常被打包成「类名 + 后缀」的变体，
 * 例如 xiaobudian.jar 里 `csp_Wogg` 的实现叫 `WoggFishGuard`、
 * `csp_AppNox` 叫 `AppNoxFishGuard`（整套 FishGuard 家族）。
 * 所以：同名（忽略大小写）或「类名 + 大写开头的后缀」都算命中。
 * 判定方向刻意宽松 —— 宁可漏杀，也不要把能用的站错误删掉。
 */
export function jarHasClass(classes, cls) {
  if (!cls || !classes?.size) return false;
  const lower = new Set([...classes].map((c) => c.toLowerCase()));
  if (lower.has(cls.toLowerCase())) return true;
  const pref = cls.toLowerCase();
  for (const c of lower) if (c.startsWith(pref) && c.length > pref.length) return true;
  return false;
}

/**
 * 站点 api 里的类名：`csp_XBPQ` → `XBPQ`；`com.github.catvod.spider.Foo` → `Foo`。
 *
 * 只认 `csp_` 前缀与全限定类名这两种「确定是 Java 类」的写法：
 * `py_cctv_full` / `js_xxx` 这类名字后面不是类名，拿去比 dex 只会误杀。
 */
export function spiderClassOf(api) {
  const s = String(api || "").trim();
  if (!s) return "";
  const csp = /^csp_([A-Za-z0-9_$]+)/i.exec(s);
  if (csp) return csp[1];
  const fq = /^com\.github\.catvod\.spider\.([A-Za-z0-9_$]+)/.exec(s);
  return fq ? fq[1] : "";
}

/** 这个 api 是不是「确定要靠 jar 里的某个类」 */
export function isJarClassApi(api) {
  return /^csp_[A-Za-z0-9_$]+/i.test(String(api || "").trim());
}

/* ============================ 采集站（CMS）解析 ============================ */

/**
 * 解析 CMS 响应：JSON（苹果CMS / 海洋CMS 等）或 XML（type 0 必用）。
 * 返回 { classes: [{id,name}], items: [{id,name}] }——只关心「有没有真内容」。
 */
export function parseCmsPayload(text, type) {
  const t = String(text || "").trim();
  const classes = [];
  const items = [];
  if (!t) return { classes, items };
  // 格式看内容，不只看 type：现实里 type=0 的站返回 JSON、type=1 的站返回 XML 都很常见，
  // 按 type 一刀切会把整类站点解析成「空壳」然后全删。
  const isXml = /^<\?xml|^<rss|<rss[\s>]/i.test(t);
  if (isXml || (!/^\s*[[{]/.test(t) && type === 0)) {
    // XML：<class><ty id="1">动作</ty></class>  <list><video><id>1</id><name>片名</name>
    for (const m of t.matchAll(/<ty\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/ty>/gi)) {
      classes.push({ id: m[1].trim(), name: trimmed(m[2].replace(/<[^>]+>/g, ""), 40) });
    }
    for (const m of t.matchAll(/<video>([\s\S]*?)<\/video>/gi)) {
      const id = (/<id>([\s\S]*?)<\/id>/i.exec(m[1]) || [])[1] || "";
      const name = (/<name>([\s\S]*?)<\/name>/i.exec(m[1]) || [])[1] || "";
      if (id || name) items.push({ id: trimmed(id, 60), name: trimmed(name, 60) });
    }
    return { classes, items };
  }
  let data;
  try {
    data = parseLooseJson(t);
  } catch {
    return { classes, items };
  }
  if (!data || typeof data !== "object") return { classes, items };
  for (const c of Array.isArray(data.class) ? data.class : []) {
    if (!c || typeof c !== "object") continue;
    const id = String(c.type_id ?? c.typeId ?? c.id ?? "").trim();
    const name = trimmed(c.type_name ?? c.typeName ?? c.name ?? "", 40);
    if (id || name) classes.push({ id, name });
  }
  for (const v of Array.isArray(data.list) ? data.list : []) {
    if (!v || typeof v !== "object") continue;
    const id = String(v.vod_id ?? v.id ?? "").trim();
    const name = trimmed(v.vod_name ?? v.name ?? "", 60);
    if (id || name) items.push({ id, name });
  }
  return { classes, items };
}

/** 请求失败是否属于「判不准」（限流 / 拒绝 / 超时），这类绝不判死 */
export function isUncertainStatus(r) {
  if (!r) return true;
  if (r.status === 403 || r.status === 408 || r.status === 423 || r.status === 425 || r.status === 429) return true;
  if (r.status >= 500 && r.status <= 599) return true;
  if (!r.status) return true; // DNS / 连接超时 / 重置：也可能是跑测机出口被墙
  return false;
}

/* ============================ 目标站探活 ============================ */

/** 停站 / 域名出售 的典型文案，命中就不算「活」 */
const PARKED_RE =
  /(域名[^。，,]{0,12}(出售|转让|过期|已到期)|该域名(已|可能)?(过期|未备案|被停止)|网站已(关闭|停止|暂停)|站点已(关闭|停止)|clientHold|serverHold|This domain (is|may be) for sale|domain (is )?parked)/i;

/**
 * 探一个目标站是否活着。
 * 「活」的定义：有正常 HTTP 应答（<500，401/403 也算服务器在），且不是停站页。
 */
export async function probeTarget(target, opts = {}) {
  // 选项名对齐 readOptions()：目标站探活单独一个超时（比规则文件的短）
  const timeoutMs = num(opts.deepTargetTimeout ?? opts.timeoutMs, 8000);
  const probeUrl = toProbeUrl(target);
  if (!probeUrl) return { alive: false, uncertain: true, reason: "地址无法解析", status: 0 };
  let r = await httpGet(probeUrl, { timeoutMs, maxBytes: 96 * 1024, ua: opts.ua || "Mozilla/5.0" });
  // 规则里的主页地址常常带一个具体路径；路径 404 不代表站死了，再试根路径
  const origin = originOf(probeUrl);
  if ((r.status === 404 || r.status === 410) && origin && probeUrl.replace(/\/+$/, "") !== origin) {
    r = await httpGet(origin + "/", { timeoutMs, maxBytes: 96 * 1024, ua: opts.ua || "Mozilla/5.0" });
  }
  if (!r.status) {
    // 域名压根解析不出来（NXDOMAIN）是「站没了」的硬证据：停站 / 换域名最常见的样子。
    // 但 EAI_AGAIN / 超时 / 拒连 可能是跑测机自己的网络问题，一律判不准、保留。
    if (/ENOTFOUND|NXDOMAIN/i.test(String(r.error || ""))) {
      return { alive: false, certain: true, reason: "域名已不存在", status: 0 };
    }
    return { alive: false, uncertain: true, reason: r.error || "连接失败", status: 0 };
  }
  if (r.status === 401 || r.status === 403) return { alive: true, status: r.status, reason: "需要登录/拒绝直连（服务器在）" };
  if (r.status >= 500) return { alive: false, uncertain: true, reason: `HTTP ${r.status}`, status: r.status };
  if (r.status >= 400) return { alive: false, certain: true, reason: `HTTP ${r.status}`, status: r.status };
  const text = r.body.toString("utf8");
  if (PARKED_RE.test(text.slice(0, 4096))) return { alive: false, certain: true, reason: "停站/域名出售页", status: r.status };
  if (r.body.length < 120) return { alive: false, certain: true, reason: "页面为空（疑似空壳）", status: r.status };
  return { alive: true, status: r.status, reason: "ok" };
}

/**
 * 目标站批量判定：
 *   - 有任意一个活着 → 可用（不再拿第一个域名一刀切）
 *   - 全部「确定死」→ 不可用
 *   - 全部「判不准」→ 保留（不判死）
 */
export async function judgeTargets(targets, cache, opts = {}) {
  // 同一个站可能在规则里写了好几个路径：按 origin 去重（最多留 2 个路径），
  // 每个路径都要探 —— 规则里第一个地址经常是接口/子页面，根路径能开不代表它还能用；
  // 反过来只探第一个路径也会误杀（首页模板经常改）。
  const byOrigin = new Map();
  for (const raw of targets || []) {
    const origin = toOrigin(raw);
    if (!isProbeableTarget(origin)) continue;
    const probe = toProbeUrl(raw);
    const arr = byOrigin.get(origin) || [];
    if (probe && !arr.includes(probe) && arr.length < 2) arr.push(probe);
    byOrigin.set(origin, arr);
  }
  const list = [...byOrigin.entries()].slice(0, num(opts.deepMaxTargets ?? opts.maxTargets, 3));
  if (!list.length) return { verdict: "unknown", alive: [], dead: [], uncertain: [], detail: "规则里没有可探的目标站" };
  const results = [];
  for (const [origin, urls] of list) {
    let r = cache?.get(origin);
    if (!r) {
      // 站内分多路径时逐个探，任意一个活就算这个站活着
      for (const url of urls.length ? urls : [origin + "/"]) {
        const one = await probeTarget(url, opts);
        if (one.alive) {
          r = one;
          break;
        }
        r = r && !r.certain ? r : one;
      }
      cache?.set(origin, r);
    }
    results.push({ origin, ...r });
  }
  const alive = results.filter((x) => x.alive);
  const dead = results.filter((x) => !x.alive && x.certain);
  const uncertain = results.filter((x) => !x.alive && !x.certain);
  const detail = results
    .map((x) => `${x.origin.replace(/^https?:\/\//, "")}→${x.reason}`)
    .join("；");
  if (alive.length) return { verdict: "alive", alive, dead, uncertain, detail };
  if (dead.length) return { verdict: "dead", alive, dead, uncertain, detail };
  return { verdict: "uncertain", alive, dead, uncertain, detail };
}

/* ============================ 规则文本 → 目标站 ============================ */

/**
 * 从规则文本（JS / JSON / py）里抽出目标站地址。
 * 覆盖 XBPQ 的 `"主页url"`、drpy 的 `host:`、通用 JSON 的 `"url"`/`"siteUrl"` 等写法。
 */
export function extractRuleTargets(text) {
  const t = String(text || "");
  const out = [];
  if (!t) return out;

  // ① 先试 JSON 规则（XBPQ / 通用 ext）
  let json = null;
  try {
    json = parseLooseJson(t.trim());
  } catch {
    json = null;
  }
  if (json && typeof json === "object") {
    // keyInTargets：当前节点是不是「目标站字段」的值（含数组里的元素）。
    // 规则里备选站常写成 `"host": ["https://a", "https://b"]`，
    // 数组分支直接往下递归会把 key 丢掉，导致备选地址一个都抽不出来。
    const walk = (node, depth, keyInTargets = false) => {
      if (!node || depth > 5) return;
      if (typeof node === "string") {
        if (keyInTargets) out.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1, keyInTargets);
        return;
      }
      if (typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        const isTargetKey = TARGET_KEYS.includes(k);
        if (typeof v === "string") {
          if (isTargetKey) out.push(v);
        } else if (v && typeof v === "object") {
          walk(v, depth + 1, isTargetKey);
        }
      }
    };
    walk(json, 0);
  }

  // ② JS / py 规则：host:'xxx'、homeUrl:"xxx"、"主页url": "xxx"
  for (const key of TARGET_KEYS) {
    const re1 = new RegExp(`\\b${key}\\s*[:=]\\s*(["'\`])((?:https?:)?\\/\\/[^"'\`\\s]+)\\1`, "gi");
    let m;
    while ((m = re1.exec(t))) out.push(m[2]);
    const re2 = new RegExp(`["']${key}["']\\s*:\\s*["']((?:https?:)?\\/\\/[^"']+)["']`, "g");
    while ((m = re2.exec(t))) out.push(m[1]);
  }
  return uniq(out.map(cleanResourceUrl));
}

/** ext 是对象时，把里面的「规则文件地址」也捞出来（`json`/`url`/`api` 指向 json 的常见） */
export function extractExtResourceUrls(ext) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || depth > 3) return;
    if (typeof node === "string") {
      const s = cleanResourceUrl(node);
      if (/^https?:\/\//i.test(s) && /\.(json|txt|js)(\?|$)/i.test(s)) out.push(s);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (typeof node === "object") for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(ext, 0);
  return uniq(out);
}

/** ext 是不是「空」 */
export function isEmptyExt(ext) {
  if (ext === undefined || ext === null) return true;
  if (typeof ext === "string") return ext.trim() === "";
  if (typeof ext === "object") return Object.keys(ext).length === 0;
  return false;
}

/* ============================ 各类型体检 ============================ */

/**
 * 采集站体检：真的按协议跑一次「主页 → 首个分类」。
 *
 * 判定：
 *   - 主页有条目                       → ok-content
 *   - 主页只有分类、首个分类能刷出条目   → ok-classes（MisaTV 的 homeFallback 思路）
 *   - 能解析出结构但一直空              → empty（空壳站，剔除）
 *   - 返回的不是 CMS 结构（HTML/报错 JSON）→ error
 *   - 403/429/5xx/连不上                → uncertain（保留，下轮再测）
 */
export async function deepCheckCms(site, opts = {}) {
  const timeoutMs = num(opts.timeoutMs, 9000);
  const type = Number(site?.type ?? 1);
  const raw = cleanResourceUrl(site?.api);
  if (!/^https?:\/\//i.test(raw)) return { status: HEALTH.ERROR, reason: "api 不是有效地址" };

  // 保留原有查询串里除 ac 之外的参数（不少站点用 ?key=xxx 鉴权）
  const [base, query = ""] = raw.split(/\?(.*)/s);
  const keep = query
    .split("&")
    .filter((kv) => kv && !/^ac=/i.test(kv) && !/^(pg|p|t|wd|ids|ac)=/i.test(kv))
    .join("&");
  const withParams = (params) => {
    const q = [keep, new URLSearchParams(params).toString()].filter(Boolean).join("&");
    return `${base}${q ? (base.includes("?") ? "&" : "?") + q : ""}`;
  };

  const acForDetail = type === 0 ? "videolist" : "detail";
  /**
   * 请求并返回 { r, text, failed }：
   *   failed=true 表示「请求失败」（text 为空的原因不是内容为空）——
   *   调用方必须按 failed 区分「判不准 / 报错」，绝不能当成「站是空的」。
   */
  const getJson = async (url) => {
    const r = await httpGet(url, { timeoutMs, maxBytes: 1024 * 1024, ua: "Mozilla/5.0" });
    if (!r.ok) return { r, text: "", failed: true };
    return { r, text: r.body.toString("utf8"), failed: false };
  };

  // ① 拿分类 / 推荐（ac=list）
  const first = await getJson(withParams({ ac: "list" }));
  if (first.failed) {
    if (isUncertainStatus(first.r)) {
      return { status: HEALTH.UNCERTAIN, reason: `ac=list ${first.r.error || `HTTP ${first.r.status}`}（判不准）`, ttfb: first.r.ttfb };
    }
    return { status: HEALTH.ERROR, reason: `ac=list HTTP ${first.r.status}`, ttfb: first.r.ttfb };
  }
  if (!first.text.trim()) {
    return { status: HEALTH.EMPTY, reason: "ac=list 返回空内容（空壳站）", ttfb: first.r.ttfb };
  }
  let parsed = parseCmsPayload(first.text, type);
  const ttfb = first.r.ttfb;
  let contentItems = parsed.items.length;
  let sampleTitle = parsed.items[0]?.name || "";
  let classNames = parsed.classes.map((c) => c.name).join(",");
  let classCount = parsed.classes.length;

  // ② 主页无条目时，用首个分类刷一页
  if (!contentItems && parsed.classes.length) {
    const tid = parsed.classes.find((c) => c.id)?.id;
    if (!tid) {
      return { status: HEALTH.EMPTY, reason: `有 ${parsed.classes.length} 个分类但都没有 id，无法取内容`, ttfb };
    }
    const second = await getJson(withParams({ ac: acForDetail, t: tid, pg: 1 }));
    if (second.failed) {
      if (isUncertainStatus(second.r)) {
        return { status: HEALTH.UNCERTAIN, reason: `分类 ${tid} ${second.r.error || `HTTP ${second.r.status}`}（判不准）`, ttfb };
      }
      return { status: HEALTH.EMPTY, reason: `有 ${parsed.classes.length} 个分类，但首个分类 HTTP ${second.r.status}`, classes: parsed.classes.length, ttfb };
    }
    parsed = parseCmsPayload(second.text, type);
    contentItems = parsed.items.length;
    sampleTitle = parsed.items[0]?.name || sampleTitle;
    if (!contentItems) {
      return {
        status: HEALTH.EMPTY,
        reason: `有分类但取不到任何内容（ac=${acForDetail} 返回空列表），源站可能已失效`,
        classes: classCount,
        ttfb,
      };
    }
  }

  // ③ 连分类都没有：兜底 ac=detail/videolist
  if (!contentItems) {
    const third = await getJson(withParams({ ac: acForDetail, pg: 1 }));
    if (third.failed) {
      if (isUncertainStatus(third.r)) {
        return {
          status: HEALTH.UNCERTAIN,
          reason: `ac=list 无分类，兜底 ac=${acForDetail} ${third.r.error || `HTTP ${third.r.status}`}（判不准）`,
          ttfb,
        };
      }
      return {
        status: HEALTH.ERROR,
        reason: `ac=list 无分类，兜底 ac=${acForDetail} HTTP ${third.r.status}`,
        ttfb,
      };
    }
    if (third.text) {
      const p3 = parseCmsPayload(third.text, type);
      contentItems = p3.items.length;
      sampleTitle = p3.items[0]?.name || "";
    }
    if (!contentItems) {
      const looksCms = /"(class|list)"\s*:|<rss|<class>/i.test(first.text);
      return {
        status: HEALTH.EMPTY,
        reason: looksCms
          ? "接口有响应，但既没有分类也没有任何条目（空壳站）"
          : `接口返回的不是 CMS 数据（${trimmed(first.text, 60) || "空"}）`,
        ttfb,
      };
    }
  }

  // ④ 强制搜索验证（用户要求：有内容 + 搜索有结果才保留，宁可误杀）
  // 关键词：优先用样本标题里的 2 个汉字/字母，否则用常见词「战」「电影」
  const searchWords = [];
  if (sampleTitle) {
    const m = sampleTitle.match(/[\u4e00-\u9fff]{2}|[A-Za-z0-9]{3,}/);
    if (m) searchWords.push(m[0]);
  }
  searchWords.push("战", "电影");
  let searchHit = 0;
  let searchTried = 0;
  let searchLastReason = "";
  for (const wd of searchWords) {
    if (searchHit > 0) break;
    searchTried++;
    const sr = await getJson(withParams({ ac: "search", wd, pg: 1 }));
    if (sr.failed) {
      if (isUncertainStatus(sr.r)) {
        searchLastReason = `ac=search&wd=${wd} ${sr.r.error || `HTTP ${sr.r.status}`}`;
        // 搜索限流/超时：不直接判死整站，继续试下一个词；全失败再按 uncertain
        continue;
      }
      searchLastReason = `ac=search&wd=${wd} HTTP ${sr.r.status}`;
      continue;
    }
    const sp = parseCmsPayload(sr.text, type);
    if (sp.items.length) {
      searchHit = sp.items.length;
      if (!sampleTitle) sampleTitle = sp.items[0]?.name || "";
      break;
    }
    searchLastReason = `ac=search&wd=${wd} 返回 0 条`;
  }

  if (searchHit > 0) {
    return {
      status: HEALTH.OK_CONTENT,
      reason: `有内容 ${contentItems} 条 + 搜索命中 ${searchHit} 条（首条：${sampleTitle || "-"}）`,
      items: contentItems,
      searchItems: searchHit,
      classes: classCount,
      sampleTitle,
      classNames,
      ttfb,
    };
  }

  // 有内容但搜索全空 / 全失败
  // 若全部是限流类失败 → uncertain；若明确 0 条 → no-search（死）
  if (searchTried > 0 && /判不准|HTTP 429|HTTP 403|超时|timeout|ECONN/i.test(searchLastReason)) {
    return {
      status: HEALTH.UNCERTAIN,
      reason: `有内容但搜索探活判不准（${searchLastReason}）`,
      items: contentItems,
      sampleTitle,
      ttfb,
    };
  }
  return {
    status: HEALTH.NO_SEARCH,
    reason: `有内容 ${contentItems} 条，但搜索无结果（${searchLastReason || "未命中"}）——按策略剔除`,
    items: contentItems,
    classes: classCount,
    sampleTitle,
    ttfb,
  };
}

/**
 * JS / Py 站体检：规则文件本身 + 规则里的目标站。
 *
 *   - Py：必须有 `class Spider` 与 home/search 方法（lib 文件不算站点）
 *   - JS：必须能看出规则对象（`rule` / `host` / `url`），drpy 的 ext 规则也要像规则
 *   - 规则里写到目标站的，目标站全死 → 不可用
 */
export async function deepCheckScript(site, category, opts = {}, caches = {}) {
  const timeoutMs = num(opts.timeoutMs, 9000);
  const api = cleanResourceUrl(site?.api);
  const extUrl = typeof site?.ext === "string" ? cleanResourceUrl(site.ext) : "";
  const fetchText = async (url) => {
    if (!url) return "";
    const cached = caches.text?.get(url);
    if (cached) return cached;
    const r = await httpGet(url, { timeoutMs, maxBytes: 512 * 1024 });
    const text = r.ok ? r.body.toString("utf8") : "";
    if (text) caches.text?.set(url, text);
    if (!text) throw Object.assign(new Error(r.error || `HTTP ${r.status}`), { uncertain: isUncertainStatus(r) });
    return text;
  };

  let ruleText = "";
  try {
    ruleText = await fetchText(extUrl || api);
  } catch (e) {
    return e.uncertain
      ? { status: HEALTH.UNCERTAIN, reason: `规则文件取不到：${e.message}（判不准，保留）` }
      : { status: HEALTH.ERROR, reason: `规则文件取不到：${e.message}` };
  }

  if (category === "py") {
    const hasSpider = /class\s+Spider\s*[(:]/.test(ruleText);
    const hasHome = /\bdef\s+(homeContent|home|init|searchContent|search)\s*\(/.test(ruleText);
    if (!hasSpider || !hasHome) {
      return {
        status: HEALTH.NO_RULE,
        reason: !hasSpider ? "py 文件里没有 class Spider（不是 TVBox 爬虫）" : "py 爬虫缺 homeContent/searchContent 方法",
      };
    }
  } else {
    // JS：drpy2 的 api 是通用库，ext 才是规则；ext 为空时 api 自身必须是规则
    const looksRule = /\brule\s*[:=]|\bhost\s*[:=]|"?(主页url|分类url|siteUrl)"?\s*:|module\.exports|function\s+\w*\s*\(/.test(
      ruleText,
    );
    if (!looksRule) {
      return { status: HEALTH.NO_RULE, reason: "JS 内容不像 drpy/TVBox 规则（没有 rule/host/函数定义）" };
    }
    // ext 是 9 类对象时无法直接取文本，交给目标站/资源逻辑
    const extObjText = typeof site?.ext === "object" && site.ext ? JSON.stringify(site.ext) : "";
    if (extObjText) ruleText += "\n" + extObjText;
  }

  // 规则里如果引用了别的规则文件（`json` / `url` 指向 json），一并拉下来看
  for (const sub of extractExtResourceUrls(site?.ext).slice(0, 2)) {
    try {
      ruleText += "\n" + (await fetchText(sub));
    } catch {
      /* 子规则拉不到不算致命：主规则已经验过 */
    }
  }

  const targets = extractRuleTargets(ruleText);
  const judged = await judgeTargets(targets, caches.host, { ...opts, maxTargets: 3 });
  if (judged.verdict === "alive") {
    return { status: HEALTH.OK_CONTENT, reason: `规则里的目标站可用（${judged.alive[0].origin}）`, targets: judged };
  }
  if (judged.verdict === "dead") {
    return { status: HEALTH.NO_TARGET, reason: `规则里的目标站全部不可达：${judged.detail}` };
  }
  if (judged.verdict === "uncertain") {
    return { status: HEALTH.UNCERTAIN, reason: `目标站探活判不准（${judged.detail}），保留` };
  }
  // JS 站连一个目标站都抽不到：说明规则不是 drpy/XBPQ 那种「按站抓」的结构，
  // 单文件规则（`<script>xxx</script>` 内联、纯搜索型）在 TVBox 里能不能用完全看实现，
  // 我们判不了 —— 按「判不准」处理：不删，但不进精选档（避免占掉快站名额）。
  return { status: HEALTH.UNCERTAIN, reason: "规则里抽不到目标站地址，无法确认是否可用（保留，不进精选）" };
}

/**
 * Jar 爬虫站体检：类是否在包里 + 规则里的目标站是否活着。
 *
 * 需要的上下文：
 *   ctx.jarCache  Map<jarUrl, {ok, classes:Set, hasQuickJs, reason}>
 *   ctx.fallbackJar  站点没写 jar 时用的顶层 spider
 */
export async function deepCheckSpider(site, opts = {}, ctx = {}, caches = {}) {
  const timeoutMs = num(opts.jarTimeoutMs, 20000);
  const api = String(site?.api || "");
  const className = spiderClassOf(api);
  // 产物里这个站最终会用哪个 jar（自己的 → 补的 QuickJS jar → 顶层 spider），
  // 由调用方注入，保证「查的是真会加载的那个包」。
  const jarUrl = cleanResourceUrl(
    typeof ctx.effectiveJar === "function"
      ? ctx.effectiveJar(site)
      : site?.jar || ctx.fallbackJar || "",
  );
  const needsExt = NEEDS_EXT_CLASSES.has(className);

  let jarInfo = null;
  if (/^https?:\/\//i.test(jarUrl)) {
    const key = normUrl(jarUrl);
    jarInfo = ctx.jarCache?.get(key);
    if (!jarInfo) {
      const r = await httpGet(jarUrl, { timeoutMs, maxBytes: num(opts.jarMaxBytes, 20 * 1024 * 1024) });
      if (!r.ok || !(r.body[0] === 0x50 && r.body[1] === 0x4b)) {
        jarInfo = { ok: false, classes: new Set(), reason: r.error || `HTTP ${r.status}`, uncertain: isUncertainStatus(r) };
      } else {
        const entries = readZipEntries(r.body);
        const dexList = [...entries.entries()].filter(([n]) => /\.dex$/i.test(n)).map(([, b]) => b);
        if (!dexList.length) {
          // FongMi 支持 jar 里放 assets 里的 js；没有 dex 也不能直接判死
          jarInfo = { ok: false, classes: new Set(), noDex: true, reason: "jar 里没有 classes.dex" };
        } else {
          const info = inspectDexEntries(dexList);
          jarInfo = { ok: true, ...info, reason: "ok" };
        }
      }
      ctx.jarCache?.set(key, jarInfo);
    }
    if (jarInfo && !jarInfo.ok && jarInfo.uncertain) {
      return { status: HEALTH.UNCERTAIN, reason: `jar 取不到：${jarInfo.reason}（判不准，保留）` };
    }
    if (jarInfo && !jarInfo.ok && !jarInfo.noDex) {
      return { status: HEALTH.NO_CLASS, reason: `jar 无效：${jarInfo.reason}` };
    }
  }

  // ① 类必须真的在包里（否则 TVBox 一加载就是 ClassNotFoundException，
  //    站点列表里看得见、点开全报错 —— 这正是旧流程漏掉的最大一类「不可用」）
  if (jarInfo?.ok && className && isJarClassApi(api) && opts.deepJarClass !== false) {
    if (!jarInfo.classes.size) {
      // 扫不到任何 catvod 爬虫类：可能是混淆/非常规包结构，判不准就保留
      return { status: HEALTH.UNCERTAIN, reason: "jar 里没扫到 com.github.catvod.spider 类，无法确认（保留）" };
    }
    if (!jarHasClass(jarInfo.classes, className)) {
      // 先看别的 jar 能不能补（上层传进来的「带这个类的 jar」）
      const better = typeof ctx.findJarWithClass === "function" ? await ctx.findJarWithClass(className) : "";
      if (better) {
        return {
          status: HEALTH.OK_UNKNOWN,
          reason: `原 jar 里没有 ${className}，已换成带这个类的 jar：${better}`,
          repairable: true,
        };
      }
      return {
        status: HEALTH.NO_CLASS,
        reason: `jar 里没有 ${className} 这个类（包里共 ${jarInfo.classes.size} 个爬虫类：${[...jarInfo.classes].slice(0, 8).join("/")}…）`,
      };
    }
  }

  // ② 规则型爬虫必须以 ext 为规则：空 ext 就是「补 ext 才可能可用」
  const extEmpty = isEmptyExt(site?.ext);
  if (extEmpty && needsExt) {
    return { status: HEALTH.NEEDS_EXT, reason: `${className} 必须有 ext 规则才能工作，但 ext 为空` };
  }
  if (extEmpty) {
    return { status: HEALTH.OK_UNKNOWN, reason: `无需 ext（${className || "内置类"}），保留` };
  }

  // ③ 规则文件：ext 是 URL 就拉下来当规则；是对象就直接当规则
  let ruleText = "";
  if (typeof site.ext === "string" && /^https?:\/\//i.test(cleanResourceUrl(site.ext))) {
    const url = cleanResourceUrl(site.ext);
    ruleText = caches.text?.get(url) || "";
    if (!ruleText) {
      let r = null;
      try {
        r = await httpGet(url, { timeoutMs: num(opts.timeoutMs, 9000), maxBytes: 512 * 1024 });
      } catch {
        r = null;
      }
      if (r?.ok) {
        ruleText = r.body.toString("utf8");
        if (ruleText) caches.text?.set(url, ruleText);
      } else if (r && isUncertainStatus(r)) {
        // 限流 / 403 / 429 / 5xx / 超时：判不准，保留
        return { status: HEALTH.UNCERTAIN, reason: `ext 规则文件取不到（${r.error || `HTTP ${r.status}`}），判不准、保留` };
      } else if (r) {
        // 明确的 4xx / 空内容：规则文件已经不存在了，这个站必然点开报错。
        // 以前这里会退回「抽不到目标站 → ok-unknown」把它留下，等于永远剔不掉。
        return {
          status: HEALTH.NO_RULE,
          reason: `ext 规则文件已失效（${r.error || `HTTP ${r.status}`}）：${url}`,
        };
      }
      // r === null（连接层异常且没拿到任何响应）：无法区分是跑测机的问题还是站点问题，判不准
      if (!r) return { status: HEALTH.UNCERTAIN, reason: "ext 规则文件请求异常（未拿到响应），判不准、保留" };
    }
  } else if (typeof site.ext === "object") {
    ruleText = JSON.stringify(site.ext);
  }

  if (ruleText) {
    // 规则文件必须至少是 JSON 或能看出规则结构，否则 XBPQ 解析不了
    let ruleOk = false;
    try {
      const j = parseLooseJson(ruleText.trim());
      ruleOk = !!j && typeof j === "object";
    } catch {
      ruleOk = /\b(rule|host|url|site)\s*[:=]/i.test(ruleText);
    }
    if (!ruleOk) {
      return { status: HEALTH.NO_RULE, reason: `ext 规则无效（${trimmed(ruleText, 40) || "空内容"}）` };
    }
  }

  // ④ 目标站：多个里有一个活着就算可用
  const extra = [];
  for (const sub of extractExtResourceUrls(site.ext).slice(0, 2)) {
    const cached = caches.text?.get(sub);
    if (cached) {
      extra.push(cached);
      continue;
    }
    try {
      const r = await httpGet(sub, { timeoutMs: num(opts.timeoutMs, 9000), maxBytes: 512 * 1024 });
      if (r.ok) {
        const t = r.body.toString("utf8");
        caches.text?.set(sub, t);
        extra.push(t);
      }
    } catch {
      /* 忽略：单个子规则拉不到不影响判定 */
    }
  }
  const targets = extractRuleTargets([ruleText, ...extra].join("\n"));
  const judged = await judgeTargets(targets, caches.host, { ...opts, maxTargets: 3 });
  if (judged.verdict === "alive") {
    return { status: HEALTH.OK_CONTENT, reason: `规则目标站可用（${judged.alive[0].origin}）${className ? ` 类 ${className} 在包里` : ""}` };
  }
  if (judged.verdict === "dead") {
    return { status: HEALTH.NO_TARGET, reason: `规则里的目标站全部不可达：${judged.detail}` };
  }
  if (judged.verdict === "uncertain") {
    return { status: HEALTH.UNCERTAIN, reason: `目标站探活判不准（${judged.detail}），保留` };
  }
  return { status: HEALTH.OK_UNKNOWN, reason: "规则里没有可探的目标站地址，按可用保留" };
}

/* ============================ 批量入口 ============================ */

/**
 * 对「探活已经通过的站点」再做一轮能力体检，并就地改写 grade。
 *
 * 只会让站点从「可用」变成「不可用」，不会凭空复活死站：
 *   - 判死（DEAD_HEALTH）→ grade=dead，写进剔除报告并带 health 状态
 *   - 判不准（uncertain）→ 保持原档位但记 uncertain，绝不剔除
 *   - 通过 → 用体检拿到的条目数/样本标题更新 probe（内容指纹去重会用）
 *
 * 注意：本函数不负责挑站点，调用方按「哪些类型值得深检」传进来即可
 * （见 pipeline 里 deepCheckTargets()，默认只深检采集站 / JS / Jar 三类）。
 */
export async function runDeepCheck(entries, opts, ctx = {}) {
  const stats = {
    checked: 0,
    skippedBudget: 0,
    byStatus: {},
    removed: 0,
    uncertain: 0,
    samples: 0,
  };
  const caches = { text: ctx.textCache || new Map(), host: ctx.hostCache || new Map() };
  const jarCache = ctx.jarCache || new Map();
  const phaseStart = Date.now();
  const budgetMs = num(opts.budgetDeepCheck, 600) * 1000;

  await pool(entries, num(opts.concurrencyDeep, 16), async (e) => {
    if (Date.now() - phaseStart > budgetMs) {
      stats.skippedBudget++;
      return;
    }
    let res;
    try {
      if (e.category === "cj") {
        res = await deepCheckCms(e.site, opts);
      } else if (e.category === "py" || e.category === "js") {
        res = await deepCheckScript(e.site, e.category, opts, caches);
      } else if (e.category === "spider") {
        res = await deepCheckSpider(
          e.site,
          opts,
          { jarCache, fallbackJar: ctx.fallbackJar, effectiveJar: ctx.effectiveJar, findJarWithClass: ctx.findJarWithClass },
          caches,
        );
      } else {
        res = { status: HEALTH.OK_UNKNOWN, reason: "其它类型：无可执行的体检手段" };
      }
    } catch (err) {
      res = { status: HEALTH.ERROR, reason: `体检异常：${err?.message || err}` };
    }

    const status = res.status || HEALTH.OK_UNKNOWN;
    stats.checked++;
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    e.health = status;
    e.healthReason = res.reason || "";

    if (status === HEALTH.UNCERTAIN) {
      stats.uncertain++;
      e.uncertainDeep = true;
      // 用户策略：宁可误杀。deepKillUncertain 默认跟随 deepStrict（strict=剔，loose=保留）
      const killUncertain =
        opts.deepKillUncertain != null
          ? !!opts.deepKillUncertain
          : opts.deepStrict !== false;
      if (killUncertain) {
        e.grade = "dead";
        e.probe = {
          ...(e.probe || {}),
          alive: false,
          grade: "dead",
          reason: `深度检测·判不准（严格剔除）：${res.reason}`,
        };
        stats.removed++;
        ctx.stats?.removed.push({
          kind: "site",
          name: e.site.name,
          api: e.site.api,
          category: e.category,
          health: status,
          reason: `深度检测·判不准（严格剔除）：${res.reason}`,
        });
        if (ctx.stats) {
          ctx.stats.dropped.deep = (ctx.stats.dropped.deep || 0) + 1;
          ctx.stats.deepRemovedByStatus = ctx.stats.deepRemovedByStatus || {};
          ctx.stats.deepRemovedByStatus[status] = (ctx.stats.deepRemovedByStatus[status] || 0) + 1;
        }
        return;
      }
      // loose：降级为 uncertain 档（不进精选，但保留）
      if (e.grade === "fast") e.grade = "uncertain";
      return;
    }
    if (DEAD_HEALTH.has(status)) {
      if (opts.deepStrict === false && (status === HEALTH.NO_TARGET || status === HEALTH.ERROR || status === HEALTH.OK_CLASSES)) {
        // loose 模式：只剔「硬证据」类（缺 ext / 类不存在 / 空壳 / 规则无效 / 搜索无结果）
        e.uncertainDeep = true;
        return;
      }
      e.grade = "dead";
      e.probe = { ...(e.probe || {}), alive: false, grade: "dead", reason: `深度检测·${HEALTH_LABEL[status] || status}：${res.reason}` };
      stats.removed++;
      ctx.stats?.removed.push({
        kind: "site",
        name: e.site.name,
        api: e.site.api,
        category: e.category,
        health: status,
        reason: `深度检测·${HEALTH_LABEL[status] || status}：${res.reason}`,
      });
      if (ctx.stats) {
        ctx.stats.dropped.deep = (ctx.stats.dropped.deep || 0) + 1;
        ctx.stats.deepRemovedByStatus = ctx.stats.deepRemovedByStatus || {};
        ctx.stats.deepRemovedByStatus[status] = (ctx.stats.deepRemovedByStatus[status] || 0) + 1;
      }
      return;
    }

    // jar 里缺这个类，但别处有 → 换 jar 就地修好（比整站删掉划算得多）
    if (res.repairable && typeof ctx.repairJar === "function") {
      const jar = await ctx.repairJar(e.site);
      if (jar) {
        e.jarRepaired = jar;
        stats.repaired = (stats.repaired || 0) + 1;
        ctx.stats && (ctx.stats.jarRepaired = (ctx.stats.jarRepaired || 0) + 1);
      }
    }

    // 通过：把体检拿到的样本喂给内容指纹去重
    if (res.sampleTitle || res.items) {
      stats.samples++;
      e.probe = {
        ...(e.probe || {}),
        probe: `${e.probe?.probe || e.category}-deep`,
        sampleTitle: res.sampleTitle || e.probe?.sampleTitle || "",
        classes: res.classNames || e.probe?.classes || "",
        deepItems: res.items ?? e.probe?.deepItems ?? 0,
      };
    }
  });

  return stats;
}

/** 极简并发池（不引 core.pool，避免 deepcheck 反向依赖 pipeline） */
async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch {
        /* 单项异常不影响整体 */
      }
    }
  });
  await Promise.all(workers);
}
