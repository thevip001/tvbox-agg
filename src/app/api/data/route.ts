import { asc } from "drizzle-orm";
import { db } from "@/db";
import { liveSources, sources, vodSites } from "@/db/schema";
import { getArtifact } from "@/lib/aggregate";
import { ensureSeeded, latestJob, refreshState } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const [srcRows, siteRows, liveRows, statsRaw, job] = await Promise.all([
    db
      .select({
        id: sources.id,
        name: sources.name,
        urls: sources.urls,
        status: sources.status,
        usedUrl: sources.usedUrl,
        error: sources.error,
        sizeBytes: sources.sizeBytes,
        siteCount: sources.siteCount,
        liveCount: sources.liveCount,
        parseCount: sources.parseCount,
        fetchedAt: sources.fetchedAt,
        okAt: sources.okAt,
      })
      .from(sources)
      .orderBy(asc(sources.sortOrder), asc(sources.id)),
    db
      .select({
        id: vodSites.id,
        key: vodSites.key,
        name: vodSites.name,
        type: vodSites.type,
        api: vodSites.api,
        category: vodSites.category,
        sources: vodSites.sources,
        alive: vodSites.alive,
        latencyMs: vodSites.latencyMs,
      })
      .from(vodSites)
      .orderBy(asc(vodSites.sortOrder)),
    db
      .select({
        id: liveSources.id,
        name: liveSources.name,
        url: liveSources.url,
        live: liveSources.live,
        sources: liveSources.sources,
        alive: liveSources.alive,
        channelCount: liveSources.channelCount,
        sizeBytes: liveSources.sizeBytes,
        duplicateOf: liveSources.duplicateOf,
      })
      .from(liveSources)
      .orderBy(asc(liveSources.sortOrder)),
    getArtifact("stats"),
    latestJob(),
  ]);
  return Response.json({
    sources: srcRows,
    sites: siteRows,
    lives: liveRows.map(({ live, ...r }) => ({ ...r, ua: typeof live.ua === "string" ? live.ua : null })),
    stats: statsRaw ? JSON.parse(statsRaw) : null,
    running: refreshState.running,
    job: job ? { id: job.id, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt, trigger: job.trigger } : null,
  });
}
