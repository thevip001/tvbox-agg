# 聚合接口（每日自动更新）

<<<<<<< Updated upstream
**更新时间**：2026-11-21 15:01（北京时间）　**策略**：严格（只留快站，慢站也删）
=======
**更新时间**：2026-11-21 15:21（北京时间）　**策略**：严格（只留快站，慢站也删）
>>>>>>> Stashed changes

## 📊 站点数量总览

| 分类 | 输出站点数 | 文件 |
| --- | ---: | --- |
<<<<<<< Updated upstream
| **点播合集（全部）** | **4741** | [点播合集.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json) |
| 　采集站 | 69 | [点播-采集站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json) |
| 　Py 站 | 363 | [点播-Py站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json) |
| 　JS 站 | 1547 | [点播-JS站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json) |
| 　Jar 爬虫站 | 2760 | [点播-Jar爬虫站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json) |
| 　其它 | 2 | 包含在合集内 |
| **直播源** | **82** | [live.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json) |
| **直播频道** | **12466** | [live.m3u](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u) |

> 以上 4741 个点播站点全部通过存活检测与测速筛选（慢站已剔除），按实测速度排序，快的在前。
=======
| **点播合集（全部）** | **4810** | [点播合集.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json) |
| 　采集站 | 69 | [点播-采集站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json) |
| 　Py 站 | 363 | [点播-Py站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json) |
| 　JS 站 | 1541 | [点播-JS站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json) |
| 　Jar 爬虫站 | 2834 | [点播-Jar爬虫站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json) |
| 　其它 | 3 | 包含在合集内 |
| **直播源** | **83** | [live.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json) |
| **直播频道** | **13419** | [live.m3u](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u) |

> 以上 4810 个点播站点全部通过存活检测与测速筛选（慢站已剔除），按实测速度排序，快的在前。
>>>>>>> Stashed changes

## 🔍 本轮过滤明细

| 环节 | 数量 | 说明 |
| --- | ---: | --- |
| 候选接口 | 600 | 从收集池挑选 |
<<<<<<< Updated upstream
| 接口抓取成功 | 147 | 含多仓递归 |
| 原始站点 | 21136 | 抓到的全部条目 |
| 去重后 | 6432 | 去掉 15383 条重复 |
| 　├ 剔除·失效 | 1571 | 连不上/内容异常 |
| 　├ 剔除·太慢 | 73 | 首字节超阈值（已实测） |
| 　├ 剔除·本机引用 | 348 | 127.0.0.1 等 |
| 　└ 剔除·非直播内容 | 94775 | 直播侧，MV/点歌台等 |
| **最终输出** | **4741** | |
=======
| 接口抓取成功 | 146 | 含多仓递归 |
| 原始站点 | 21108 | 抓到的全部条目 |
| 去重后 | 6411 | 去掉 15374 条重复 |
| 　├ 剔除·失效 | 1476 | 连不上/内容异常 |
| 　├ 剔除·太慢 | 77 | 首字节超阈值（已实测） |
| 　├ 剔除·本机引用 | 348 | 127.0.0.1 等 |
| 　└ 剔除·非直播内容 | 439324 | 直播侧，MV/点歌台等 |
| **最终输出** | **4810** | |
>>>>>>> Stashed changes

### 速度分档（探活结果）

| 档位 | 数量 | 处理 |
| --- | ---: | --- |
<<<<<<< Updated upstream
| 🟢 精选（TTFB≤300ms） | 3748 | 保留，排最前 |
| 🔵 正常（300<TTFB≤1500ms） | 617 | 保留 |
| 🟡 偏慢（TTFB>1500ms） | 73 | **已剔除** |
| 🟠 测不准（限流/403） | 423 | 保留（下轮重测） |
| ⚪ 未测到（本轮预算用尽） | 0 | 保留（下轮补测） |
| 🔴 失效 | 1571 | 已剔除 |
=======
| 🟢 精选（TTFB≤300ms） | 3418 | 保留，排最前 |
| 🔵 正常（300<TTFB≤1500ms） | 1098 | 保留 |
| 🟡 偏慢（TTFB>1500ms） | 77 | **已剔除** |
| 🟠 测不准（限流/403） | 342 | 保留（下轮重测） |
| ⚪ 未测到（本轮预算用尽） | 0 | 保留（下轮补测） |
| 🔴 失效 | 1476 | 已剔除 |
>>>>>>> Stashed changes

> 判定阈值（只看首字节，故意不看吞吐）：普通站 TTFB>1500ms 判慢，内置爬虫站（csp_*）放宽到 3000ms —— 内置站测的是目标站首页，HTML 更重。
> 不看吞吐的原因：接口本身就是几十 KB 的 JSON/脚本，KB/s 低只代表文件小，点开几乎秒开；按吞吐会把 TTFB 一两百毫秒的健康站误删。

## 📁 剔除报告

完整明细见 [剔除报告.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/剔除报告.json)：每条被删站点都记录了名称、地址、原因和实测速度，方便你抽查有没有误杀。

---

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习。
