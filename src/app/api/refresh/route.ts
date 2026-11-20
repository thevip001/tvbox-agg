import { latestJob, refreshState, startRefresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET() {
  const job = await latestJob();
  return Response.json({ running: refreshState.running, job });
}

export async function POST() {
  const jobId = await startRefresh("manual");
  return Response.json({ ok: true, jobId, running: true });
}
