import { asc } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { ensureSeeded, saveSourceText, sourcesToText } from "@/lib/refresh";

export const dynamic = "force-dynamic";

/** 以 apilinks.txt 格式读取/保存接口列表 */
export async function GET() {
  await ensureSeeded();
  const rows = await db.select({ name: sources.name, urls: sources.urls }).from(sources).orderBy(asc(sources.sortOrder), asc(sources.id));
  return new Response(sourcesToText(rows), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  if (!body || typeof body.text !== "string") return Response.json({ error: "text 必填" }, { status: 400 });
  const n = await saveSourceText(body.text);
  return Response.json({ ok: true, count: n });
}
