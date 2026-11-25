# MisaTV Runtime Integration

状态：Py 和桌面 JVM JAR 已加入隔离执行器及仓库自有 fixture；JS 仍 unsupported。运行时结果尚未接入每日聚合删源决策。CI 必须实际构建并执行 fixture，不能仅凭代码存在宣称通过。

## 能力边界

| 类型 | 实际执行能力 | 限制 |
| --- | --- | --- |
| Py | vendored MisaTV CPython 3.11 runner + base.spider，真实调用 homeContent | 当前禁网；不自动下载任意 spider ZIP / pip 依赖 |
| JAR | MisaTV 桌面 OpenJDK 17 SpiderHost + stubs/shims，真实加载 JAR 类并调用 homeContent(boolean) | 仅普通 JVM 兼容 JAR；DEX/ART、JNI、加固壳和依赖 Android 原生能力的载荷不保证支持；当前禁网 |
| JS | — | unsupported；需要 QuickJS 与 Flutter native host bridge，Node/V8 不等价 |

## Py

上游来源：<https://github.com/yagami-hue/MisaTV>。保留 GPL-3.0 LICENSE 和来源 NOTICE。

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
node scripts/runtime-check.mjs --kind py --source ./site.py --class Spider --ext ''
```

Docker sandbox 使用非 root、无网络、只读根文件系统、丢弃 capabilities、no-new-privileges、CPU/内存/PID 限制。当前可以验证 Python 解释器、runner、模块初始化及离线首页逻辑；在线站源会因网络被禁而返回 uncertain，不得判死。未自动下载配置引用的 spider ZIP 或任意 pip 包。

## JAR

JVM runner 使用固定 MisaTV commit `fd0106a9d1a450d46925ccb8cf47feef3acf6350` 的 `spider-host.jar`、`stubs.jar`、相关 shim，并按 MisaTV 桌面端依赖版本构建 OpenJDK 17 镜像。Docker build 同时编译仓库自有 Java fixture；执行器通过 SpiderHost 反射加载类并调用 `homeContent(boolean)`。

```sh
docker build -t tvbox-agg/misa-jar:17 runtime/misa-jar
node scripts/runtime-check.mjs --kind jar --source ./spider.jar --class com.example.spider.Site
```

CI fixture 使用镜像内置的测试 JAR：

```sh
node scripts/runtime-check.mjs --kind jar --fixture --class com.github.catvod.spider.RuntimeFixture
```

该路径是真实 JVM + MisaTV SpiderHost 执行，不是仅扫描 class 名。但它不等同 Android ART，也不能保证执行依赖 JNI、DEX 动态加载、特定 Android 系统服务或加固壳解密链的 JAR。沙箱禁网，因此需要联网的 spider 只能得到网络受限/不确定。

## JS

MisaTV JS 依赖 QuickJS、bootstrap、同步 `sendMessage`、网络/模块/local/hash/base64 native channels 和内置 JS 库。当前适配器明确返回 `runtime-unsupported`，没有用 Node/V8 伪装为 QuickJS。必须移植或构建真实 QuickJS host bridge 后才可启用。

## 安全与生产策略

第三方脚本不接触 GitHub Secrets 或仓库写权限。固定 fixture 不访问公网、不执行采集到的任意第三方源。Py/JAR 每次执行都在独立 Docker 容器中，`--network=none`、只读 rootfs、非 root、capabilities 全丢弃、no-new-privileges、CPU/内存/PID 限制。

`runtime-home` 只表示该隔离环境中真实调用首页方法并得到非空结构；不代表源的外网接口在生产网络可用。timeout、network-blocked、unsupported 和 uncertain 均不得作为删源信号。此 PR 不改变正式聚合产物。
