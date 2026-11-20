/**
 * 把运行中的实例导出成静态 JSON / M3U，方便放到 GitHub Pages 作为镜像备份。
 * 用法：node scripts/export-static.mjs https://你的域名
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const origin = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const dir = "export";
await mkdir(dir, { recursive: true });

const targets = [
  ["vod.json", "/api/vod?alive=1&pretty=1"],
  ["vod-all.json", "/api/vod?pretty=1"],
  ["vod-cj.json", "/api/vod?cat=cj&alive=1&pretty=1"],
  ["vod-py.json", "/api/vod?cat=py&pretty=1"],
  ["live.json", "/api/live?pretty=1"],
  ["live.m3u", "/api/live/m3u"],
  ["live.txt", "/api/live/txt"],
  ["apilinks.txt", "/api/sources"],
  ["data.json", "/api/data"],
];

for (const [file, path] of targets) {
  const res = await fetch(origin + path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  await writeFile(join(dir, file), text, "utf8");
  console.log(`${file.padEnd(16)} ${(text.length / 1024).toFixed(1)} KB`);
}
console.log(`\n已导出到 ${dir}/`);
