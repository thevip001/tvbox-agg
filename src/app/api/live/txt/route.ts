import { getArtifact } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

/** 频道级去重合并后的 TXT（genre）播放列表 */
export async function GET() {
  const body = (await getArtifact("live_txt")) || "";
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
