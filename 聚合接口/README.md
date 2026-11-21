# 聚合接口（每日自动更新）

**更新时间**：2026-11-22 04:44（北京时间）　**策略**：严格（只留快站，慢站也删）

## 📊 站点数量总览

| 分类 | 输出站点数 | 文件 |
| --- | ---: | --- |
| **点播合集（全部）** | **1681** | [点播合集.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json) |
| 　采集站 | 27 | [点播-采集站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json) |
| 　Py 站 | 69 | [点播-Py站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json) |
| 　JS 站 | 404 | [点播-JS站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json) |
| 　Jar 爬虫站 | 1180 | [点播-Jar爬虫站.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json) |
| 　其它 | 1 | 包含在合集内 |
| **直播源** | **43** | [live.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json) |
| **直播频道** | **5199** | [live.m3u](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u) |

> 以上 1681 个点播站点全部通过存活检测与测速筛选（慢站已剔除），按实测速度排序，快的在前。

## 🔍 本轮过滤明细

| 环节 | 数量 | 说明 |
| --- | ---: | --- |
| 候选接口 | 600 | 从收集池挑选 |
| 接口抓取成功 | 50 | 含多仓递归 |
| 原始站点 | 8303 | 抓到的全部条目 |
| 去重后 | 2479 | 去掉 6039 条重复 |
| 　├ 剔除·失效 | 727 | 连不上/内容异常 |
| 　├ 剔除·太慢 | 54 | 首字节超阈值（已实测） |
| 　├ 剔除·本机引用 | 101 | 127.0.0.1 等 |
| 　└ 剔除·非直播内容 | 60921 | 直播侧，MV/点歌台等 |
| **最终输出** | **1681** | |

### 速度分档（探活结果）

| 档位 | 数量 | 处理 |
| --- | ---: | --- |
| 🟢 精选（TTFB≤300ms） | 1154 | 保留，排最前 |
| 🔵 正常（300<TTFB≤1500ms） | 299 | 保留 |
| 🟡 偏慢（TTFB>1500ms） | 54 | **已剔除** |
| 🟠 测不准（限流/403） | 245 | 保留（下轮重测） |
| ⚪ 未测到（本轮预算用尽） | 0 | 保留（下轮补测） |
| 🔴 失效 | 727 | 已剔除 |

> 判定阈值（只看首字节，故意不看吞吐）：普通站 TTFB>1500ms 判慢，内置爬虫站（csp_*）放宽到 3000ms —— 内置站测的是目标站首页，HTML 更重。
> 不看吞吐的原因：接口本身就是几十 KB 的 JSON/脚本，KB/s 低只代表文件小，点开几乎秒开；按吞吐会把 TTFB 一两百毫秒的健康站误删。

## 📁 剔除报告

完整明细见 [剔除报告.json](https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/剔除报告.json)：每条被删站点都记录了名称、地址、原因和实测速度，方便你抽查有没有误杀。

---

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习。
