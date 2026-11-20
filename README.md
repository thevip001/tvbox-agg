# 海量接口搬运备份站 · 聚合去重版

基于 [lubin776/tvbox-api-backup](https://github.com/lubin776/tvbox-api-backup) 的思路复刻并升级。原项目用 Python 脚本 + GitHub Actions 抓取 TVBox 接口并生成静态文件；本项目改用 **Next.js (App Router) + PostgreSQL (Drizzle ORM)** 实现同样的备份，并新增**点播接口全局去重**和**直播源三层去重**，最终输出两个可直接导入 TVBox 的聚合接口。

> 这是一个全栈网站（服务端抓取任务 + 数据库 + API + 管理页面），不是纯静态页面。

## 📦 下载源码

- 网站首页右上角点击 **「📦 下载源码」**，或直接访问 `<域名>/downloads/tvbox-agg.zip`。
- 压缩包包含完整源码和 `.git` 提交记录，**不包含** `.env`（数据库配置）和 `node_modules`。

## 推送到你自己的 GitHub 仓库

1. 解压 `tvbox-agg.zip`，进入 `tvbox-agg/` 目录。
2. 在 GitHub 网页上新建一个**空仓库**（不要勾选 README、.gitignore、License）。
3. 在该目录执行：

   ```bash
   git remote add origin https://github.com/<你的账号>/<仓库名>.git
   git push -u origin main
   ```

如果解压后没有 `.git` 目录（比如只复制了文件），先执行 `git init -b main && git add . && git commit -m "init"`，再执行第 3 步。

推送前可选：把提交作者改成你自己的身份。

```bash
git config user.name "你的名字"
git config user.email "你的邮箱"
git commit --amend --reset-author --no-edit
```

## 本地运行

需要 Node.js 20+ 和 PostgreSQL。

```bash
npm install
cp .env.example .env     # 修改其中的 DATABASE_URL
npx drizzle-kit push     # 创建数据表
npm run dev              # 打开 http://localhost:3000
```

首次启动时（数据库里还没有抓取记录），服务会在约 15 秒后自动开始抓取，大约需要 2~3 分钟。进度见「⚙️ 接口管理」页的任务日志。也可以手动触发：

```bash
curl -X POST http://localhost:3000/api/refresh
```

生产运行：`npm run build && npm start`。

## 聚合接口

把 `<域名>` 换成你部署后的地址：

| 用途 | 地址 |
| --- | --- |
| **点播聚合接口**（去重后全部站点） | `<域名>/vod.json` |
| 点播 · 去掉已检测失效的站点 | `<域名>/api/vod?alive=1` |
| 点播 · 采集站 | `<域名>/api/vod?cat=cj&alive=1` |
| 点播 · Py 站 | `<域名>/api/vod?cat=py` |
| 点播 · JS 站 | `<域名>/api/vod?cat=js` |
| 点播 · Jar 爬虫站 | `<域名>/api/vod?cat=spider` |
| 点播 + 直播混编 | `<域名>/api/vod?alive=1&live=1` |
| **直播聚合接口**（TVBox 配置格式） | `<域名>/live.json` |
| 直播 · 合并去重频道 M3U | `<域名>/live.m3u` |
| 直播 · 合并去重频道 TXT | `<域名>/live.txt` |
| 单个接口的备份配置 | `<域名>/api/backup/<id>` |

`cat` 可选值：`all | cj | py | js | spider`。`alive=1` 会去掉已检测为失效的站点（目前只对采集站做可用性检测）；`live=1` 会在点播配置里插入直播聚合源；`/api/live?all=1` 会把失效和重复的直播源也一起输出。聚合接口均带 CORS 头（`Access-Control-Allow-Origin: *`）。

## 部署

抓取任务每次要运行几分钟，而且服务需要每 12 小时自动更新一次，所以要部署到**常驻运行**的 Node.js 环境，例如：

- VPS（配合 pm2 或 systemd）；
- Docker；
- Railway / Render / Fly.io 等支持长时间运行的平台。

部署时设置环境变量 `DATABASE_URL`，指向 PostgreSQL。

> 不建议部署到 Vercel 这类 Serverless 平台：函数有执行时长限制，抓取任务无法完整跑完，自动更新也不会生效。

## 静态导出（可选）

已经运行的实例可以导出成静态文件，方便放到 GitHub Pages 作为镜像：

```bash
node scripts/export-static.mjs https://你的域名
```

结果输出到 `export/` 目录（已加入 `.gitignore`）。

## 目录结构

```
src/app/page.tsx                     前端入口
src/app/Dashboard.tsx                管理面板（聚合接口 / 点播 / 站点 / 直播 / 管理 / 关于）
src/app/api/vod/route.ts             点播聚合接口
src/app/api/live/route.ts            直播聚合接口
src/app/api/live/{m3u,txt}/          合并去重后的播放列表
src/app/api/backup/[id]/             单个接口的备份配置
src/app/api/{sources,data,refresh}/  接口配置、页面数据、抓取任务
src/lib/tvbox.ts                     抓取 / 解码 / 解析 / 去重工具
src/lib/refresh.ts                   抓取与去重流水线
src/lib/aggregate.ts                 聚合配置生成
src/lib/scheduler.ts                 定时更新（每 12 小时）
src/lib/seed-sources.ts              原项目接口种子（49 条）
src/db/schema.ts                     Drizzle 数据表定义
scripts/export-static.mjs            静态导出脚本
```

## 数据表

- `sources`：接口与镜像线路，以及最近一次成功的备份配置
- `vod_sites`：去重后的点播站点
- `live_sources`：去重后的直播源
- `artifacts`：合并播放列表与统计数据
- `jobs`：抓取任务与日志

## 声明

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习，请勿用于违法或商业用途，请勿付费购买；如涉及侵权，请联系删除。
