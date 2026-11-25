# MisaTV Runtime Integration

状态：Py、QuickJS JS、桌面 JVM JAR 均已接入隔离执行器，并有仓库自有 fixture 的 CI 实际执行测试。当前运行时结果尚未接入每日聚合删源决策。

## 能力与限制

| 类型 | 实际执行能力 | 限制 |
| --- | --- | --- |
| Py | MisaTV CPython 3.11 runner + base.spider；支持单文件和受限 ZIP bundle，真实调用 homeContent | ZIP 内随附的纯 Python 模块可导入；不会安装任意 pip 包；HTTP/HTTPS 仅经受控网关 |
| JS | QuickJS 引擎 + MisaTV 原版 spiderJsBootstrap；执行 home/homeContent，接入 sendMessage、local、MD5/SHA1/SHA256、Base64 通道 | 不是 Flutter flutter_js 二进制构建；已移植 MisaTV 的受限 regex transformToCjs 并捆绑其 JS 库；不支持的残留 ESM 声明（如 export class）及 export * from 均明确返回 unsupported；远程模块仍禁用；HTTP 请求经受控网关 |
| JAR | MisaTV 桌面 OpenJDK 17 SpiderHost + stubs/shims，真实加载普通 JVM JAR 并调用 homeContent(boolean) | 不等同 Android ART；DEX/JNI/加固壳/依赖原生 Android 服务的载荷不保证支持；HTTP/HTTPS 经 JVM 代理属性接入受控网关 |

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

执行引擎使用 QuickJS Python binding（不是 Node/V8），并 vendored 固定 MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350` 的 `spiderJsBootstrap` 原始 JS。Bootstrap 负责蜘蛛对象发现、init、home/homeContent 调用与 Promise 结果封装；Python native bridge 提供 local、hash、base64。网络请求由宿主桥发起并使用运行时注入的 HTTP(S) 代理；远程模块仍禁用。

已按 MisaTV 的 `esm_transform.dart` 移植受限正则 ESM→CJS 转换器，并捆绑 MisaTV 的 `cat.js`、`cheerio.min.js`、`crypto-js.js`、`gbk.js`、`net.js`、`similarity.js`、`utils.js`、`模板.js`。支持常见 import/export、default export、named export 和 CommonJS/global 规则；转换器未覆盖的残留 ESM 声明（例如 `export class Spider`）以及 `export * from` 会明确返回 `runtime-unsupported`，不再伪装成普通语法运行错误。本地内置模块由宿主桥加载；远程模块仍禁用。`req/http/_http` 的网络调用通过 HTTP(S) 代理进入受控网关。

## JAR

```sh
docker build -t tvbox-agg/misa-jar:17 runtime/misa-jar
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site
```

JVM runner 使用固定 MisaTV commit 的 `spider-host.jar`、`stubs.jar` 和 shim，在 OpenJDK 17 中由 SpiderHost 反射加载类并执行首页方法。CI 构建自有 Java fixture JAR，通过真实 SpiderHost 调用。

## 安全与生产策略

运行时容器使用每次检测独立的 Docker `--internal` 网络；只有受控网关同时连接该内部网络和外部 bridge，爬虫容器没有直接外网/LAN 路由。网关仅允许 HTTP/HTTPS（TCP 80/443），对目标 DNS 的全部解析结果执行公网 IP 校验，并连接已校验的数值 IP，阻止 DNS rebinding；拒绝私网、环回、链路本地、保留和组播地址，限制请求头、请求体、连接时长和转发字节数。网关自身只读、非 root、无 capabilities。运行时容器仍只读 rootfs、非 root、capabilities 全丢弃、no-new-privileges，并设置 CPU/内存/PID/文件大小限制。第三方脚本不接触 GitHub Secrets 或仓库写权限。

`runtime-home` 表示在隔离环境中真实执行首页方法并返回非空结构；使用受控网关时可以实际请求公网 API，但仍不等于所有站点都已被完整验证。网关拒绝的目标或连接失败应按网络不确定处理。timeout、network-blocked、unsupported 和 uncertain 均不得作为删源信号。此 PR 不改变正式聚合产物。


## 受控联网网关

```sh
node scripts/runtime-check.mjs --kind py --source ./site.py --allow-hosts api.example.com,cdn.example.com
node scripts/runtime-check.mjs --kind js --source ./rule.js --api https://api.example.com --allow-hosts cdn.example.com
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site --allow-hosts api.example.com,cdn.example.com
```

CI 还会分别通过 Py requests、QuickJS 的 MisaTV `req()`、JVM `HttpURLConnection` 请求 `https://example.com/`，验证三种运行时的 HTTPS 代理链路确实可用；同时运行内网/特殊用途 IP、混合 DNS 答案和 DNS 解析后固定 IP 连接的安全测试。

`runtime-check.mjs` 为每次探测创建唯一的 Docker 内部网络和临时网关容器。Py requests/urllib、JS MisaTV `req/http/_http` 及 JVM HTTP(S) 代理属性均使用该网关。运行时容器本身无法绕过代理直接出网；网关拒绝非公网 DNS 结果和非 80/443 端口，HTTPS 使用 CONNECT 隧道。网关不是域名白名单：它允许公网 HTTP(S)，但阻止访问私网和本机服务。需要更严格的站点域名白名单时，应由调用方增加允许域名策略。
