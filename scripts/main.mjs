#!/usr/bin/env node
/**
 * main.mjs —— 入口：收集 → 抓取 → 探活测速 → 去重 → 分类 → 输出
 *
 * 用法：
 *   node scripts/main.mjs                 # 正常跑一轮（收集+整理）
 *   node scripts/main.mjs --no-collect    # 只抓本体池，不再去上游捞新源
 *   node scripts/main.mjs --dry-run       # 只打印计划，不写文件
 *
 * 环境变量见 README「可调参数」。
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log, stamp } from "./core.mjs";
import { harvestAll, loadUpstreams, mergePool, pickCandidates, updatePool, searchGithubRepos, repoToCandidates } from "./collect.mjs";
import { runPipeline, readOptions, writeOutputs, readPreviousCounts, FILES } from "./pipeline.mjs";

const ARGS = new Set(process.argv.slice(2));
const NO_COLLECT = ARGS.has("--no-collect");
const DRY = ARGS.has("--dry-run");

const REPO = process.env.GITHUB_REPOSITORY || "thevip001/tvbox-agg";
const BRANCH = process.env.GITHUB_REF_NAME || "main";
/**
 * raw 地址：路径里保留中文原样（TVBox 能直接识别）。
 * 之前用 encodeURI 把中文全转成 %E8%81%9A… 实在太难读。
 */
const rawUrl = (file) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/聚合接口/${file}`;

async function readText(path, fallback = "") {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

/** apilinks.txt：名称, 镜像1, 镜像2 ... （与旧脚本同格式，兼容存量） */
function parseSeeds(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    let name = parts[0];
    let urls = parts.slice(1);
    if (/^https?:\/\//i.test(name)) {
      urls = parts;
      try {
        name = new URL(parts[0]).hostname;
      } catch {
        /* keep */
      }
    }
    for (const u of urls) if (/^https?:\/\//i.test(u)) out.push({ name, url: u });
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const opts = readOptions();
  log("=".repeat(72));
  log(`TVBox 每日聚合·改进版  策略=${opts.strictness}  每频道${opts.livePerChannel}源`);
  log("=".repeat(72));

  /* ---------- 1. 收集层 ---------- */
  log("【1/5】收集：从上游清单 + 多仓递归 + 种子 捞候选接口");
  const seeds = parseSeeds(await readText("apilinks.txt"));
  let prevPool = {};
  try {
    prevPool = JSON.parse(await readText(opts.poolFile, "{}"));
  } catch {
    prevPool = {};
  }
  log(`  人工种子 apilinks.txt：${seeds.length} 条；历史池：${(prevPool.entries || []).length} 条`);

  let upstreamHits = [];
  if (!NO_COLLECT) {
    const upstreams = await loadUpstreams("config/upstreams.txt");
    log(`  上游清单源：${upstreams.length} 个`);
    upstreamHits = await harvestAll(upstreams, 6);
  } else {
    log("  --no-collect：跳过上游清单");
  }

  /* L3：GitHub 仓库搜索（只有拿到 token 才跑，CI 里 GITHUB_TOKEN 自动注入） */
  let ghHits = [];
  if (!NO_COLLECT) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    if (token) {
      const { skipped, repos } = await searchGithubRepos({
        token,
        queries: ["tvbox in:name,description,readme", "影视仓 配置 in:name,description", "tvbox 接口 in:readme"],
        perQuery: 8,
        maxAgeDays: Number(process.env.GH_SEARCH_MAX_AGE_DAYS || 30),
      });
      if (!skipped) {
        log(`  GitHub 搜索：命中 ${repos.length} 个近期活跃仓库`);
        // 每个仓库尝试最常见的几个清单文件名，假的会在抓取阶段被淘汰
        const perRepo = Number(process.env.GH_CANDIDATES_PER_REPO || 6);
        for (const repo of repos.slice(0, 12)) {
          ghHits.push({
            name: `GitHub·${repo.name}`,
            ok: true,
            urls: repoToCandidates(repo.name).slice(0, perRepo),
          });
        }
        log(`  从 ${Math.min(repos.length, 12)} 个仓库生成 ${ghHits.reduce((a, h) => a + h.urls.length, 0)} 个候选地址（待抓取验证）`);
      }
    } else {
      log("  GitHub 搜索：未提供 GITHUB_TOKEN，跳过（本地运行时可设 GH_TOKEN 开启）");
    }
  }

  let poolAll = mergePool({ upstreams: [...upstreamHits, ...ghHits], seeds, prevPool, fromConfigs: [] });
  const candidates = pickCandidates(poolAll, { limit: opts.maxCandidates, maxFails: opts.maxFails });
  log(`  候选池合计 ${poolAll.length} 条，本轮抓取 ${candidates.length} 条`);

  if (DRY) {
    log("--dry-run：以下为将要抓取的地址（前 40 条）");
    candidates.slice(0, 40).forEach((c) => log(`   ${c.url}`));
    return;
  }

  /* ---------- 2~5. 抓取 → 探活 → 去重 → 分类输出 ---------- */
  /* 直播源清单（独立于点播接口，直接就是频道列表） */
  let liveSeedSources = [];
  if (!NO_COLLECT) {
    try {
      const liveText = await readText("config/liveupstreams.txt");
      for (const raw of liveText.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
        const url = parts.find((x) => /^https?:\/\//i.test(x));
        if (!url) continue;
        const type = (parts.find((x) => /^(txt|m3u)$/i.test(x)) || "txt").toLowerCase();
        liveSeedSources.push({ name: parts[0] === url ? "直播源" : parts[0], url, type });
      }
      log(`  直播源清单：${liveSeedSources.length} 个（直接产出频道）`);
    } catch {
      log("  ⚠️ 没有 config/liveupstreams.txt，跳过直播源清单");
    }
  }

  log("【2/5】抓取接口配置（自动穿透多仓）");
  const result = await runPipeline({
    candidates,
    liveSeedSources,
    opts,
    onProgress: (m) => log("  " + m),
  });

  // 抓取过程中冒出来的多仓子地址，写回池子供下轮使用
  const fromConfigs = [...new Set(result.stats.subSources || [])];
  if (fromConfigs.length) {
    poolAll = mergePool({ upstreams: [], seeds: [], prevPool: { entries: poolAll }, fromConfigs });
    log(`  发现新的多仓子地址 ${fromConfigs.length} 条，已写入池子`);
  }
  poolAll = updatePool(poolAll, result.fetchResults);

  /* ---------- 安全检查：不允许异常覆盖 ---------- */
  const prev = await readPreviousCounts(opts.outDir);
  if (prev && prev.sites > 0) {
    const ratio = result.counts.all / prev.sites;
    if (ratio < opts.minRatio) {
      log(`❌ 结果异常：本次 ${result.counts.all} 站 vs 上次 ${prev.sites} 站（${(ratio * 100).toFixed(0)}% < 阈值 ${(opts.minRatio * 100).toFixed(0)}%）`);
      log("   为避免覆盖可用产物，本次不写文件。请检查上游是否集体故障。");
      process.exitCode = 2;
      return;
    }
  }

  log("【3/5】写入聚合文件");
  const when = stamp().slice(0, 16);
  const sizes = await writeOutputs({ result, opts, rawUrl, when });
  for (const [f, s] of sizes) log(`   ${f.padEnd(22)} ${(s / 1024).toFixed(0)} KB`);

  /* ---------- 持久化池子与历史 ---------- */
  await writeFile(opts.poolFile, JSON.stringify({ updated: when, entries: poolAll }, null, 1) + "\n", "utf8");
  let history = [];
  try {
    history = JSON.parse(await readText(opts.historyFile, "[]"));
  } catch {
    history = [];
  }
  history.push({
    when,
    counts: result.counts,
    grades: result.stats.grades,
    uncertain: result.stats.uncertain,
    dropped: result.stats.dropped,
    fetched: result.stats.fetched,
    candidates: result.stats.candidates,
    elapsed: result.elapsed,
  });
  // 历史统计只保留最近 N 天（默认 30），不是按条数——
  // 一天可能因为手动触发跑好几次，按条数存会悄无声息地超出"一个月"。
  const keepDays = Number(process.env.HISTORY_KEEP_DAYS || 30);
  const cutoff = Date.now() - keepDays * 86400 * 1000;
  const parsedWhen = (h) => {
    const t = Date.parse(String(h?.when || "").replace(" ", "T") + ":00+08:00");
    return Number.isFinite(t) ? t : 0;
  };
  const trimmed = history.filter((h) => parsedWhen(h) >= cutoff);
  await writeFile(opts.historyFile, JSON.stringify(trimmed, null, 1) + "\n", "utf8");
  log(`  历史统计：保留最近 ${keepDays} 天，共 ${trimmed.length} 条（丢弃 ${history.length - trimmed.length} 条旧的）`);

  /* ---------- 4/5 汇总 ---------- */
  const c = result.counts;
  const s = result.stats;
  log("【4/5】结果");
  log(`  点播合集 ${c.all} 站（采集站 ${c.cj} / Py ${c.py} / JS ${c.js} / Jar ${c.spider} / 其它 ${c.other}）`);
  const g = s.grades || {};
  log(`  速度分档：精选 ${g.fast || 0} / 普通 ${g.ok || 0} / 偏慢 ${g.slow || 0} / 失效 ${g.dead || 0}（测不准 ${g.uncertain || 0}、未测到 ${g.unsure || 0}，均保留）`);
  log(`  剔除：失效 ${s.dropped.dead}、太慢 ${s.dropped.slow}、重复 ${s.dropped.dup}、本机引用 ${s.dropped.local}`);
  if (s.probeSkipped) log(`  ⚠️ 本轮有 ${s.probeSkipped} 个站因预算用尽没测到，已保留待下轮补测（不算慢站）`);
  log(`  直播：${c.liveSources} 个源；频道 ${c.rawChannels} → 合并后 ${c.channels} 条`);
  log(`  总用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);

  log("【5/5】完成");

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## TVBox 聚合结果（${when} 北京时间）`,
      "",
      "| 项目 | 数值 |",
      "| --- | --- |",
      `| 候选接口 → 抓取成功 | ${s.candidates} → ${s.fetched} |`,
      `| 原始站点 → 去重后 → 输出 | ${s.rawSites} → ${s.afterDedupSites} → ${c.all} |`,
      `| 剔除·失效 | ${s.dropped.dead} |`,
      `| 剔除·太慢 | ${s.dropped.slow} |`,
      `| 剔除·重复 | ${s.dropped.dup} |`,
      `| 剔除·本机引用 | ${s.dropped.local} |`,
      `| 直播源 | ${c.liveSources} |`,
      `| 频道（合并前 → 合并后） | ${c.rawChannels} → ${c.channels} |`,
      `| 用时 | ${result.elapsed}s |`,
      "",
      "分类产物：" + Object.values(FILES).filter((f) => f.endsWith(".json") || f.endsWith(".m3u")).join("、"),
      "",
    ].join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

main().catch((e) => {
  console.error(`❌ ${e.stack || e.message || e}`);
  process.exit(1);
});
