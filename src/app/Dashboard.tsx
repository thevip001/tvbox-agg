"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Source = {
  id: number;
  name: string;
  urls: string[];
  status: string;
  usedUrl: string | null;
  error: string | null;
  sizeBytes: number;
  siteCount: number;
  liveCount: number;
  parseCount: number;
  fetchedAt: string | null;
  okAt: string | null;
};
type Site = { id: number; key: string; name: string; type: number; api: string; category: string; sources: string[]; alive: boolean | null; latencyMs: number | null };
type Live = { id: number; name: string; url: string; ua: string | null; sources: string[]; alive: boolean | null; channelCount: number; sizeBytes: number; duplicateOf: string | null };
type Stats = Record<string, number>;
type Data = { sources: Source[]; sites: Site[]; lives: Live[]; stats: Stats | null; running: boolean; job: { id: number; status: string; startedAt: string; finishedAt: string | null; trigger: string } | null };

/** 每个直播源随机抽查几个频道（与后端 LIVE_PROBE_CHANNELS 默认值一致，仅用于文案） */
const LIVE_PROBE_N = 3;

const TABS = [
  { id: "agg", label: "🔗 聚合接口" },
  { id: "vod", label: "📺 点播接口" },
  { id: "sites", label: "🧩 点播站点(去重)" },
  { id: "live", label: "📡 直播源(去重)" },
  { id: "manage", label: "⚙️ 接口管理" },
  { id: "about", label: "ℹ️ 关于" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const CAT_LABEL: Record<string, string> = { cj: "采集站", py: "Py 站", js: "JS 站", spider: "Jar 爬虫", other: "其他" };

function fmtSize(n: number) {
  if (!n) return "-";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
function fmtTime(s: string | null) {
  if (!s) return "-";
  return new Date(s).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function CopyBtn({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
      className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition ${done ? "bg-emerald-500 text-white" : "bg-sky-600 text-white hover:bg-sky-500"}`}
    >
      {done ? "✅ 已复制" : label}
    </button>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-slate-900/70 px-3 py-2">
      <span className="w-20 shrink-0 text-xs text-slate-400">{label}</span>
      <code className="min-w-0 flex-1 truncate text-xs text-sky-200" title={url}>
        {url}
      </code>
      <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-slate-400 hover:text-white">
        打开
      </a>
      <CopyBtn text={url} />
    </div>
  );
}

function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "green" | "red" | "amber" | "sky" | "violet" }) {
  const tones = {
    slate: "bg-slate-700/60 text-slate-200",
    green: "bg-emerald-500/20 text-emerald-300",
    red: "bg-rose-500/20 text-rose-300",
    amber: "bg-amber-500/20 text-amber-300",
    sky: "bg-sky-500/20 text-sky-300",
    violet: "bg-violet-500/20 text-violet-300",
  };
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>;
}

function StatCard({ title, raw, dedup, extra }: { title: string; raw?: number; dedup?: number; extra?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs text-slate-400">{title}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-white">{dedup ?? "-"}</span>
        {raw !== undefined && <span className="text-xs text-slate-500">原始 {raw}</span>}
      </div>
      {raw !== undefined && dedup !== undefined && raw > 0 && (
        <div className="mt-1 text-[11px] text-emerald-400">去除重复 {raw - dedup}（{(((raw - dedup) / raw) * 100).toFixed(0)}%）</div>
      )}
      {extra && <div className="mt-1 text-[11px] text-slate-400">{extra}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<TabId>("agg");
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [liveFilter, setLiveFilter] = useState("all");
  const [limit, setLimit] = useState(200);
  const [jobLog, setJobLog] = useState("");
  const [srcText, setSrcText] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  const load = useCallback(async () => {
    const r = await fetch("/api/data", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load();
  }, [load]);

  // 运行中轮询
  useEffect(() => {
    if (!data?.running && tab !== "manage") return;
    const t = setInterval(async () => {
      const r = await fetch("/api/refresh", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setJobLog(j.job?.log || "");
      if (data?.running && !j.running) void load();
      else if (j.running !== data?.running) setData((d) => (d ? { ...d, running: j.running } : d));
    }, 2500);
    return () => clearInterval(t);
  }, [data?.running, tab, load]);

  useEffect(() => {
    if (tab === "manage" && !srcText) {
      void fetch("/api/sources").then((r) => r.text()).then(setSrcText);
    }
    setLimit(200);
  }, [tab, srcText]);

  const kw = q.trim().toLowerCase();
  const match = (...vals: (string | null | undefined)[]) => !kw || vals.some((v) => v && v.toLowerCase().includes(kw));

  const sources = useMemo(() => (data?.sources ?? []).filter((s) => match(s.name, ...s.urls)), [data, kw]); // eslint-disable-line react-hooks/exhaustive-deps
  const sites = useMemo(
    () =>
      (data?.sites ?? []).filter(
        (s) => (catFilter === "all" || s.category === catFilter || (catFilter === "dead" && s.alive === false)) && match(s.name, s.key, s.api, ...s.sources),
      ),
    [data, kw, catFilter], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const lives = useMemo(
    () =>
      (data?.lives ?? []).filter((l) => {
        if (liveFilter === "ok" && !(l.alive && !l.duplicateOf)) return false;
        if (liveFilter === "dup" && !l.duplicateOf) return false;
        if (liveFilter === "dead" && l.alive) return false;
        return match(l.name, l.url, ...l.sources);
      }),
    [data, kw, liveFilter], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const startRefresh = async () => {
    await fetch("/api/refresh", { method: "POST" });
    setData((d) => (d ? { ...d, running: true } : d));
    setTab("manage");
  };

  const saveSources = async () => {
    setSaveMsg("保存中…");
    const r = await fetch("/api/sources", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: srcText }) });
    const j = await r.json();
    setSaveMsg(r.ok ? `✅ 已保存 ${j.count} 个接口，点击「立即更新」生效` : `❌ ${j.error}`);
    void load();
  };

  const st = data?.stats;
  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of data?.sites ?? []) m[s.category] = (m[s.category] ?? 0) + 1;
    return m;
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex flex-col gap-4 py-8 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-sky-300 via-cyan-200 to-emerald-300 bg-clip-text text-3xl font-black text-transparent">海量接口搬运备份站</h1>
          <p className="mt-1 text-sm text-slate-400">TVBox 接口自动备份 · 点播 / 直播整理去重 · 一键聚合接口</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="🔍 搜索接口 / 站点 / 直播…"
            className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <button
            onClick={startRefresh}
            disabled={data?.running}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-wait disabled:bg-slate-700"
          >
            {data?.running ? "⏳ 更新中…" : "🔄 立即更新"}
          </button>
          <a
            href="/downloads/tvbox-agg.zip"
            download
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            📦 下载源码
          </a>
        </div>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${tab === t.id ? "bg-sky-600 text-white" : "text-slate-300 hover:bg-slate-800"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {!data && <div className="py-20 text-center text-slate-400">加载中…</div>}

      {data && !st && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {data.running ? "⏳ 首次抓取正在进行中（约需几分钟），完成后自动刷新页面数据。" : "还没有聚合数据，点击右上角「立即更新」开始抓取。"}
        </div>
      )}

      {data && tab === "agg" && (
        <section className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard title="点播接口" dedup={st?.sourcesWithData} extra={st ? `本轮成功 ${st.sourcesOk} / ${st.sourcesTotal}` : undefined} />
            <StatCard title="点播站点" raw={st?.rawSites} dedup={st?.dedupSites} />
            <StatCard title="直播源" raw={st?.rawLives} dedup={st ? st.dedupLives - st.liveContentDup : undefined} extra={st ? `可用 ${st.liveAlive}，内容重复 ${st.liveContentDup}` : undefined} />
            <StatCard title="抽查剔除" dedup={st?.liveProbeDropped} extra={st ? `每源随机抽 ${LIVE_PROBE_N} 个频道，全失败即剔除` : undefined} />
          </div>

          <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-950/60 to-slate-900 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-sky-200">🎬 海量点播聚合接口</h2>
              <span className="text-xs text-slate-400">共 {data.sites.length} 个去重站点 · 解析 {st?.dedupParses ?? 0} 条</span>
            </div>
            <div className="space-y-2">
              <UrlRow label="全部站点" url={`${origin}/vod.json`} />
              <UrlRow label="仅可用" url={`${origin}/api/vod?alive=1`} />
              <UrlRow label={`采集站 ${catCounts.cj ?? 0}`} url={`${origin}/api/vod?cat=cj&alive=1`} />
              <UrlRow label={`Py 站 ${catCounts.py ?? 0}`} url={`${origin}/api/vod?cat=py`} />
              <UrlRow label={`JS 站 ${catCounts.js ?? 0}`} url={`${origin}/api/vod?cat=js`} />
              <UrlRow label={`Jar 爬虫 ${catCounts.spider ?? 0}`} url={`${origin}/api/vod?cat=spider`} />
              <UrlRow label="点播+直播" url={`${origin}/api/vod?alive=1&live=1`} />
            </div>
            <p className="mt-3 text-xs text-slate-400">
              去重规则：按 type + api（忽略协议/www/尾斜杠/GitHub 代理前缀）+ ext 判定同一站点；每个 Jar 爬虫站点自动带上其来源接口的 spider，保证混合聚合后仍可运行。
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/50 to-slate-900 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold text-emerald-200">📡 海量直播聚合接口</h2>
              <span className="text-xs text-slate-400">{st ? `${st.dedupLives - st.liveContentDup - (st.liveProbeDropped ?? 0)} 个可用直播源` : ""}</span>
            </div>
            <div className="space-y-2">
              <UrlRow label="TVBox 配置" url={`${origin}/live.json`} />
              <UrlRow label="含失效源" url={`${origin}/api/live?all=1`} />
            </div>
            <p className="mt-3 text-xs text-slate-400">
              只剔不合：① 直播源 URL 规范化去重 ② 按频道地址集合哈希剔除内容完全相同的重复源 ③ 每源随机抽 {LIVE_PROBE_N} 个频道实测，全部失败就剔除整个源。接口里只有源本身，不再产出合并的 M3U / TXT。
            </p>
          </div>
        </section>
      )}

      {data && tab === "vod" && (
        <section className="space-y-3">
          <p className="text-sm text-slate-400">共 {sources.length} 个点播接口。「备份线路」为本站缓存的配置（相对路径已补全），原站失效时也可使用。</p>
          {sources.map((s) => (
            <div key={s.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold text-white">{s.name}</span>
                {s.status === "ok" && <Badge tone="green">正常</Badge>}
                {s.status === "stale" && <Badge tone="amber">原站失效·使用备份</Badge>}
                {s.status === "fail" && <Badge tone="red">失效</Badge>}
                {s.status === "pending" && <Badge>待抓取</Badge>}
                <Badge tone="sky">站点 {s.siteCount}</Badge>
                <Badge tone="violet">直播 {s.liveCount}</Badge>
                <Badge>{fmtSize(s.sizeBytes)}</Badge>
                <span className="ml-auto text-[11px] text-slate-500">更新 {fmtTime(s.okAt)}</span>
              </div>
              <div className="space-y-1.5">
                {s.urls.map((u, i) => (
                  <UrlRow key={u} label={i === 0 ? "原始线路" : `镜像 ${i + 1}`} url={u} />
                ))}
                {(s.status === "ok" || s.status === "stale") && <UrlRow label="备份线路" url={`${origin}/api/backup/${s.id}`} />}
              </div>
              {s.error && s.status !== "ok" && <p className="mt-2 truncate text-[11px] text-rose-300/80" title={s.error}>{s.error}</p>}
            </div>
          ))}
        </section>
      )}

      {data && tab === "sites" && (
        <section>
          <div className="mb-3 flex flex-wrap gap-2">
            {[["all", `全部 ${data.sites.length}`], ...Object.entries(CAT_LABEL).filter(([k]) => catCounts[k]).map(([k, v]) => [k, `${v} ${catCounts[k]}`]), ["dead", "失效采集站"]].map(([k, v]) => (
              <button key={k} onClick={() => setCatFilter(k)} className={`rounded-full px-3 py-1 text-xs ${catFilter === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"}`}>
                {v}
              </button>
            ))}
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="hidden px-3 py-2 md:table-cell">API</th>
                  <th className="px-3 py-2">出现于</th>
                  <th className="px-3 py-2">状态</th>
                </tr>
              </thead>
              <tbody>
                {sites.slice(0, limit).map((s) => (
                  <tr key={s.id} className="border-t border-slate-800/80 hover:bg-slate-900/60">
                    <td className="px-3 py-2">
                      <div className="text-slate-100">{s.name}</div>
                      <div className="text-[10px] text-slate-500">{s.key}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone="sky">{CAT_LABEL[s.category]}</Badge> <span className="text-slate-500">type {s.type}</span>
                    </td>
                    <td className="hidden max-w-xs truncate px-3 py-2 text-slate-400 md:table-cell" title={s.api}>{s.api}</td>
                    <td className="px-3 py-2" title={s.sources.join("、")}>
                      <span className="text-slate-300">{s.sources[0]}</span>
                      {s.sources.length > 1 && <Badge tone="amber">+{s.sources.length - 1} 重复</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      {s.alive === true && <Badge tone="green">可用 {s.latencyMs}ms</Badge>}
                      {s.alive === false && <Badge tone="red">失效</Badge>}
                      {s.alive === null && <span className="text-slate-500">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sites.length > limit && (
            <button onClick={() => setLimit((l) => l + 300)} className="mt-3 w-full rounded-lg bg-slate-800 py-2 text-sm text-slate-300 hover:bg-slate-700">
              加载更多（剩余 {sites.length - limit}）
            </button>
          )}
        </section>
      )}

      {data && tab === "live" && (
        <section>
          <div className="mb-3 flex flex-wrap gap-2">
            {[["all", `全部 ${data.lives.length}`], ["ok", "已收录（可用且不重复）"], ["dup", "内容重复"], ["dead", "失效"]].map(([k, v]) => (
              <button key={k} onClick={() => setLiveFilter(k)} className={`rounded-full px-3 py-1 text-xs ${liveFilter === k ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300"}`}>
                {v}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {lives.slice(0, limit).map((l) => (
              <div key={l.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-sm font-semibold text-white">{l.name}</span>
                  {l.alive && !l.duplicateOf && <Badge tone="green">已收录</Badge>}
                  {l.duplicateOf && <Badge tone="amber">与「{l.duplicateOf}」内容相同</Badge>}
                  {!l.alive && <Badge tone="red">失效</Badge>}
                  <Badge tone="violet">{l.channelCount} 频道</Badge>
                  <Badge>{fmtSize(l.sizeBytes)}</Badge>
                  {l.ua && <Badge>UA: {l.ua}</Badge>}
                  <span className="ml-auto text-slate-500" title={l.sources.join("、")}>
                    来源：{l.sources.slice(0, 3).join("、")}
                    {l.sources.length > 3 ? ` 等 ${l.sources.length} 个` : ""}
                  </span>
                </div>
                <UrlRow label="原始线路" url={l.url} />
              </div>
            ))}
          </div>
          {lives.length > limit && (
            <button onClick={() => setLimit((x) => x + 300)} className="mt-3 w-full rounded-lg bg-slate-800 py-2 text-sm text-slate-300 hover:bg-slate-700">
              加载更多（剩余 {lives.length - limit}）
            </button>
          )}
        </section>
      )}

      {data && tab === "manage" && (
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <h3 className="mb-1 font-semibold text-white">接口列表（apilinks.txt 格式）</h3>
            <p className="mb-2 text-xs text-slate-400">每行：名称, URL1, URL2, …（多个 URL 为镜像，按顺序自动选通）；# 开头为注释。</p>
            <textarea
              value={srcText}
              onChange={(e) => setSrcText(e.target.value)}
              spellCheck={false}
              className="h-[460px] w-full rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-200 outline-none focus:border-sky-500"
            />
            <div className="mt-2 flex items-center gap-3">
              <button onClick={saveSources} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500">
                💾 保存
              </button>
              <span className="text-xs text-slate-300">{saveMsg}</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold text-white">更新任务日志</h3>
              <button onClick={startRefresh} disabled={data.running} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:bg-slate-700">
                {data.running ? "⏳ 运行中" : "🔄 立即更新"}
              </button>
            </div>
            <p className="mb-2 text-xs text-slate-400">
              最近任务：#{data.job?.id ?? "-"} · {data.job?.status ?? "-"} · 开始 {fmtTime(data.job?.startedAt ?? null)} · 结束 {fmtTime(data.job?.finishedAt ?? null)}。服务每 12 小时自动更新一次。
            </p>
            <pre className="h-[460px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300">{jobLog || "（暂无日志）"}</pre>
          </div>
        </section>
      )}

      {data && tab === "about" && (
        <section className="space-y-4 text-sm leading-relaxed text-slate-300">
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="mb-2 font-semibold text-white">项目说明</h3>
            <p>
              复刻自 <a className="text-sky-300 underline" href="https://github.com/lubin776/tvbox-api-backup" target="_blank" rel="noreferrer">lubin776/tvbox-api-backup</a>
              ：原项目用 GitHub Actions + Python 脚本定时抓取 TVBox 接口、提取直播源/采集站/Py 站并托管静态页面。本站以 Next.js + PostgreSQL 重写，服务端定时抓取并新增：
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>支持图片套壳、Base64、AES-CBC（2423）加密、带注释 JSON、多仓接口的自动解码与展开；</li>
              <li>点播站点全局去重 + 采集站可用性检测，输出可按分类筛选的点播聚合接口；</li>
              <li>直播源 URL 去重 + 内容级去重 + 频道级合并，输出直播聚合接口（TVBox JSON / M3U / TXT）；</li>
              <li>每个接口保留最近一次成功的备份线路，原站失效时仍可使用。</li>
            </ul>
          </div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/30 p-5">
            <h3 className="mb-2 font-semibold text-emerald-200">📦 源码下载</h3>
            <p>
              下载完整源码压缩包（包含 <code>.git</code> 提交记录，不含 <code>.env</code> 与 <code>node_modules</code>）。解压后按 README 中「推送到 GitHub」的步骤即可上传到你自己的仓库。
            </p>
            <a
              href="/downloads/tvbox-agg.zip"
              download
              className="mt-3 inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              ⬇️ 下载 tvbox-agg.zip
            </a>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <h3 className="mb-2 font-semibold text-white">声明</h3>
            <p>所有资源均来自互联网公开接口，版权归原作者所有。仅供测试学习使用，请勿用于违法及商业用途，请勿付费购买。如涉及侵权，请联系删除。</p>
          </div>
        </section>
      )}
    </div>
  );
}
