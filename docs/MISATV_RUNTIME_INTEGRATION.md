# MisaTV Runtime Integration

状态：Py、QuickJS JS、桌面 JVM JAR 均已接入隔离执行器，并有仓库自有 fixture 的 CI 实际执行测试。当前运行时结果尚未接入每日聚合删源决策。

## 能力与限制

| 类型 | 实际执行能力 | 限制 |
| --- | --- | --- |
| Py | MisaTV CPython 3.11 runner + base.spider；支持单文件和受限 ZIP bundle，真实调用 homeContent | ZIP 内随附的纯 Python 模块可导入；不会安装任意 pip 包；禁网 |
| JS | QuickJS 引擎 + MisaTV 原版 spiderJsBootstrap；执行 home/homeContent，接入 sendMessage、local、MD5/SHA1/SHA256、Base64 通道 | 不是 Flutter flutter_js 二进制构建；已移植 MisaTV 的受限 regex transformToCjs 并捆绑其 JS 库；export * from 等不支持语法仍返回 unsupported；远程模块和 HTTP 请求禁用 |
| JAR | MisaTV 桌面 OpenJDK 17 SpiderHost + stubs/shims，真实加载普通 JVM JAR 并调用 homeContent(boolean) | 不等同 Android ART；DEX/JNI/加固壳/依赖原生 Android 服务的载荷不保证支持；禁网 |

## Py

上游 runner 和 base.spider 来源为 <https://github.com/yagami-hue/MisaTV>，保留 GPL-3.0 LICENSE 与 NOTICE。

单文件：

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
node scripts/runtime-check.mjs --kind py --source ./site.py --class Spider --ext ''
```

ZIP bundle（默认入口 0.py，可用 --entry 指定）：

```sh
node scripts/runtime-check.mjs --kind py --archive ./spider.zip --entry 0.py --class Spider --ext '{}'
```

ZIP 在无网络容器内解压，限制压缩包 10 MiB、解压总量 32 MiB、文件数 2000，拒绝路径穿越和符号链接。ZIP 中的 Python 模块可作为同目录依赖导入；不会对不可信包执行 pip install。缺失第三方依赖时应返回运行错误/不确定，不能判定源死亡。

## JS / QuickJS

```sh
docker build -t tvbox-agg/misa-js:quickjs runtime/misa-js
node scripts/runtime-check.mjs --kind js --source ./rule.js --api https://example.invalid/drpy2.min.js --ext '{}'
```

执行引擎使用 QuickJS Python binding（不是 Node/V8），并 vendored 固定 MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350` 的 `spiderJsBootstrap` 原始 JS。Bootstrap 负责蜘蛛对象发现、init、home/homeContent 调用与 Promise 结果封装；Python native bridge 提供 local、hash、base64。网络与模块请求由隔离宿主明确阻断，避免任意第三方代码访问内网/云 metadata。

已按 MisaTV 的 `esm_transform.dart` 移植受限正则 ESM→CJS 转换器，并捆绑 MisaTV 的 `cat.js`、`cheerio.min.js`、`crypto-js.js`、`gbk.js`、`net.js`、`similarity.js`、`utils.js`、`模板.js`。支持常见 import/export、default export、named export 和 CommonJS/global 规则；`export * from` 等上游明确不支持的形式返回 `runtime-unsupported`。本地内置模块由宿主桥加载；远程模块与 HTTP 请求仍禁用。

## JAR

```sh
docker build -t tvbox-agg/misa-jar:17 runtime/misa-jar
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site
```

JVM runner 使用固定 MisaTV commit 的 `spider-host.jar`、`stubs.jar` 和 shim，在 OpenJDK 17 中由 SpiderHost 反射加载类并执行首页方法。CI 构建自有 Java fixture JAR，通过真实 SpiderHost 调用。

## 安全与生产策略

所有运行时 Docker 容器禁网、只读 rootfs、非 root、capabilities 全丢弃、no-new-privileges，并设置 CPU/内存/PID/文件大小限制。第三方脚本不接触 GitHub Secrets 或仓库写权限。

`runtime-home` 只表示固定隔离环境中真实执行首页方法并返回非空结构，不代表源站外网 API 可用。timeout、network-blocked、unsupported 和 uncertain 均不得作为删源信号。此 PR 不改变正式聚合产物。
