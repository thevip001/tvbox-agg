# TVBox 接口每日聚合（tvbox-agg）

每天北京时间 04:00，GitHub Actions 自动抓取 `apilinks.txt` 里的 TVBox 接口，整理去重后，更新 `聚合接口/` 文件夹里的全部文件。

## 文件与地址

把对应地址直接填进 TVBox 即可。

| 文件 | 内容 | **站点数量** | 地址 |
| --- | --- | ---: | --- |
| 点播合集.json | 全部点播站点合并去重（采集站、Py、JS、Jar 及其它类型） | <!--NUM:all-->1880 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json |
| 点播-采集站.json | 点播 · 采集站（只保留检测可用的） | <!--NUM:cj-->60 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json |
| 点播-Py站.json | 点播 · Py 站 | <!--NUM:py-->400 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json |
| 点播-JS站.json | 点播 · JS 站 | <!--NUM:js-->177 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json |
| 点播-Jar爬虫站.json | 点播 · Jar 爬虫站 | <!--NUM:spider-->1243 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json |
| live.json | 直播聚合接口（TVBox 配置格式） | <!--NUM:liveSources-->65 个源 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json |

> 上表的数量由每日聚合任务自动回写（见下方的「最新数量」块），和产物永远一致。
> 四个分类文件相加 = 点播合集（极少数条目会因内容指纹去重略有出入）。
> `聚合接口/README.md` 里有更详细的分档和过滤明细。

<!-- 站点数量:start（由每日聚合自动生成，勿手改） -->
> **最新数量**（2026-11-23 14:23 更新）：点播合集 **1880**（采集 60 · Py 400 · JS 177 · Jar 1243 · 其它 0，只含快站）｜直播源 **65**（抽查存活）
<!-- 站点数量:end -->

## 更新时间

- 每天北京时间 04:00 自动运行。原项目「接口处理扫描工具」在北京时间 03:00 更新，这里延后一个小时。
- 也可以在仓库的 Actions 页面，选择「每日更新聚合接口」→ Run workflow 手动运行。

## 去重规则

**点播**

- 同一个站点（type + api + ext 相同）只保留一个。比较时忽略协议、www、末尾斜杠和 GitHub 代理前缀的差异。
- 采集站（type 0/1）会请求 `?ac=list` 检测，失效的剔除。
- **深度体检：探活通过 ≠ 点开能用**（2026-11-22 新增，思路取自 [MisaTV](https://github.com/yagami-hue/MisaTV) 的「源体检」）。
  以前探活只验「接口文件还在」，于是产物里混着一堆点开就报错的站。现在对探活通过的站点按类型实跑一次：
  | 类型 | 怎么验 | 判为不可用的条件 |
  | --- | --- | --- |
  | 采集站（type 0/1） | 真的解析结构化数据：有分类就用首个分类再刷一页 | 只有空列表（`{"code":0,"list":[]}` 的空壳站）/ 有分类但取不到任何条目 |
  | Jar 爬虫站（`csp_*`） | 解包 jar 的 `classes.dex`，看有没有 `com.github.catvod.spider.类名` | **类不在包里** —— TVBox 一加载就 ClassNotFoundException，站点列表里看得见、点开全报错 |
  | 规则型爬虫 / JS 站 | 把 `ext` 规则拉下来，抽出规则里的目标站逐个探活 | 规则无效 / 目标站**全部**不可达（域名已不存在、停站页） |
  - **jar 缺类时会先尝试换 jar**：同一份配置里别的 jar 带着这个类，就只换 jar 不删站（实测 GitHub 上 16 个 jar 里就有 18 处「站点指向的类不在包里」，覆盖 122 个站）。
  - **判不准的一律保留**：403 / 429 / 5xx / 超时 / 跑测机网络受限，只降档不删除，下轮重测。
  - 开关：`DEEP_CHECK=0` 整体关；`DEEP_CHECK_CATEGORIES=cj,js,spider` 选类型；`DEEP_JAR_CLASS=0` 关类名校验；预算 `BUDGET_DEEP_CHECK`（默认 600 秒）。
  - 体检结果写进 `聚合接口/剔除报告.json` 的「深度体检」区，每条都带 `health` 状态（`empty` / `no-class` / `no-target` / `needs-ext` / `no-rule`）和具体原因。
- **测速只看首字节（TTFB），不看吞吐**：接口本身就是几十 KB 的 JSON/脚本，KB/s 低只代表文件小；
  实测按 50KB/s 判会删掉 TTFB 只有 130~360ms 的健康站。
  - 普通站：TTFB > 1500ms 判慢（strict 下剔除），≤300ms 为精选，≤800ms 为正常
  - 内置爬虫站（`csp_*`，测的是目标站首页 HTML）：放宽到 3000ms
  - 限流 / 403 / 本轮预算用尽没测到的站：单独标记并保留，下轮重测，绝不当成慢站删除
- **输出只收录快站**（`VOD_ONLY_FAST`，默认开）：只有 `fast` 档（普通 TTFB≤300ms、**采集站≤800ms**，见 `FAST_TTFB_CJ_MS`）进产物，其它档位本轮不收录、
  写进剔除报告，但**不进死名单** —— 池子保留它们，下轮探活测成快站还会回来。想收回全档设 `VOD_ONLY_FAST=0`。
  采集站阈值单独放宽：type 0/1 的 cms 后端首字节天然比静态资源慢，跟 300ms 一刀切会砍掉整类大半。
- 点播合集把采集站、Py、JS、Jar 以及其它类型合并后，再做一次去重整理。
- 解析（parses）按地址去重，flags 合并。

**直播**

- 直播源有两个来路：① 每个点播接口配置里的 `lives` 字段（主要来源，新旧两种格式都吃，
  老格式 `channels[].urls[]` 里 base64 的 `ext=` 地址会自动解出来）；② `config/liveupstreams.txt`
  里人工确认过的**清单种子**（本身就是播放列表）。
- **屏蔽域名一票否决**（`config/blocked-hosts.txt`）：站点的 jar/api/ext/playUrl/url、直播源 url、
  解析 url 任一命中就整条剔除，候选池里的同域地址也不抓；剔除报告里写明命中的字段和域名。
  匹配前先归一，被 gh-proxy 套娃藏起来的屏蔽域名同样认得。现名单：`7moor-fs1.com`
  （上游把 spider jar 挂在客服站文件托管上，TVBox 的 java 一加载就被杀毒拦截）。
- 直播源按地址去重（忽略协议、www、末尾斜杠和 GitHub 代理前缀的差异）。
- 逐个下载直播源，检测能否解析出频道，失效的剔除。剔除原因写进 `聚合接口/剔除报告.json`，
  内容不是播放列表时会说清楚（例如「内容是多仓/接口索引 JSON，不是播放列表」）。
- 频道内容完全相同的源只保留一个。**种子优先当正本**：种子排在探活队列最前，
  去重又是先到先得，所以与种子内容相同的杂源被剔，报告里会写明正本是谁；
  种子还不受 `BUDGET_LIVE` 预算限制，不会因为「预算用尽」被判死。
  点播接口 `lives` 里已有的同一地址会就地升级成种子，不重复计一条。
- **频道抽查**（`LIVE_PROBE_CHANNELS`，默认 3）：探活成功后，每个源再随机抽 3 个频道流地址实测，
  全部失败**且均属「确定死」**（HTTP 4xx/5xx、连接超时、空内容）才剔除整个源（报告里写明抽到的频道与各自失败原因）；预算用尽没抽到的源保留、下轮再抽。
  **测不准不算失败**：失败若属跑测环境限制（跑测机无 IPv6 → ENETUNREACH/EHOSTUNREACH、多地址全拒连 → AggregateError、
  端口回非 HTTP 应答 → Parse Error: Expected HTTP/, RTSP/ or ICE/），不剔源，剔除报告里单列「测不准但保留」。
- **不做频道合并**（2026-11-22 改）：不再生成 `live.m3u`，`live.json` 里也不置顶合并列表 ——
  直播接口只装「过了抽查的源本身」，按探活速度排序。旧版把各源频道混进一张列表，
  MV/点歌台/轮播库掺在一起又乱又死链多，已废弃。

## 修改接口列表

编辑根目录的 `apilinks.txt`，每行格式为「名称, 地址1, 地址2 ...」。多个地址是镜像，按顺序自动选通。提交后，下次更新生效。

想加**直播源**就编辑 `config/liveupstreams.txt`，每行「名称, 播放列表地址, txt 或 m3u」。
这里只放播放列表：多仓/接口索引 JSON（形如 `{"urls":[{url,name}]}`）会被拒收并提示挪去
`config/upstreams.txt`（那边才是收集「去哪里找接口」的地方）。
想加**点播上游清单**就编辑 `config/upstreams.txt`，类型可选 `links` / `readme` / `json` / `apilinks`。
改完 `node scripts/main.mjs --dry-run` 就能先看到本轮会用哪些种子和候选，不写任何文件。

## 目录

- `apilinks.txt`：人工种子接口列表（51 条有效行，沿用原项目 lubin776/tvbox-api-backup 的 `api_list.json`）
- `config/upstreams.txt`：上游公开清单源（自动收集用，抽出的是「去哪里找接口」）
- `config/liveupstreams.txt`：直播源清单种子（本身就是播放列表，绕开候选池直接进直播阶段，见下）
- `config/blocked-hosts.txt`：屏蔽域名名单（域名+全部子域，全流程一票否决，见下）
- `data/pool.json`：候选池（自动累积，记录每条地址的成功/失败次数）
- `聚合接口/`：每日生成的聚合文件
- `scripts/main.mjs`：入口（收集 → 抓取 → 探活测速 → 去重 → 分类输出，无第三方依赖，需 Node.js 18+）
- `scripts/deepcheck.mjs`：深度体检（按类型实跑：采集站内容 / jar 类名 / 规则目标站；零依赖自己读 ZIP+dex）
- `scripts/selftest.mjs`：离线自检 63 项（`node scripts/selftest.mjs`，全程不出网；含快站筛选、频道抽查、测不准分类、种子与屏蔽域名、深度体检的端到端用例）
- `.github/workflows/aggregate-daily.yml`：每日定时任务

## 产物保留（30 天）

`聚合接口/` 里的 9 个文件**每天是覆盖重写的**，仓库里永远只有最新一份（所以体积固定，不会一天涨一份）。
真正会累积的只有两处，都按 30 天滚动：

| 数据 | 保留 | 说明 |
| --- | --- | --- |
| `data/history.json` | 最近 **30 天** | 每次运行的统计（站点数、分档、剔除数），按日期裁剪，不是按条数 |
| `data/pool.json` | 最近 **30 天** | 候选池；30 天没再出现的地址自动删除；连续失败 3 次的压缩成最小记录（不抓、不删，防止上游重新灌回来白测），同样 30 天后过期 |

两个天数都能用环境变量改（`HISTORY_KEEP_DAYS` / `POOL_KEEP_DAYS`），工作流里已设为 30。
工作流最后一步还会检查产物的更新时间，超过 7 天没更新会告警（说明定时任务可能没跑）。

## 剔除策略（无需每次手选）

`STRICTNESS` 默认就是 **strict**：定时任务不传任何参数时按 strict 跑，也就是死站删、慢站也删。
手动 Run workflow 时下拉框默认值同样是 strict，不动它即可。另外两个选项只在需要时用：

| 策略 | 死站 | 慢站（TTFB 超标） |
| --- | --- | --- |
| strict（默认） | 删除 | 删除 |
| balanced | 删除 | 保留在文末 |
| loose | 删除 | 全部保留 |

## 声明

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习，请勿用于违法或商业用途，请勿付费购买；如涉及侵权请联系删除。
