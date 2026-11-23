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
import { log, stamp, parseBlockedHosts, isBlockedUrl } from "./core.mjs";
import { harvestAll, loadUpstreams, mergePool, pickCandidates, updatePool, searchGithubRepos, repoToCandidates } from "./collect.mjs";
import { runPipeline, readOptions, writeOutputs, parseLiveSeeds, FILES } from "./pipeline.mjs";

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
  /* 屏蔽域名（config/blocked-hosts.txt）：全流程一票否决，加新域名改那个文件即可 */
  opts.blockedHosts = parseBlockedHosts(await readText("config/blocked-hosts.txt"));
  if (opts.blockedHosts.size) {
    log(`  屏蔽域名：${[...opts.blockedHosts].join(", ")}（候选、站点 jar/api/ext、直播、解析全拦）`);
  }
  log("=".repeat(72));
  log(`TVBox 每日聚合·改进版  策略=${opts.strictness}  点播${opts.vodFastOnly ? "只留快站" : "全档"}  直播每源抽查${opts.liveProbeChannels}频道`);
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

  let poolAll = mergePool({ upstreams: [...upstreamHits, ...ghHits], seeds, prevPool, fromConfigs: [], blockedHosts: opts.blockedHosts });
  const candidates = pickCandidates(poolAll, { limit: opts.maxCandidates, maxFails: opts.maxFails });
  log(`  候选池合计 ${poolAll.length} 条，本轮抓取 ${candidates.length} 条`);

  /* 直播源清单种子（config/liveupstreams.txt）：独立于点播接口，本身就是频道列表。
   * 放在 NO_COLLECT / DRY 判断之外 ——
   *   · --no-collect 的意思是「别去上游捞新点播接口」，不该把仓库里写好的直播种子一起丢掉
   *     （以前就是这么丢的：种子解析整段被包在 if (!NO_COLLECT) 里）
   *   · --dry-run 也该把种子列出来，不然看不出这层有没有生效 */
  const { seeds: seedAll, rejected: badLiveSeeds } = parseLiveSeeds(
    await readText("config/liveupstreams.txt"),
  );
  const liveSeedSources = seedAll.filter((s) => !isBlockedUrl(s.url, opts.blockedHosts));
  if (liveSeedSources.length !== seedAll.length) {
    log(`  ⚠️ ${seedAll.length - liveSeedSources.length} 个直播种子命中屏蔽域名，已拒收`);
  }
  log(`  直播源清单种子：${liveSeedSources.length} 个（优先测、优先当正本、不受直播预算限制）`);
  for (const b of badLiveSeeds) {
    log(`  ⚠️ 跳过直播种子 ${b.name}：${b.url}`);
    log(`     那是多仓/接口索引 JSON，不是播放列表 —— 请挪到 config/upstreams.txt 按 json 类型收集`);
  }

  if (DRY) {
    log("--dry-run：以下为将要抓取的点播接口地址（前 40 条）");
    candidates.slice(0, 40).forEach((c) => log(`   ${c.url}`));
    log(`--dry-run：直播源清单种子（全部 ${liveSeedSources.length} 条）`);
    liveSeedSources.forEach((s) => log(`   [${s.type}] ${s.name}  ${s.url}`));
    return;
  }

  /* ---------- 2~5. 抓取 → 探活 → 去重 → 分类输出 ---------- */
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
    poolAll = mergePool({ upstreams: [], seeds: [], prevPool: { entries: poolAll }, fromConfigs, blockedHosts: opts.blockedHosts });
    log(`  发现新的多仓子地址 ${fromConfigs.length} 条，已写入池子`);
  }
  poolAll = updatePool(poolAll, result.fetchResults);

  /* ---------- 写产物 ----------
   * 这里刻意没有任何「安全阀」：不管本轮抓到多少站都照写。
   * 原因：比例阀（MIN_RATIO）在上游集体抽风时会连着好几天拒绝更新，
   * 产物反而越来越旧 —— 旧产物比空产物更误导人。
   * 真出问题时靠 聚合接口/剔除报告.json + data/history.json 事后追溯。 */
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
  log(`  剔除：失效 ${s.dropped.dead}、太慢 ${s.dropped.slow}、重复 ${s.dropped.dup}、本机引用 ${s.dropped.local}、屏蔽域名 ${s.dropped.blocked || 0}、深度体检 ${s.dropped.deep || 0}、非快站 ${s.dropped.notFast || 0}`);
  if (s.deep) {
    const byStatus = Object.entries(s.deep.byStatus || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");
    log(
      `  深度体检：检查 ${s.deep.checked}（判不准保留 ${s.deep.uncertain}、预算跳过 ${s.deep.skippedBudget}），` +
        `剔除 ${s.deep.removed}${s.jarRepaired ? `，换 jar 修好 ${s.jarRepaired}` : ""}｜${byStatus || "无结果"}`,
    );
  }
  if (s.probeSkipped) log(`  ⚠️ 本轮有 ${s.probeSkipped} 个站因预算用尽没测到，已保留待下轮补测（不算慢站）`);
  log(
    `  直播：${c.liveSources} 个源（清单种子 ${s.liveSeeds || 0} 条 → 存活 ${s.liveSeedsKept || 0} 条）；` +
      `频道抽查实测 ${s.liveProbed || 0} 源、全死剔除 ${s.dropped.liveProbe || 0} 源，不产出合并列表`,
  );
  if (opts.vodFastOnly) log(`  点播只留快站：收录 ${c.all} 站，非快站本轮不收录 ${s.dropped.notFast || 0} 个（池子保留，下轮重测）`);
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
      `| 剔除·深度体检（点开不能用） | ${s.dropped.deep || 0} |`,
      `| 深度体检·换 jar 修好 | ${s.jarRepaired || 0} |`,
      `| 剔除·重复 | ${s.dropped.dup} |`,
      `| 剔除·本机引用 | ${s.dropped.local} |`,
      `| 直播源 | ${c.liveSources}（清单种子 ${s.liveSeeds || 0} → 存活 ${s.liveSeedsKept || 0}） |`,
      `| 直播抽查全死剔除 | ${s.dropped.liveProbe || 0} |`,
      `| 点播非快站不收录 | ${s.dropped.notFast || 0} |`,
      `| 用时 | ${result.elapsed}s |`,
      "",
      "分类产物：" + Object.values(FILES).filter((f) => f.endsWith(".json")).join("、"),
      "",
    ].join("\n");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

main().catch((e) => {
  console.error(`❌ ${e.stack || e.message || e}`);
  process.exit(1);
});
