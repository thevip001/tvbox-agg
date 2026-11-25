import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const run = (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["scripts/runtime-check.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", b => out += b);
  p.stderr.on("data", b => err += b);
  p.on("close", code => resolve({ code, out, err }));
});
const js = await run("--kind", "js");
assert.equal(js.code, 0);
assert.equal(JSON.parse(js.out.trim()).status, "runtime-unsupported");
const jar = await run("--kind", "jar");
assert.equal(jar.code, 0);
assert.equal(JSON.parse(jar.out.trim()).status, "runtime-unsupported");
console.log("runtime adapter contract: JS/JAR safely report unsupported");
