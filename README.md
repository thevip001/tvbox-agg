# 海量接口搬运备份站 · 聚合去重版

基于 [lubin776/tvbox-api-backup](https://github.com/lubin776/tvbox-api-backup) 的思路复刻并升级：原项目用 Python 脚本 + GitHub Actions 抓取 TVBox 接口并输出静态文件；本项目用 **Next.js (App Router) + PostgreSQL (Drizzle ORM)** 实现同样的备份能力，并新增了**点播接口全局整理去重**和**直播源三层整理去重**，最终提供两个可直接导入 TVBox 的聚合接口。

> 这不是纯静态页面：它是一个全栈网站，有服务端抓取任务、数据库、API 和前端管理界面。

## 功能

- **接口备份**：内置原项目的 49 条点播接口（同名多线合并为镜像）；启动时抓取一次，之后每 12 小时自动更新，也可在页面手动触发。
- **自动选通**：按镜像顺序重试，单个失败自动切换；每个接口保留最近一次成功配置，原站失效后仍可通过「备份线路」使用。
- **格式兼容**：图片套壳（`xxxxxxxx**base64`）、Base64、2423 开头的 AES-CBC 加密、带注释/写坏行的 JSON、多仓接口（`urls` / `storeHouse`）都能解析。
- **点播去重**：按 `type + api + ext` 判定重复站点，URL 比较忽略协议、www、结尾斜杠和 GitHub 代理前缀；key/name 冲突自动改名；按分类输出聚合配置。
- **采集站检测**：对 `type 0/1` 站点请求 `?ac=list` 做可用性检测，可按「仅可用」筛选聚合。
- **直播三层去重**：① 直播源 URL 规范化去重；② 下载后按频道地址集合哈希剔除内容完全相同的重复源；③ 所有频道按播放地址合并去重，输出单一 M3U/TXT。
- **完整前端**：点播 / 站点 / 直播 / 管理 / 关于面板，搜索、复制、接口列表编辑、任务日志。

## 聚合接口

把 `<域名>` 换成你部署后的地址：

| 用途 | 地址 |
| --- | --- |
| **点播聚合接口**（去重后全部站点） | `<域名>/vod.json` |
| 点播 · 仅可用 | `<域名>/api/vod?alive=1` |
| 点播 · 采集站 | `<域名>/api/vod?cat=cj&alive=1` |
| 点播 · Py 站 | `<域名>/api/vod?cat=py` |
| 点播 · JS 站 | `<域名>/api/vod?cat=js` |
| 点播 · Jar 爬虫站 | `<域名>/api/vod?cat=spider` |
| 点播 + 直播混编 | `<域名>/api/vod?alive=1&live=1` |
| **直播聚合接口**（TVBox 配置格式） | `<域名>/live.json` |
| 直播 · 合并去重频道 M3U | `<域名>/live.m3u` |
| 直播 · 合并去重频道 TXT | `<域名>/live.txt` |
| 单个接口的备份配置 | `<域名>/api/backup/<id>` |

`cat` 可选值：`all | cj | py | js | spider`；`alive=1` 只保留检测为可用的采集站；`live=1` 在点播配置里插入直播聚合源；`all=1`（仅 `/api/live`）连失效和重复直播源一起输出。所有接口均带 `Access-Control-Allow-Origin: *`。

## 本地运行

需要 Node.js 20+ 和 PostgreSQL。

```bash
npm install
cp .env.example .env      # 修改 DATABASE_URL
npx drizzle-kit push      # 创建表
npm run dev               # http://localhost:3000
```

首次打开页面会自动触发抓取任务（约 1~3 分钟），在「接口管理 → 更新任务日志」可看进度。也可以用 `curl -X POST http://localhost:3000/api/refresh` 手动触发。

生产环境：

```bash
npm run build
npm start
```

## 部署到 GitHub + Vercel

1. 在本目录执行：

   ```bash
   git init -b main
   git add .
   git commit -m "feat: TVBox 接口备份与点播/直播聚合去重"
   # 先在 GitHub 网页上创建一个空仓库，然后：
   git remote add origin https://github.com/<你的账号>/<仓库名>.git
   git push -u origin main
   ```

2. 到 [Vercel](https://vercel.com) 导入该仓库（Next.js 项目无需改构建命令）。
3. 在 Vercel 新建一个 Postgres 数据库（Neon/Supabase 也可以），把连接串填进环境变量 `DATABASE_URL`。
4. 首次部署完成后访问 `/api/refresh` 的 POST 或首页「立即更新」触发抓取；之后服务会每 12 小时自动更新。

> 如果部署平台不常驻（例如纯 GitHub Pages），则不能跑抓取任务。`scripts/export-static.mjs` 可以把已运行实例的聚合结果导出成静态文件，再放到 Pages：
>
> ```bash
> node scripts/export-static.mjs https://你的域名
> # 生成 export/ 目录（已加入 .gitignore）
> ```

## 目录结构

```
src/app/page.tsx                 前端入口
src/app/Dashboard.tsx            管理面板
src/app/api/vod/route.ts         点播聚合接口
src/app/api/live/route.ts        直播聚合接口
src/app/api/live/{m3u,txt}/      合并去重后的播放列表
src/app/api/backup/[id]/         单接口备份
src/app/api/{sources,data,refresh}/  配置与任务 API
src/lib/tvbox.ts                 抓取/解码/解析/去重工具
src/lib/refresh.ts               抓取与去重流水线
src/lib/aggregate.ts             聚合配置生成
src/lib/seed-sources.ts          原项目接口种子
src/db/schema.ts                 Drizzle 表定义
scripts/export-static.mjs        静态导出脚本
```

## 数据表

`sources`（接口与镜像）、`vod_sites`（去重点播站点）、`live_sources`（去重直播源）、`artifacts`（播放列表与统计）、`jobs`（任务日志）。

## 声明

接口资源来自互联网公开渠道，版权归原作者所有。仅供测试学习，请勿用于违法或商业用途，请勿付费购买；如涉及侵权请联系删除。
