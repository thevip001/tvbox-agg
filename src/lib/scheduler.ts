import { latestJob, startRefresh } from "./refresh";

const INTERVAL_MS = 12 * 60 * 60 * 1000; // 每 12 小时自动更新一次

type G = typeof globalThis & { __tvboxScheduler?: boolean };

async function tick(trigger: string) {
  try {
    const job = await latestJob();
    const last = job?.finishedAt ? new Date(job.finishedAt).getTime() : 0;
    const stuck = job?.status === "running" && Date.now() - new Date(job.startedAt).getTime() > 2 * 60 * 60 * 1000;
    if (!job || stuck || (job.status !== "running" && Date.now() - last > INTERVAL_MS - 60_000)) {
      await startRefresh(trigger);
    }
  } catch (e) {
    console.error("[tvbox scheduler]", (e as Error).message);
  }
}

export function startScheduler() {
  const g = globalThis as G;
  if (g.__tvboxScheduler || process.env.TVBOX_DISABLE_SCHEDULER === "1") return;
  g.__tvboxScheduler = true;
  setTimeout(() => void tick("startup"), 15_000);
  setInterval(() => void tick("schedule"), 30 * 60 * 1000);
}
