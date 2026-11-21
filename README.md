# TVBox 接口每日聚合（tvbox-agg）

每天北京时间 04:00，GitHub Actions 自动抓取 `apilinks.txt` 里的 TVBox 接口，整理去重后，更新 `聚合接口/` 文件夹里的全部文件。

## 文件与地址

把对应地址直接填进 TVBox 即可。

| 文件 | 内容 | **站点数量** | 地址 |
| --- | --- | ---: | --- |
| 点播合集.json | 全部点播站点合并去重（采集站、Py、JS、Jar 及其它类型） | 4810 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json |
| 点播-采集站.json | 点播 · 采集站（只保留检测可用的） | 69 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json |
| 点播-Py站.json | 点播 · Py 站 | 363 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json |
| 点播-JS站.json | 点播 · JS 站 | 1541 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json |
| 点播-Jar爬虫站.json | 点播 · Jar 爬虫站 | 2834 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json |
| live.json | 直播聚合接口（TVBox 配置格式） | 83 个源 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json |
| live.m3u | 直播频道合并去重（M3U） | 13419 个频道 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u |

> 上表的数量由每日聚合任务自动回写（见下方的「最新数量」块），和产物永远一致。
> 四个分类文件相加 = 点播合集（极少数条目会因内容指纹去重略有出入）。
> `聚合接口/README.md` 里有更详细的分档和过滤明细。

<!-- 站点数量:start（由每日聚合自动生成，勿手改） -->
> **最新数量**（2026-11-21 15:59 更新）：点播合集 **2333**（采集 42 · Py 285 · JS 476 · Jar 1526 · 其它 4）｜直播源 **58**｜直播频道 **7933**
<!-- 站点数量:end -->

## 更新时间

- 每天北京时间 04:00 自动运行。原项目「接口处理扫描工具」在北京时间 03:00 更新，这里延后一个小时。
- 也可以在仓库的 Actions 页面，选择「每日更新聚合接口」→ Run workflow 手动运行。

## 去重规则

**点播**

- 同一个站点（type + api + ext 相同）只保留一个。比较时忽略协议、www、末尾斜杠和 GitHub 代理前缀的差异。
- 采集站（type 0/1）会请求 `?ac=list` 检测，失效的剔除。
- **测速只看首字节（TTFB），不看吞吐**：接口本身就是几十 KB 的 JSON/脚本，KB/s 低只代表文件小；
  实测按 50KB/s 判会删掉 TTFB 只有 130~360ms 的健康站。
  - 普通站：TTFB > 1500ms 判慢（strict 下剔除），≤300ms 为精选，≤800ms 为正常
  - 内置爬虫站（`csp_*`，测的是目标站首页 HTML）：放宽到 3000ms
  - 限流 / 403 / 本轮预算用尽没测到的站：单独标记并保留，下轮重测，绝不当成慢站删除
- 点播合集把采集站、Py、JS、Jar 以及其它类型合并后，再做一次去重整理。
- 解析（parses）按地址去重，flags 合并。

**直播**

- 直播源按地址去重。
- 逐个下载直播源，检测能否解析出频道，失效的剔除。
- 频道内容完全相同的源只保留一个。
- 所有频道按播放地址去重后，合并进 `live.m3u`。`live.json` 的第一条就是这个合并列表，后面是各个直播源。

## 修改接口列表

编辑根目录的 `apilinks.txt`，每行格式为「名称, 地址1, 地址2 ...」。多个地址是镜像，按顺序自动选通。提交后，下次更新生效。

## 目录

- `apilinks.txt`：人工种子接口列表（78 条，含原项目全部 17 个地址）
- `config/upstreams.txt`：上游公开清单源（自动收集用）
- `config/liveupstreams.txt`：上游直播源清单
- `data/pool.json`：候选池（自动累积，记录每条地址的成功/失败次数）
- `聚合接口/`：每日生成的聚合文件
- `scripts/main.mjs`：入口（收集 → 抓取 → 探活测速 → 去重 → 分类输出，无第三方依赖，需 Node.js 18+）
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
