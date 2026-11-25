# MisaTV Runtime Integration

状态：实施方案已确认；运行时执行器尚未接入生产流水线。

## 目标

将 MisaTV 的真实 Py / QuickJS / JAR 蜘蛛执行能力接入 `tvbox-agg` 的深度审计。主项目仍负责采集、探活、去重和生成聚合产物；运行时作为独立执行服务，通过 JSON Lines 输入/输出协议调用。

上游：
- MisaTV：<https://github.com/yagami-hue/MisaTV>
- 上游许可证：GPL-3.0，见上游 `LICENSE`
- 上游第三方组件清单：上游 `THIRD-PARTY-NOTICES.md`

## 已核实的上游实现

| 类型 | 上游实现 | 关键依赖/边界 |
| --- | --- | --- |
| Py | `assets/python_runner/runner.py`、`assets/python_runner/base/spider.py` | CPython 3.11 runner；`base.spider`、requests 等依赖；源可能还依赖顶层 spider ZIP 和其中的模块 |
| JS | `lib/services/js_spider/js_spider.dart`、`js_spider_worker.dart`、`js_bootstrap.dart` | QuickJS（上游依赖 `flutter_js`）；宿主 API、同步网络请求、模块加载、缓存和内置 JS 库不可省略 |
| JAR/DEX | `lib/services/jar_spider/jar_spider.dart`、`spider_host.dart` 及 JVM 相关实现 | JRE 17、dex2jar、SpiderHost/兼容桩；部分源依赖 Android API、JNI、原生库或加固壳桥接，普通 JVM 不能等价验证 |

注意：MisaTV 是 Flutter 应用，不是现成的无界面 CLI SDK。不能简单复制三个文件或用 Node.js/V8、普通 CPython、普通 JVM 冒充上游运行时。接入前必须把宿主 API、资源加载、网络、缓存、扩展包依赖及进程生命周期一起纳入适配。

## 许可证与分发规则

1. MisaTV 本体为 GPL-3.0。复制或修改其代码时，保留版权/许可证声明，标注修改及日期，并按 GPL-3.0 提供对应源码。
2. 上游 `THIRD-PARTY-NOTICES.md` 明确区分 GPL 本体代码、自建运行时代码、MIT/Apache 等第三方依赖、按需下载的 JRE/CPython/dex2jar 等组件。不得把所有依赖都笼统标成 GPL；每个随包/下载组件都要保留准确许可和 NOTICE。
3. 当前方案不把 MisaTV Flutter UI、播放器、网盘、直播等无关功能整体搬入聚合器。仅适配审计必需的运行时部分，并保留其来源与许可证。
4. 运行时作为独立目录/进程发布，主程序以 JSONL 调用；这有利于保持模块边界，但进程拆分本身不是 GPL 规避保证。若代码实际构成一个组合/衍生程序，应按 GPL-3.0 履行整体义务。
5. 若未来对外分发包含 GPL 运行时的二进制/容器/安装包，必须同时提供对应源码、构建/安装脚本、许可证文本和清晰源码获取方式。仅在自有 CI/服务器内部运行，与向外分发是不同场景。

## 运行协议（拟定）

每条输入一行 JSON；每条输出一行 JSON，禁止把日志写入 stdout。

输入字段：
- `id`：请求 ID
- `kind`：`py`、`js` 或 `jar`
- `api`、`ext`、`jar`、`spider`：站点配置中原始字段
- `method`：首轮至少执行 `homeContent` / 上游对应的 `home`
- `timeoutMs`：单次执行上限
- `resources`：允许加载的站点依赖/扩展资源

输出字段：
- `id`、`ok`、`status`、`runtime`、`runtimeVersion`
- `data`：运行时返回的 JSON 内容（不在这里执行播放）
- `errorType`、`error`、`durationMs`
- `network`：请求数量、HTTP 状态摘要；不记录 Cookie、Authorization 等敏感值

## 审计状态

| 状态 | 含义 | 是否据此删除源 |
| --- | --- | --- |
| `runtime-home` | 指定运行时真实执行首页成功，至少有内容或分类 | 否，作为可运行证据 |
| `runtime-empty` | 代码成功执行，但首页没有内容和分类 | 进入待确认，不直接当网络死源 |
| `runtime-error` | 规则加载/初始化/方法调用抛错 | 仅在可重复、明确属于规则错误时才考虑剔除 |
| `runtime-unsupported` | Android API、JNI、原生库或上游宿主能力不支持 | 不删除 |
| `runtime-uncertain` | 超时、限流、403/429/5xx、网络抖动 | 不删除 |
| `static-only` | 只通过静态规则检查，尚未真实执行 | 不得标记为运行时通过 |

## 安全边界（上线前必须具备）

第三方蜘蛛是任意代码，不是可信配置。执行环境必须：
- 每个任务在短生命周期容器/沙箱内运行，非 root；
- 只读根文件系统，临时工作目录单独挂载；
- 禁止特权、丢弃 Linux capabilities、启用 no-new-privileges；
- 限制 CPU、内存、PID、文件大小、输出大小和执行时间；
- 不注入 GitHub Token、仓库写权限凭据、数据库密码或其他 Secrets；
- 网络请求经受控代理层；阻止访问云元数据、内网管理地址、localhost 和私有网段，避免 SSRF；
- 运行时进程与 Node 聚合器隔离，日志与结果分流。

在隔离能力未验证前，不得在定时 CI 中执行任意第三方源；先使用仓库内固定 fixture 做回归测试。

## 分阶段实施

1. **基线与许可**：锁定 MisaTV commit、保存上游许可证/NOTICE、生成依赖许可证清单和来源记录。
2. **Py runner**：先实现 CPython runner 的隔离调用，覆盖普通单文件源和带顶层 spider ZIP 的源。
3. **QuickJS runner**：适配上游 QuickJS 与完整宿主 API；不能用 Node/V8 替代。
4. **JAR runner**：复用 SpiderHost/JRE/dex2jar；对 Android/JNI/原生依赖明确返回 `runtime-unsupported`。
5. **fixture 测试**：每种类型加入成功、空结果、异常、超时、依赖缺失和恶意访问拦截样例。
6. **聚合器接入**：将运行时结果写入 health/auditModes；默认不因 unsupported/uncertain 删除源。
7. **小流量影子运行**：先对少量样本执行，只记录结果，不改变产物；验证稳定后再讨论正式启用。

## 当前生产策略

在运行时执行器和沙箱完成前，现有深度审计继续标记为 `static-rule-target`。不得把现有静态 JS/Py/JAR 检查升级成 `runtime-home`，也不得在 CI 中执行未隔离的第三方脚本。
