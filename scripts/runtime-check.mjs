#!/usr/bin/env node
/**
 * Isolated MisaTV-compatible runtime probe.
 *
 * Py: executes the vendored upstream CPython runner in a no-network Docker sandbox.
 * JS: executes MisaTV bootstrap on QuickJS with sandboxed host channels. JAR: executes MisaTV desktop SpiderHost.
 *
 * Usage:
 *   node scripts/runtime-check.mjs --kind py --source /path/to/site.py [--class Spider] [--ext URL_OR_JSON]
 *   node scripts/runtime-check.mjs --kind js --source /path/to/site.js [--api URL] [--ext JSON]\n   node scripts/runtime-check.mjs --kind jar --source /path/to/site.jar
 *
 * Output: one JSON object on stdout. Diagnostics go to stderr.
 */
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith("--")) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
  return a;
}, []));
const kind = String(args.kind || "").toLowerCase();
const result = (status, extra = {}) => {
  process.stdout.write(JSON.stringify({ id: randomUUID(), kind, status, runtime: "misa-compatible", ...extra }) + "\n");
};
const run = (cmd, argv, timeoutMs = 15000) => new Promise((resolveRun) => {
  const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false, settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGTERM"); // docker run forwards SIGTERM to the container
    const force = setTimeout(() => p.kill("SIGKILL"), 1500);
    force.unref?.();
  }, timeoutMs);
  const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolveRun(value); };
  p.stdout.on("data", b => { stdout += b; if (stdout.length > 2_000_000) p.kill("SIGKILL"); });
  p.stderr.on("data", b => { stderr += b; if (stderr.length > 64_000) stderr = stderr.slice(-64_000); });
  p.on("error", e => finish({ code: -1, stdout, stderr: stderr + e.message, timedOut }));
  p.on("close", code => finish({ code, stdout, stderr, timedOut }));
});
if (!["py", "js", "jar"].includes(kind)) {
  result("runtime-unsupported", { errorType: "invalid-kind", error: "kind must be py, js or jar" }); process.exit(0);
}
if (kind === "jar" && !args.source && args.fixture !== "true") {
  result("runtime-unsupported", { errorType: "missing-source", error: "--source is required for JAR runtime" }); process.exit(0);
}
if ((kind === "py" || kind === "js") && !args.source) {
  result("runtime-unsupported", { errorType: "missing-source", error: "--source is required for Py runtime" }); process.exit(0);
}
const source = args.source ? resolve(args.source) : null;
const image = kind === "jar" ? (process.env.MISA_JAR_IMAGE || "tvbox-agg/misa-jar:17") : kind === "js" ? (process.env.MISA_JS_IMAGE || "tvbox-agg/misa-js:quickjs") : (process.env.MISA_PY_IMAGE || "tvbox-agg/misa-py:3.11");
const temp = await mkdtemp(join(tmpdir(), "misa-py-"));
try {
  const code = source ? await readFile(source) : Buffer.alloc(0);
  if ((kind === "py" || kind === "js") && code.length > 2 * 1024 * 1024) {
    result("runtime-unsupported", { errorType: "source-too-large", error: "Script source exceeds 2 MiB safety limit" }); process.exit(0);
  }
  if (kind === "jar" && code.length > 32 * 1024 * 1024) {
    result("runtime-unsupported", { errorType: "source-too-large", error: "JAR exceeds 32 MiB safety limit" }); process.exit(0);
  }
  const ext = String(args.ext || "");
  if (Buffer.byteLength(ext, "utf8") > 128 * 1024) {
    result("runtime-unsupported", { errorType: "ext-too-large", error: "ext exceeds 128 KiB safety limit" }); process.exit(0);
  }
  const site = join(temp, kind === "jar" ? "site.jar" : kind === "js" ? "site.js" : "site.py");
  if (source) await writeFile(site, code, { mode: 0o444 });
  // Deliberately no network: arbitrary spider code must not reach LAN, metadata, or secrets.
  // Network-enabled production probes require a separately deployed egress-filtering proxy.
  const argv = [
    "run", "--rm", "--stop-timeout=1", "--network=none", "--read-only",
    "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=32",
    "--ulimit=nofile=64:64", "--ulimit=fsize=10485760:10485760",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=65532:65532", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
    ...(source ? ["--mount", `type=bind,src=${site},dst=${kind === "jar" ? "/work/site.jar" : kind === "js" ? "/work/site.js" : "/work/site.py"},readonly`] : []),
    image,
    ...(kind === "jar" ? [String(args.class || "com.github.catvod.spider.RuntimeFixture")] : kind === "js" ? ["/work/site.js", String(args.api || ""), ext] : ["/work/site.py", String(args.class || "Spider"), "homeContent", ext])
  ];
  const started = Date.now();
  const timeoutMs = Math.min(30000, Math.max(1000, Number(args.timeout || 15000)));
  const out = await run("docker", argv, timeoutMs);
  const durationMs = Date.now() - started;
  if (out.timedOut) {
    result("runtime-uncertain", { runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : "CPython 3.11", errorType: "timeout",
      error: `${kind.toUpperCase()} spider exceeded ${timeoutMs}ms sandbox limit`, durationMs });
    process.exit(0);
  }
  if (out.code !== 0) {
    const error = (out.stderr || out.stdout || `docker exited ${out.code}`).slice(-4000);
    const networkBlocked = /ConnectionError|ConnectTimeout|ReadTimeout|NameResolutionError|Temporary failure in name resolution|Network is unreachable|No route to host|Max retries exceeded|Connection refused/i.test(error);
    result(networkBlocked ? "runtime-uncertain" : "runtime-error", {
      runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : "CPython 3.11",
      errorType: networkBlocked ? "sandbox-network-disabled" : "spider-execution-failed",
      error, durationMs, network: { mode: "disabled", requests: "blocked" }
    });
    process.exit(0);
  }
  const raw = out.stdout.trim();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    result("runtime-error", { runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : "CPython 3.11", errorType: "invalid-spider-output",
      error: "MisaTV runner returned non-JSON output", output: raw.slice(0, 1000), durationMs });
    process.exit(0);
  }
  if (kind === "js" && data && typeof data.status === "string") {\n    const { status, ...details } = data;\n    result(status, { runtimeVersion: details.runtimeVersion || "QuickJS / MisaTV bootstrap", ...details, durationMs });\n    process.exit(0);\n  }\n  if (kind === "jar" && typeof data === "string") {
    try { data = JSON.parse(data); } catch {}
  }
  const hasContent = Array.isArray(data?.list) ? data.list.length > 0 :
    Array.isArray(data?.data) ? data.data.length > 0 :
    Array.isArray(data?.list?.data) ? data.list.data.length > 0 :
    Array.isArray(data?.class) ? data.class.length > 0 :
    Boolean(data && typeof data === "object" && Object.keys(data).length);
  result(hasContent ? "runtime-home" : "runtime-empty", {
    runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : kind === "js" ? "QuickJS / MisaTV bootstrap" : "CPython 3.11 / MisaTV runner",
    method: "homeContent", data, durationMs,
    network: { mode: "disabled", requests: 0 }
  });
} catch (error) {
  result("runtime-error", { errorType: "runner-error", error: String(error?.stack || error) });
} finally {
  await rm(temp, { recursive: true, force: true });
}
