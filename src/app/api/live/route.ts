import { buildLiveConfig, jsonHeaders, originOf } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

/** 直播聚合接口（TVBox 配置格式）：/api/live?all=1 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const cfg = await buildLiveConfig({ origin: originOf(req), all: sp.get("all") === "1" });
  return new Response(JSON.stringify(cfg, null, sp.get("pretty") === "1" ? 2 : 0), { headers: jsonHeaders });
}
