import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { jsonHeaders } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

/** 单个接口的备份线路（相对路径已补全为绝对路径，可直接导入 TVBox） */
export async function GET(_req: Request, ctx: RouteContext<"/api/backup/[id]">) {
  const { id } = await ctx.params;
  const n = Number(id);
  if (!Number.isInteger(n)) return Response.json({ error: "invalid id" }, { status: 400 });
  const [row] = await db.select().from(sources).where(eq(sources.id, n)).limit(1);
  if (!row?.config) return Response.json({ error: "暂无备份" }, { status: 404 });
  const { subConfigs: _s, ...cfg } = row.config as Record<string, unknown>;
  void _s;
  return new Response(JSON.stringify(cfg), { headers: jsonHeaders });
}
