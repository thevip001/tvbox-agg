# TVBox 接口每日聚合（tvbox-agg）

每天北京时间 04:00，GitHub Actions 自动抓取 `apilinks.txt` 里的 TVBox 接口，整理去重后，更新 `聚合接口/` 文件夹里的全部文件。

## 文件与地址

把对应地址直接填进 TVBox 即可。

| 文件 | 内容 | 地址 |
| --- | --- | --- |
| 点播合集.json | 全部点播站点合并去重（采集站、Py、JS、Jar 及其它类型） | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播合集.json |
| 点播-采集站.json | 点播 · 采集站（只保留检测可用的） | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-采集站.json |
| 点播-Py站.json | 点播 · Py 站 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Py站.json |
| 点播-JS站.json | 点播 · JS 站 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-JS站.json |
| 点播-Jar爬虫站.json | 点播 · Jar 爬虫站 | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/点播-Jar爬虫站.json |
| live.json | 直播聚合接口（TVBox 配置格式） | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.json |
| live.m3u | 直播频道合并去重（M3U） | https://raw.githubusercontent.com/thevip001/tvbox-agg/main/聚合接口/live.m3u |

`聚合接口/README.md` 里有同样的列表和每次更新的数量。

## 更新时间

- 每天北京时间 04:00 自动运行。原项目「接口处理扫描工具」在北京时间 03:00 更新，这里延后一个小时。
- 也可以在仓库的 Actions 页面，选择「每日更新聚合接口」→ Run workflow 手动运行。

## 去重规则

**点播**

- 同一个站点（type + api + ext 相同）只保留一个。比较时忽略协议、www、末尾斜杠和 GitHub 代理前缀的差异。
- 采集站（type 0/1）会请求 `?ac=list` 检测，失效的剔除。
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

- `apilinks.txt`：接口列表（以原项目 lubin776/tvbox-api-backup 的接口为基础）
- `聚合接口/`：每日生成的聚合文件
- `scripts/aggregate.mjs`：抓取、整理、去重脚本（无第三方依赖，需要 Node.js 18+）
- `.github/workflows/aggregate-daily.yml`：每日定时任务

## 声明

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习，请勿用于违法或商业用途，请勿付费购买；如涉及侵权请联系删除。
