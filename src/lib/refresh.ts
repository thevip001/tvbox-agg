import crypto from "node:crypto";
import { asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { artifacts, jobs, liveSources, sources, vodSites } from "@/db/schema";
import { SEED_SOURCES } from "./seed-sources";
import {
  type AnyObj,
  type Channel,
  type NormalizedConfig,
  fetchTvboxConfig,
  httpGet,
  liveDedupKey,
  normUrl,
  parsePlaylist,
  pool,
  siteCategory,
  siteDedupKey,
} from "./tvbox";

/** 随机抽 n 条（Fisher–Yates 洗牌后取前 n），不改动原数组 */
function pickSample<T>(arr: T[], n: number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

/* ---------------- 接口配置文本（apilinks.txt 格式） ---------------- */

/** 直播频道抽查失败是否为「确定死」。与 scripts/pipeline.mjs 的 classifyChannelFailure 同口径：
 *  无 IPv6/无路由（ENETUNREACH/EHOSTUNREACH…）、AggregateError、非 HTTP 应答（RTSP 等）
 *  属跑测环境限制＝测不准，不算源死；其余（HTTP 4xx/5xx、超时、空内容、拒连）算确定死。 */
function isCertainChannelFailure(reason: string): boolean {
  const s = String(reason || "");
  if (/EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENONET|EAFNOSUPPORT|EADDRNOTAVAIL/i.test(s)) return false;
  if (/AggregateError/i.test(s)) return false;
  if (/Parse Error: Expected HTTP/i.test(s)) return false;
  return true;
}

export function parseSourceText(text: string): { name: string; urls: string[] }[] {
  const map = new Map<string, string[]>();
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
        /* keep */
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

export function sourcesToText(rows: { name: string; urls: string[] }[]): string {
  return rows.map((r) => [r.name, ...r.urls].join(", ")).join("\n");
}

export async function ensureSeeded() {
  const [{ c }] = await db.select({ c: count() }).from(sources);
  if (c > 0) return;
  const list = parseSourceText(SEED_SOURCES);
  if (!list.length) return;
  await db
    .insert(sources)
    .values(list.map((s, i) => ({ name: s.name, urls: s.urls, sortOrder: i })))
    .onConflictDoNothing();
}

export async function saveSourceText(text: string) {
  const list = parseSourceText(text);
  const existing = await db.select({ id: sources.id, name: sources.name }).from(sources);
  const keep = new Set(list.map((s) => s.name));
  await db.transaction(async (tx) => {
    for (const e of existing) if (!keep.has(e.name)) await tx.delete(sources).where(eq(sources.id, e.id));
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      await tx
        .insert(sources)
        .values({ name: s.name, urls: s.urls, sortOrder: i })
        .onConflictDoUpdate({ target: sources.name, set: { urls: s.urls, sortOrder: i } });
    }
  });
  return list.length;
}

/* ---------------- 任务状态 ---------------- */

type G = typeof globalThis & { __tvboxRefresh?: { running: boolean; jobId: number | null } };
const g = globalThis as G;
g.__tvboxRefresh ??= { running: false, jobId: null };
export const refreshState = g.__tvboxRefresh;

export async function upsertArtifact(key: string, content: string) {
  await db
    .insert(artifacts)
    .values({ key, content, updatedAt: new Date() })
    .onConflictDoUpdate({ target: artifacts.key, set: { content, updatedAt: new Date() } });
}

export async function startRefresh(trigger = "manual"): Promise<number | null> {
  if (refreshState.running) return refreshState.jobId;
  refreshState.running = true;
  await ensureSeeded();
  const [job] = await db.insert(jobs).values({ trigger, status: "running" }).returning({ id: jobs.id });
  refreshState.jobId = job.id;
  void runRefresh(job.id)
    .catch(async (e) => {
      await db
        .update(jobs)
        .set({ status: "error", finishedAt: new Date(), log: sql`${jobs.log} || ${"\n❌ " + String((e as Error)?.stack || e)}` })
        .where(eq(jobs.id, job.id));
    })
    .finally(() => {
      refreshState.running = false;
    });
  return job.id;
}

async function runRefresh(jobId: number) {
  const lines: string[] = [];
  let lastFlush = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - lastFlush < 2000) return;
    lastFlush = Date.now();
    await db.update(jobs).set({ log: lines.join("\n") }).where(eq(jobs.id, jobId));
  };
  const log = async (msg: string) => {
    lines.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}] ${msg}`);
    await flush();
  };

  /* ---- 1. 抓取所有点播接口 ---- */
  const srcRows = await db.select().from(sources).where(eq(sources.enabled, true)).orderBy(asc(sources.sortOrder), asc(sources.id));
  await log(`开始抓取 ${srcRows.length} 个点播接口（每个接口按镜像顺序自动选通）`);
  let okCount = 0;
  await pool(srcRows, 6, async (src) => {
    let lastErr = "无可用 URL";
    for (const url of src.urls) {
      const r = await fetchTvboxConfig(url);
      if (r.config) {
        okCount++;
        await db
          .update(sources)
          .set({
            status: "ok",
            usedUrl: url,
            error: null,
            sizeBytes: r.size,
            siteCount: r.config.sites.length,
            liveCount: r.config.lives.length,
            parseCount: r.config.parses.length,
            config: r.config,
            fetchedAt: new Date(),
            okAt: new Date(),
          })
          .where(eq(sources.id, src.id));
        await log(`✅ ${src.name} ← ${url}  站点 ${r.config.sites.length} / 直播 ${r.config.lives.length}`);
        return;
      }
      lastErr = `${url}: ${r.error}`;
    }
    await db
      .update(sources)
      .set({ status: src.config ? "stale" : "fail", error: lastErr, fetchedAt: new Date() })
      .where(eq(sources.id, src.id));
    await log(`⚠️ ${src.name} 全部镜像失败${src.config ? "（沿用上次备份）" : ""}：${lastErr}`);
  });
  await log(`接口抓取完成：成功 ${okCount} / ${srcRows.length}`);

  /* ---- 2. 汇总 & 去重 ---- */
  const all = await db.select().from(sources).where(eq(sources.enabled, true)).orderBy(asc(sources.sortOrder), asc(sources.id));
  const siteMap = new Map<string, { site: AnyObj; sources: string[]; category: string; order: number }>();
  const liveMap = new Map<string, { live: AnyObj; sources: string[]; order: number }>();
  const parseMap = new Map<string, AnyObj>();
  const flagSet = new Set<string>();
  const spiderCount = new Map<string, number>();
  let rawSites = 0;
  let rawLives = 0;
  let rawParses = 0;
  let wallpaper: string | undefined;

  for (const s of all) {
    const cfg = s.config as NormalizedConfig | null;
    if (!cfg) continue;
    wallpaper ??= cfg.wallpaper;
    for (const site of cfg.sites || []) {
      rawSites++;
      const k = siteDedupKey(site);
      const hit = siteMap.get(k);
      if (hit) {
        if (!hit.sources.includes(s.name)) hit.sources.push(s.name);
      } else {
        siteMap.set(k, { site, sources: [s.name], category: siteCategory(site), order: siteMap.size });
        if (site.jar) spiderCount.set(String(site.jar), (spiderCount.get(String(site.jar)) ?? 0) + 1);
      }
    }
    for (const live of cfg.lives || []) {
      const url = String(live.url || "");
      if (!/^https?:\/\//i.test(url)) continue;
      rawLives++;
      const k = liveDedupKey(url);
      const hit = liveMap.get(k);
      if (hit) {
        if (!hit.sources.includes(s.name)) hit.sources.push(s.name);
      } else liveMap.set(k, { live, sources: [s.name], order: liveMap.size });
    }
    for (const p of cfg.parses || []) {
      rawParses++;
      const k = normUrl(String(p.url));
      if (k && !parseMap.has(k)) parseMap.set(k, p);
    }
    for (const f of cfg.flags || []) flagSet.add(f);
  }
  await log(`点播站点去重：${rawSites} → ${siteMap.size}；直播源去重（URL）：${rawLives} → ${liveMap.size}；解析去重：${rawParses} → ${parseMap.size}`);

  /* ---- 3. 采集站可用性检测 ---- */
  const siteEntries = [...siteMap.entries()];
  const cj = siteEntries.filter(([, v]) => v.category === "cj");
  await log(`检测 ${cj.length} 个采集站（type 0/1）可用性…`);
  const aliveMap = new Map<string, { alive: boolean; ms: number }>();
  await pool(cj, 16, async ([k, v]) => {
    const api = String(v.site.api);
    const url = api + (api.includes("?") ? "&" : "?") + "ac=list";
    const r = await httpGet(url, { timeoutMs: 8000, maxBytes: 512 * 1024, ua: "Mozilla/5.0" });
    const body = r.body.toString("utf8");
    const alive = r.ok && body.length > 20 && /(class|list|vod|<rss|"code")/i.test(body);
    aliveMap.set(k, { alive, ms: r.ms });
  });
  const cjAlive = [...aliveMap.values()].filter((v) => v.alive).length;
  await log(`采集站可用：${cjAlive} / ${cj.length}`);

  /* ---- 4. 直播源下载 + 内容级去重 + 频道抽查（只剔不合，不做频道合并） ---- */
  const liveEntries = [...liveMap.entries()];
  await log(`下载 ${liveEntries.length} 个直播源（套壳最多穿透 5 层），内容级去重后逐源抽查频道…`);
  const liveInfo = new Map<string, { alive: boolean; channels: Channel[]; size: number; hash: string | null }>();
  await pool(liveEntries, 6, async ([k, v]) => {
    let url = String(v.live.url);
    const ua = typeof v.live.ua === "string" && v.live.ua ? v.live.ua : undefined;
    let channels: Channel[] = [];
    let size = 0;
    let ok = false;
    for (let depth = 0; depth < 5; depth++) {
      const r = await httpGet(url, { ua, timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 });
      if (!r.ok) break;
      const text = r.body.toString("utf8");
      size = r.body.length;
      channels = parsePlaylist(text);
      if (channels.length) {
        ok = true;
        break;
      }
      const t = text.trim();
      if (/^https?:\/\/\S+$/.test(t) && t !== url) {
        url = t;
        continue;
      }
      break;
    }
    let hash: string | null = null;
    if (channels.length) {
      const uniq = [...new Set(channels.map((c) => normUrl(c.url)))].sort();
      hash = crypto.createHash("sha1").update(uniq.join("\n")).digest("hex");
    }
    liveInfo.set(k, { alive: ok, channels, size, hash });
  });

  const hashOwner = new Map<string, string>();
  const dupOf = new Map<string, string>();
  const keptLive: [string, { live: AnyObj; sources: string[]; order: number }][] = [];
  for (const [k, v] of liveEntries) {
    const info = liveInfo.get(k);
    if (!info?.alive) continue;
    if (info.hash) {
      const owner = hashOwner.get(info.hash);
      if (owner) {
        dupOf.set(k, owner);
        continue;
      }
      hashOwner.set(info.hash, String(v.live.name));
    }
    keptLive.push([k, v]);
  }

  /* 频道抽查：每源随机抽 N 个频道实测流地址，全失败就把整个源判死。
     与 scripts/pipeline.mjs 同一套口径（LIVE_PROBE_CHANNELS / LIVE_PROBE_TIMEOUT_MS）。 */
  const probeN = Math.max(1, Number(process.env.LIVE_PROBE_CHANNELS || 3));
  const probeTimeout = Number(process.env.LIVE_PROBE_TIMEOUT_MS || 6000);
  const probeFail = new Map<string, string>();
  await pool(keptLive, Number(process.env.LIVE_PROBE_WORKERS || 12), async ([k, v]) => {
    const channels = liveInfo.get(k)?.channels ?? [];
    if (!channels.length) return;
    const ua = typeof v.live.ua === "string" && v.live.ua ? v.live.ua : undefined;
    const sample = pickSample(channels, probeN);
    const results = await Promise.all(
      sample.map(async (ch) => {
        const r = await httpGet(ch.url, { ua, timeoutMs: probeTimeout, maxBytes: 64 * 1024 });
        if (!r.ok) {
          const reason = r.error || `HTTP ${r.status}`;
          return { name: ch.name, reason, certain: isCertainChannelFailure(reason) };
        }
        return r.body.length ? null : { name: ch.name, reason: "空内容", certain: true };
      }),
    );
    const fails = results.filter((x): x is { name: string; reason: string; certain: boolean } => x !== null);
    if (fails.length === sample.length && sample.length) {
      const detail = fails.map((f) => `${f.name}→${f.reason}`).join("；");
      // 与 scripts/pipeline.mjs 同口径：测不准不算失败，抽样全部「确定死」才剔源
      if (fails.every((f) => f.certain)) probeFail.set(k, `抽查 ${sample.length} 个频道全部失败且均确定死（${detail}）`);
      else await log(`⚠️ 直播源抽查全失败但属测不准（不算死、保留）${String(liveMap.get(k)?.live.name || k)}：${detail}`);
    }
  });
  for (const [k, reason] of probeFail) {
    const info = liveInfo.get(k);
    if (info) info.alive = false;
    await log(`❌ 直播源剔除 ${String(liveMap.get(k)?.live.name || k)}：${reason}`);
  }

  const liveAlive = keptLive.length - probeFail.size;
  await log(
    `直播源可用 ${liveAlive} / ${liveEntries.length}，内容完全相同的重复源 ${dupOf.size} 个，抽查全死剔除 ${probeFail.size} 个`,
  );

  /* ---- 5. 落库 ---- */
  const siteRows = siteEntries.map(([k, v]) => ({
    dedupKey: k,
    key: String(v.site.key),
    name: String(v.site.name ?? v.site.key),
    type: Number(v.site.type ?? 0),
    api: String(v.site.api),
    category: v.category,
    site: v.site,
    sources: v.sources,
    alive: aliveMap.has(k) ? aliveMap.get(k)!.alive : null,
    latencyMs: aliveMap.get(k)?.ms ?? null,
    sortOrder: v.order,
  }));
  const liveRows = liveEntries.map(([k, v]) => {
    const info = liveInfo.get(k);
    return {
      dedupKey: k,
      name: String(v.live.name || "直播"),
      url: String(v.live.url),
      live: v.live,
      sources: v.sources,
      alive: info?.alive ?? false,
      channelCount: info?.channels.length ?? 0,
      sizeBytes: info?.size ?? 0,
      contentHash: info?.hash ?? null,
      duplicateOf: dupOf.get(k) ?? null,
      sortOrder: v.order,
    };
  });
  const topSpider = [...spiderCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const stats = {
    sourcesTotal: all.length,
    sourcesOk: all.filter((s) => s.status === "ok").length,
    sourcesWithData: all.filter((s) => s.config).length,
    rawSites,
    dedupSites: siteMap.size,
    cjTotal: cj.length,
    cjAlive,
    rawLives,
    dedupLives: liveMap.size,
    liveAlive,
    liveContentDup: dupOf.size,
    liveProbeDropped: probeFail.size,
    rawParses,
    dedupParses: parseMap.size,
  };

  await db.transaction(async (tx) => {
    await tx.delete(vodSites);
    await tx.delete(liveSources);
    for (let i = 0; i < siteRows.length; i += 500) await tx.insert(vodSites).values(siteRows.slice(i, i + 500));
    for (let i = 0; i < liveRows.length; i += 500) await tx.insert(liveSources).values(liveRows.slice(i, i + 500));
  });
  await upsertArtifact(
    "vod_extras",
    JSON.stringify({ spider: topSpider, wallpaper, parses: [...parseMap.values()], flags: [...flagSet] }),
  );
  // 频道合并输出已于 2026-11-22 废弃（只剔不合），顺手清掉库里遗留的旧产物
  await db.delete(artifacts).where(inArray(artifacts.key, ["live_m3u", "live_txt"]));
  await upsertArtifact("stats", JSON.stringify(stats));

  await log(`🎉 完成：点播聚合 ${siteMap.size} 站，直播聚合 ${liveAlive} 源（只装源本身，不合并频道）`);
  await flush(true);
  await db.update(jobs).set({ status: "done", finishedAt: new Date(), stats }).where(eq(jobs.id, jobId));
}

export async function latestJob() {
  const [j] = await db.select().from(jobs).orderBy(desc(jobs.id)).limit(1);
  return j ?? null;
}
