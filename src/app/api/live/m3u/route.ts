import { getArtifact } from "@/lib/aggregate";

export const dynamic = "force-dynamic";

/** 频道级去重合并后的 M3U 播放列表 */
export async function GET() {
  const body = (await getArtifact("live_m3u")) || "#EXTM3U\n";
  return new Response(body, {
    headers: {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
}
