import { buildVodConfig, jsonHeaders, originOf, type VodCategory } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

/** 点播聚合接口：/api/vod?cat=all|cj|py|js|spider&alive=1&live=1 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const catParam = sp.get("cat") || "all";
  const cat = (["all", "cj", "py", "js", "spider"].includes(catParam) ? catParam : "all") as VodCategory;
  const cfg = await buildVodConfig({
    cat,
    alive: sp.get("alive") === "1",
    withLive: sp.get("live") === "1",
    origin: originOf(req),
  });
  return new Response(JSON.stringify(cfg, null, sp.get("pretty") === "1" ? 2 : 0), { headers: jsonHeaders });
}
