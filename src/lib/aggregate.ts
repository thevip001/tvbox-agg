import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { artifacts, liveSources, vodSites } from "@/db/schema";
import type { AnyObj } from "./tvbox";

type CacheG = typeof globalThis & { __tvboxArtifactCache?: Map<string, { at: number; updatedAt: number; content: string | null }> };
const cg = globalThis as CacheG;
cg.__tvboxArtifactCache ??= new Map();
const cache = cg.__tvboxArtifactCache;

export async function getArtifact(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.content;
  if (hit) {
    // 只查更新时间，未变化则复用缓存
    const [meta] = await db.select({ u: artifacts.updatedAt }).from(artifacts).where(eq(artifacts.key, key)).limit(1);
    if (meta && meta.u.getTime() === hit.updatedAt) {
      hit.at = Date.now();
      return hit.content;
    }
  }
  const [row] = await db.select().from(artifacts).where(eq(artifacts.key, key)).limit(1);
  cache.set(key, { at: Date.now(), updatedAt: row?.updatedAt.getTime() ?? 0, content: row?.content ?? null });
  return row?.content ?? null;
}

function uniqueNamer() {
  const used = new Set<string>();
  return (base: string, tag?: string) => {
    let n = base;
    if (used.has(n) && tag) n = `${base}｜${tag}`;
    let i = 2;
    const root = n;
    while (used.has(n)) n = `${root}${i++}`;
    used.add(n);
    return n;
  };
}

export type VodCategory = "all" | "cj" | "py" | "js" | "spider";

export async function buildVodConfig(opts: { cat?: VodCategory; alive?: boolean; origin: string; withLive?: boolean }) {
  const rows = await db.select().from(vodSites).orderBy(asc(vodSites.sortOrder));
  const extras = JSON.parse((await getArtifact("vod_extras")) || "{}") as {
    spider?: string;
    wallpaper?: string;
    parses?: AnyObj[];
    flags?: string[];
  };
  const cat = opts.cat ?? "all";
  const keyOf = uniqueNamer();
  const nameOf = uniqueNamer();
  const sites: AnyObj[] = [];
  for (const r of rows) {
    if (cat !== "all" && r.category !== cat) continue;
    if (opts.alive && r.alive === false) continue;
    const s: AnyObj = { ...r.site };
    s.key = keyOf(String(s.key || r.key), r.sources[0]);
    s.name = nameOf(String(s.name || r.name), r.sources[0]);
    if (extras.spider && s.jar === extras.spider) delete s.jar;
    sites.push(s);
  }
  const parseName = uniqueNamer();
  const parses = (extras.parses ?? []).map((p) => ({ ...p, name: parseName(String(p.name || "解析")) }));
  const cfg: AnyObj = {
    spider: extras.spider ?? "",
    wallpaper: extras.wallpaper ?? "",
    sites,
    parses,
    flags: extras.flags ?? [],
  };
  if (opts.withLive) {
    // 直播不再产出合并播放列表：这里挂的是「只装源」的直播聚合配置
    cfg.lives = [{ name: "海量直播聚合(只含源)", type: 0, url: `${opts.origin}/live.json` }];
  }
  return cfg;
}

export async function buildLiveConfig(opts: { origin: string; all?: boolean }) {
  const rows = await db.select().from(liveSources).orderBy(asc(liveSources.sortOrder));
  const nameOf = uniqueNamer();
  // 只装「过了频道抽查的源」本身：2026-11-22 起不再置顶任何频道合并列表
  const lives: AnyObj[] = [];
  for (const r of rows) {
    if (!opts.all && (!r.alive || r.duplicateOf)) continue;
    const l: AnyObj = { ...r.live };
    l.name = nameOf(String(l.name || r.name), r.sources[0]);
    lives.push(l);
  }
  return { sites: [], lives };
}

export function originOf(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto")?.split(",")[0] || new URL(req.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};
