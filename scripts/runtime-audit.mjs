#!/usr/bin/env node
/**
 * Non-destructive live runtime audit for the current aggregated TVBox output.
 * Only a small deterministic sample is executed. Results are report-only:
 * this script never edits the source lists or changes aggregation decisions.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

const ROOT = process.cwd();
const OUT = process.env.RUNTIME_AUDIT_OUT || "聚合接口/运行时体检.json";
const MAX_PER_TYPE = Math.max(0, Math.min(10, Number(process.env.RUNTIME_AUDIT_MAX_PER_TYPE || 2)));
const BUDGET_MS = Math.max(30_000, Number(process.env.RUNTIME_AUDIT_BUDGET_MS || 480_000));
const SITE_TIMEOUT = Math.max(5_000, Math.min(30_000, Number(process.env.RUNTIME_AUDIT_TIMEOUT_MS || 20_000)));
const started = Date.now();
const runId = randomUUID();

function ipv4Public(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
function ipv6Public(ip) {
  const s = ip.toLowerCase().split("%")[0];
  if (s === "::" || s === "::1" || s.startsWith("::ffff:") || s.startsWith("fc") ||
      s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") ||
      s.startsWith("fea") || s.startsWith("feb")) return false;
  // Global unicast only. Also exclude documentation, 6to4, Teredo and translation prefixes.
  if (!/^2[0-9a-f]{3}:/.test(s)) return false;
  if (s.startsWith("2001:db8:") || s.startsWith("2002:") ||
      s.startsWith("2001:0000:") || s.startsWith("64:ff9b:")) return false;
  return true;
}
function publicIp(ip) {
  const family = isIP(ip);
  return family === 4 ? ipv4Public(ip) : family === 6 ? ipv6Public(ip) : false;
}
async function pinnedRequest(urlText, redirects = 0, maxBytes = 2 * 1024 * 1024) {
  const url = new URL(urlText);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      ![80,443].includes(Number(url.port || (url.protocol === "https:" ? 443 : 80)))) {
    throw new Error("resource URL must be public HTTP(S) on port 80/443");
  }
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => !publicIp(a.address))) throw new Error("resource host resolves to a non-public IP");
  const chosen = answers[0];
  const transport = url.protocol === "https:" ? https : http;
  const response = await new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "GET", timeout: 12000,
      headers: { "user-agent": "tvbox-agg-runtime-audit/1.0", accept: "*/*" },
      lookup: (_host, _opts, cb) => cb(null, chosen.address, chosen.family),
      servername: url.hostname,
    }, res => {
      const chunks = [];
      let size = 0;
      res.on("data", b => {
        size += b.length;
        if (size > maxBytes) { req.destroy(new Error("resource exceeds size limit")); return; }
        chunks.push(b);
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("resource download timeout")));
    req.on("error", reject);
    req.end();
  });
  if ([301,302,303,307,308].includes(response.status) && response.headers.location) {
    if (redirects >= 4) throw new Error("too many resource redirects");
    return pinnedRequest(new URL(response.headers.location, url).href, redirects + 1, maxBytes);
  }
  if (response.status < 200 || response.status >= 300) throw new Error("resource HTTP " + response.status);
  return response.body;
}
function hostsIn(text) {
  const found = new Set();
  for (const m of String(text || "").matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi)) {
    const h = m[1].toLowerCase().replace(/\.$/, "");
    if (h && !/^\d+(?:\.\d+){3}$/.test(h)) found.add(h);
    else if (h) found.add(h);
  }
  return [...found];
}
function hostOf(value) {
  try { const u = new URL(String(value)); return ["http:","https:"].includes(u.protocol) ? u.hostname : ""; }
  catch { return ""; }
}
function spiderClass(api) {
  const value = String(api || "").trim();
  if (/^com\.github\.catvod\.spider\./.test(value)) return value;
  const m = /^csp_([A-Za-z0-9_$]+)/i.exec(value);
  return m ? "com.github.catvod.spider." + m[1] : "";
}
function safeKey(site) {
  return String(site?.key || site?.name || site?.api || "unknown").slice(0,160);
}
async function command(argv, timeoutMs) {
  return new Promise(resolve => {
    const p = spawn("node", ["scripts/runtime-check.mjs", ...argv], { cwd: ROOT, stdio: ["ignore","pipe","pipe"] });
    let stdout="", stderr="", done=false;
    const timer=setTimeout(()=>{p.kill("SIGKILL"); finish({code:-1,stdout,stderr:stderr+"runtime audit timeout"});},timeoutMs);
    const finish=v=>{if(done)return;done=true;clearTimeout(timer);resolve(v);};
    p.stdout.on("data",b=>{stdout+=b;if(stdout.length>2_000_000)p.kill("SIGKILL");});
    p.stderr.on("data",b=>{stderr+=b;if(stderr.length>32_000)stderr=stderr.slice(-32_000);});
    p.on("error",e=>finish({code:-1,stdout,stderr:stderr+e.message}));
    p.on("close",code=>finish({code,stdout,stderr}));
  });
}
function parseResult(out) {
  for (const line of out.split(/\r?\n/).reverse()) {
    try { const v=JSON.parse(line); if (v && typeof v.status==="string") return v; } catch {}
  }
  return null;
}
async function runOne(category, site, topSpider, temp) {
  const record = { category, key: safeKey(site), name: String(site?.name || "").slice(0,200), api: String(site?.api || "").slice(0,1000) };
  try {
    let sourceBytes, extText = "", api = String(site?.api || "");
    const hosts = new Set();
    const addHost = v => { const h=hostOf(v); if(h) hosts.add(h); };
    addHost(api); addHost(site?.ext); addHost(site?.jar); addHost(topSpider);
    if (category === "py") {
      if (!/^https?:\/\//i.test(api)) throw new Error("Py api is not a downloadable script URL");
      sourceBytes = await pinnedRequest(api,0,2*1024*1024);
      const sourceText=sourceBytes.toString("utf8");
      hostsIn(sourceText).forEach(h=>hosts.add(h));
      extText = site?.ext && typeof site.ext==="object" ? JSON.stringify(site.ext) : String(site?.ext || "");
      if (/^https?:\\/\\//i.test(extText)) extText=(await pinnedRequest(extText,0,512*1024)).toString("utf8");
      if (extText) hostsIn(extText).forEach(h=>hosts.add(h));
    } else if (category === "js") {
      if (typeof site?.ext === "string" && /^https?:\/\//i.test(site.ext)) {
        sourceBytes = await pinnedRequest(site.ext,0,2*1024*1024);
      } else if (site?.ext && typeof site.ext === "object") {
        sourceBytes = Buffer.from("var rule = " + JSON.stringify(site.ext) + ";");
      } else {
        throw new Error("JS site has no downloadable ext rule");
      }
      const sourceText=sourceBytes.toString("utf8");
      hostsIn(sourceText).forEach(h=>hosts.add(h));
      if (site?.api && /^https?:\/\//i.test(api)) hosts.add(hostOf(api));
      extText = site?.ext && typeof site.ext==="object" ? JSON.stringify(site.ext) : "";
    } else {
      const cls=spiderClass(api);
      if (!cls) throw new Error("JAR api class name is not recognized");
      const jarUrl=String(site?.jar || topSpider || "");
      if (!/^https?:\/\//i.test(jarUrl)) throw new Error("JAR URL is missing");
      sourceBytes = await pinnedRequest(jarUrl,0,20*1024*1024);
      if (site?.ext && typeof site.ext==="string" && /^https?:\/\//i.test(site.ext)) {
        extText = (await pinnedRequest(site.ext,0,512*1024)).toString("utf8");
        hostsIn(extText).forEach(h=>hosts.add(h));
      } else if (site?.ext && typeof site.ext==="object") extText=JSON.stringify(site.ext);
      hostsIn(extText).forEach(h=>hosts.add(h));
      record.className=cls;
    }
    if (!sourceBytes?.length) throw new Error("downloaded runtime payload is empty");
    if (hosts.size===0) throw new Error("cannot derive a safe outbound host allowlist");
    const ext=extname(category==="jar"?"site.jar":category==="js"?"site.js":"site.py");
    const file=join(temp,randomUUID()+ext);
    await writeFile(file,sourceBytes,{mode:0o600});
    const allow=[...hosts].filter(Boolean).join(",");
    const argv=["--kind",category,"--source",file,"--allow-hosts",allow,"--timeout",String(SITE_TIMEOUT)];
    if(category==="py") argv.push("--class","Spider","--ext",extText);
    if(category==="js") argv.push("--api",api,"--ext",extText);
    if(category==="jar") argv.push("--class",record.className,"--ext",extText);
    const out=await command(argv,SITE_TIMEOUT+20_000);
    const parsed=parseResult(out.stdout);
    record.status=parsed?.status || (out.code===0?"runtime-uncertain":"runtime-error");
    record.errorType=parsed?.errorType || "";
    record.reason=parsed?.error || (out.stderr || (!parsed?"runtime runner returned no JSON":"")).slice(-1600);
    record.runtimeVersion=parsed?.runtimeVersion || parsed?.runtime || "";
    record.durationMs=parsed?.durationMs || 0;
    record.network=parsed?.network || {mode:"filtered-proxy",allowlist:[...hosts]};
  } catch(error) {
    record.status="runtime-uncertain";
    record.errorType="audit-preparation-failed";
    record.reason=String(error?.message || error).slice(0,1600);
  }
  return record;
}
async function main() {
  const categories = [
    ["py","聚合接口/点播-Py站.json"],
    ["js","聚合接口/点播-JS站.json"],
    ["jar","聚合接口/点播-Jar爬虫站.json"],
  ];
  const report = {
    version:1, runId, generatedAt:new Date().toISOString(),
    policy:"report-only; no source is removed or downgraded by runtime audit",
    limits:{maxPerType:MAX_PER_TYPE,budgetMs:BUDGET_MS,siteTimeoutMs:SITE_TIMEOUT},
    summary:{selected:0,byCategory:{},byStatus:{}}, results:[]
  };
  const temp=await mkdtemp(join(tmpdir(),"tvbox-runtime-audit-"));
  try {
    for(const [category,path] of categories) {
      let config;
      try { config=JSON.parse(await readFile(path,"utf8")); }
      catch { report.summary.byCategory[category]={selected:0,skipped:"category file unavailable"}; continue; }
      const sites=Array.isArray(config?.sites)?config.sites:[];
      const eligible=sites.filter(s=>s && typeof s==="object");
      const selected=eligible.slice(0,MAX_PER_TYPE);
      report.summary.byCategory[category]={available:eligible.length,selected:selected.length};
      for(const site of selected) {
        if(Date.now()-started>BUDGET_MS) {
          report.results.push({category,key:safeKey(site),name:site.name||"",status:"runtime-uncertain",errorType:"audit-budget-exhausted",reason:"Runtime audit time budget exhausted; not executed"});
          continue;
        }
        const item=await runOne(category,site,config.spider||"",temp);
        report.results.push(item);
      }
    }
    report.summary.selected=report.results.length;
    for(const item of report.results) report.summary.byStatus[item.status]=(report.summary.byStatus[item.status]||0)+1;
    report.elapsedMs=Date.now()-started;
    await writeFile(OUT,JSON.stringify(report,null,2)+"\n","utf8");
    const counts=Object.entries(report.summary.byStatus).map(([k,v])=>k+"="+v).join(" ");
    console.log("Runtime audit: "+report.summary.selected+" site(s) "+counts+"; report="+OUT);
  } finally {
    await rm(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error?.stack||error);process.exitCode=1;});
