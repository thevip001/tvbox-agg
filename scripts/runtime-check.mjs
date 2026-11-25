#!/usr/bin/env node
/**
 * Isolated MisaTV-compatible runtime probe.
 *
 * Py: executes the vendored upstream CPython runner in an isolated Docker network with filtered HTTP(S) egress.
 * JS: executes MisaTV bootstrap on QuickJS with filtered host-network bridge. JAR: executes MisaTV desktop SpiderHost through JVM proxy settings.
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
import { isIP } from "node:net";

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
if ((kind === "py" && !args.source && !args.archive) || (kind === "js" && !args.source)) {
  result("runtime-unsupported", { errorType: "missing-source", error: "--source is required for Py runtime" }); process.exit(0);
}
const source = args.source ? resolve(args.source) : args.archive ? resolve(args.archive) : null;
const image = kind === "jar" ? (process.env.MISA_JAR_IMAGE || "tvbox-agg/misa-jar:17") : kind === "js" ? (process.env.MISA_JS_IMAGE || "tvbox-agg/misa-js:quickjs") : (process.env.MISA_PY_IMAGE || "tvbox-agg/misa-py:3.11");
const temp = await mkdtemp(join(tmpdir(), "misa-py-"));
let network = null;
let gateway = null;
try {
  const code = source ? await readFile(source) : Buffer.alloc(0);
  if ((kind === "py" && !args.archive || kind === "js") && code.length > 2 * 1024 * 1024) {
    result("runtime-unsupported", { errorType: "source-too-large", error: "Script source exceeds 2 MiB safety limit" }); process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (kind === "py" && args.archive && code.length > 10 * 1024 * 1024) {
    result("runtime-unsupported", { errorType: "archive-too-large", error: "Py spider ZIP exceeds 10 MiB safety limit" }); process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (kind === "jar" && code.length > 32 * 1024 * 1024) {
    result("runtime-unsupported", { errorType: "source-too-large", error: "JAR exceeds 32 MiB safety limit" }); process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  const ext = String(args.ext || "");
  const requestedHosts = String(args["allow-hosts"] || "").split(/[\\s,;]+/).filter(Boolean);
  if (args.api) {
    try { requestedHosts.push(new URL(String(args.api)).hostname); } catch {}
  }
  const allowedHosts = [...new Set(requestedHosts.map(host => host.toLowerCase().replace(/\\.$/, "")))];
  const validDomain = host => host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
  const invalidHosts = allowedHosts.filter(host => {
    const value = host.startsWith("*.") ? host.slice(2) : host;
    return !(isIP(value) || validDomain(value));
  });
  if (invalidHosts.length) {
    result("runtime-unsupported", { errorType: "invalid-allowlist-host", error: "Invalid --allow-hosts entry", hosts: invalidHosts });
    process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (Buffer.byteLength(ext, "utf8") > 128 * 1024) {
    result("runtime-unsupported", { errorType: "ext-too-large", error: "ext exceeds 128 KiB safety limit" }); process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  const site = join(temp, kind === "jar" ? "site.jar" : kind === "js" ? "site.js" : "site.py");
  if (source) await writeFile(site, code, { mode: 0o444 });

  // Per-invocation internal network: only the gateway is attached to both this
  // isolated network and Docker's outbound bridge. Spider containers cannot
  // route directly to the Internet or LAN, even if they ignore proxy settings.
  network = `misa-job-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  gateway = `misa-egress-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const proxyScript = resolve("runtime/egress-proxy/proxy.py");
  const networkCreate = await run("docker", ["network", "create", "--internal", network], 15000);
  if (networkCreate.code !== 0) throw new Error(`cannot create isolated Docker network: ${networkCreate.stderr}`);
  const proxyStart = await run("docker", [
    "run", "-d", "--name", gateway, "--network", "bridge",
    "--read-only", "--tmpfs=/tmp:rw,noexec,nosuid,size=8m", "--cap-drop=ALL", "--pids-limit=64", "--memory=64m", "--memory-swap=64m", "--cpus=0.5", "--ulimit=nofile=128:128",
    "--security-opt=no-new-privileges", "--user=65532:65532",
    "--env=PYTHONDONTWRITEBYTECODE=1", `--env=MISA_ALLOWED_HOSTS=${allowedHosts.join(",")}`,
    "--mount", `type=bind,src=${proxyScript},dst=/proxy.py,readonly`,
    "python:3.11-alpine", "python", "/proxy.py"
  ], 30000);
  if (proxyStart.code !== 0) throw new Error(`cannot start egress gateway: ${proxyStart.stderr}`);
  const internalAttach = await run("docker", ["network", "connect", "--alias", "egress-proxy", network, gateway], 15000);
  if (internalAttach.code !== 0) throw new Error(`cannot attach egress gateway to isolated spider network: ${internalAttach.stderr}`);
  let gatewayReady = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = await run("docker", ["exec", gateway, "python", "-c",
      "import socket; s=socket.create_connection(('127.0.0.1',3128),1); s.close()"], 3000);
    if (probe.code === 0) { gatewayReady = true; break; }
    await new Promise(resolveReady => setTimeout(resolveReady, 250));
  }
  if (!gatewayReady) throw new Error("egress gateway did not become ready");

  const argv = [
    "run", "--rm", "--stop-timeout=1", `--network=${network}`, "--read-only",
    "--env=HTTP_PROXY=http://egress-proxy:3128", "--env=HTTPS_PROXY=http://egress-proxy:3128",
    "--env=ALL_PROXY=http://egress-proxy:3128", "--env=http_proxy=http://egress-proxy:3128",
    "--env=https_proxy=http://egress-proxy:3128", "--env=NO_PROXY=localhost,127.0.0.1,::1",
    "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=32",
    "--ulimit=nofile=64:64", "--ulimit=fsize=41943040:41943040",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=65532:65532", "--tmpfs=/tmp:rw,noexec,nosuid,size=48m",
    ...(source ? ["--mount", `type=bind,src=${site},dst=${kind === "jar" ? "/work/site.jar" : kind === "js" ? "/work/site.js" : args.archive ? "/work/archive.zip" : "/work/site.py"},readonly`] : []),
    image,
    ...(kind === "jar" ? [String(args.class || "com.github.catvod.spider.RuntimeFixture")] : kind === "js" ? ["/work/site.js", String(args.api || ""), ext] : args.archive ? ["--archive", "/work/archive.zip", String(args.entry || "0.py"), String(args.class || "Spider"), String(args.method || "homeContent"), ext] : ["/work/site.py", String(args.class || "Spider"), "homeContent", ext])
  ];
  const started = Date.now();
  const timeoutMs = Math.min(30000, Math.max(1000, Number(args.timeout || 15000)));
  const out = await run("docker", argv, timeoutMs);
  const gatewayLog = await run("docker", ["logs", gateway], 5000);
  const gatewayIssues = /egress-deny|egress-error/.test(gatewayLog.stdout + gatewayLog.stderr);
  const durationMs = Date.now() - started;
  if (out.timedOut) {
    result("runtime-uncertain", { runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : kind === "js" ? "QuickJS / MisaTV bootstrap" : "CPython 3.11", errorType: "timeout",
      error: `${kind.toUpperCase()} spider exceeded ${timeoutMs}ms sandbox limit`, durationMs });
    process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (out.code !== 0) {
    const error = (out.stderr || out.stdout || `docker exited ${out.code}`).slice(-4000);
    const networkBlocked = gatewayIssues || /ConnectionError|ConnectTimeout|ReadTimeout|NameResolutionError|Temporary failure in name resolution|Network is unreachable|No route to host|Max retries exceeded|Connection refused/i.test(error);
    result(networkBlocked ? "runtime-uncertain" : "runtime-error", {
      runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : kind === "js" ? "QuickJS / MisaTV bootstrap" : "CPython 3.11",
      errorType: networkBlocked ? "egress-proxy-or-upstream-failed" : "spider-execution-failed",
      error, durationMs, network: { mode: "filtered-proxy", allowlist: allowedHosts, requests: "attempted" }
    });
    process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  const raw = out.stdout.trim();
  let data;
  try { data = JSON.parse(raw); }
  catch {
    result("runtime-error", { runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : "CPython 3.11", errorType: "invalid-spider-output",
      error: "MisaTV runner returned non-JSON output", output: raw.slice(0, 1000), durationMs });
    process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (kind === "js" && data && typeof data.status === "string") {
    const { status, ...details } = data;
    if ((status === "runtime-empty" || status === "runtime-error") && gatewayIssues) {
      result("runtime-uncertain", { runtimeVersion: details.runtimeVersion || "QuickJS / MisaTV bootstrap",
        errorType: "egress-policy-or-upstream-failure", error: "The egress gateway rejected a destination or could not reach an upstream; empty data is not evidence that the source is dead.",
        ...details, durationMs, network: { mode: "filtered-proxy", allowlist: allowedHosts, gatewayIssues: true } });
    } else {
      result(status, { runtimeVersion: details.runtimeVersion || "QuickJS / MisaTV bootstrap", ...details, durationMs });
    }
    process.exitCode = 0; throw new Error('__MISA_STOP__');
  }
  if (kind === "jar" && typeof data === "string") {
    try { data = JSON.parse(data); } catch {}
  }
  const hasContent = Array.isArray(data?.list) ? data.list.length > 0 :
    Array.isArray(data?.data) ? data.data.length > 0 :
    Array.isArray(data?.list?.data) ? data.list.data.length > 0 :
    Array.isArray(data?.class) ? data.class.length > 0 :
    Boolean(data && typeof data === "object" && Object.keys(data).length);
  if (!hasContent && gatewayIssues) {
    result("runtime-uncertain", { runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : "CPython 3.11 / MisaTV runner",
      errorType: "egress-policy-or-upstream-failure", error: "The egress gateway rejected a destination or could not reach an upstream; empty data is not evidence that the source is dead.",
      method: "homeContent", data, durationMs, network: { mode: "filtered-proxy", gatewayIssues: true } });
  } else {
    result(hasContent ? "runtime-home" : "runtime-empty", {
      runtimeVersion: kind === "jar" ? "OpenJDK 17 / MisaTV SpiderHost" : kind === "js" ? "QuickJS / MisaTV bootstrap" : "CPython 3.11 / MisaTV runner",
      method: "homeContent", data, durationMs,
      network: { mode: "filtered-proxy", allowlist: allowedHosts, policy: "allowlisted hosts only; public IPs only; TCP 80/443" }
    });
  }
} catch (error) {
  if (error?.message !== "__MISA_STOP__") {
    result("runtime-error", { errorType: "runner-error", error: String(error?.stack || error) });
  }
} finally {
  if (gateway) await run("docker", ["rm", "-f", gateway], 10000);
  if (network) await run("docker", ["network", "rm", network], 10000);
  await rm(temp, { recursive: true, force: true });
}
