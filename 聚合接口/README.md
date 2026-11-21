# 聚合接口（每日自动更新）

更新时间：2026-11-21 11:36（北京时间）

把下面地址直接填进 TVBox 即可。文件由 scripts/main.mjs 自动生成，请勿手改。

| 文件 | 内容 | 数量 | 地址 |
| --- | --- | --- | --- |
| 点播合集.json | 全部点播站点（已探活+去重，快站排前） | 4902 个站点 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json |
| 点播-采集站.json | 采集站（ac=list + ac=detail 双段检测） | 69 个 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json |
| 点播-Py站.json | Py 站（文件可访问性检测） | 299 个 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json |
| 点播-JS站.json | JS 站（主文件 + 规则文件双检） | 1603 个 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json |
| 点播-Jar爬虫站.json | Jar 爬虫站（jar 完整性 + ext 目标可达） | 2929 个 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json |
| live.json | 直播聚合 | 108 个直播源 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json |
| live.m3u | 直播频道（频道归一合并，每台 3 源） | 15247 个频道 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u |
| 剔除报告.json | 本次剔除明细与原因 | — | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/剔除报告.json |

## 本次过滤统计

| 项目 | 数量 |
| --- | --- |
| 候选接口 | 220 |
| 抓取成功 | 120 |
| 原始站点 → 去重后 | 15400 → 6156 |
| 剔除·失效 | 1214 |
| 剔除·太慢 | 0 |
| 剔除·本机引用 | 305 |
| 剔除·重复 | 9624 |
| 剔除·非直播内容 | 609878 |

策略：strictness=balanced，慢站阈值 TTFB>6s 或 吞吐<30KB/s
