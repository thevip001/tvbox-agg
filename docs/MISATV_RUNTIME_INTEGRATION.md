# MisaTV Runtime Integration

状态：**Py 的隔离运行时执行器已接入并有离线 fixture；JS 与 JAR 仍明确 unsupported。三类运行时尚未全部完成，生产流水线未启用运行时剔除。**

## 当前实现

| 类型 | 实际执行能力 | 状态 |
| --- | --- | --- |
| Py | vendored MisaTV CPython 3.11 `runner.py` + `base.spider`，Docker 隔离执行 `homeContent` | 已实现离线执行器；真实网络源需要安全出口代理，当前 sandbox 禁网 |
| JS | MisaTV QuickJS + `flutter_js` + `js_bootstrap` + native bridge | unsupported；Node/V8 不等价 |
| JAR/DEX | MisaTV SpiderHost + Android/JVM bridge | unsupported；仅检查 dex/class 不算实际执行 |

## Py 执行器

上游来源：<https://github.com/yagami-hue/MisaTV>。本仓库保留上游 GPL-3.0 LICENSE，并在 `runtime/misa-py/NOTICE.md` 标明 vendored 文件。

构建镜像：

```sh
docker build -t tvbox-agg/misa-py:3.11 runtime/misa-py
```

执行本地规则：

```sh
node scripts/runtime-check.mjs --kind py --source ./path/to/site.py --class Spider --ext ''
```

输出为单行 JSON，状态包括 `runtime-home`、`runtime-empty`、`runtime-error`。执行使用 CPython 3.11、MisaTV runner 与 Spider 基类，调用 `homeContent`。

### 安全边界

每个探针运行在独立 Docker 容器：非 root、`--network=none`、只读根文件系统、无 Linux capabilities、no-new-privileges、CPU/内存/PID 限制、只读脚本挂载。没有 GitHub token 或任何仓库 secrets。

**禁网是有意设计，不是功能遗漏。** 任意第三方 Python 蜘蛛等同于不可信代码。当前执行器可以真实验证解释器、模块加载、初始化和不依赖网络的首页逻辑；如果源必须联网，失败只能作为沙箱网络限制/不确定，不能据此判死。要验证在线源，必须另行部署受控出站代理，并在网络层阻断 loopback、RFC1918、链路本地、云元数据地址及 DNS rebinding；不能简单改成 Docker bridge/host 网络。

### Py 支持边界

- 支持单文件脚本和 MisaTV `base.spider` 常用 API。
- 不自动下载站点配置中的外部 spider ZIP、任意 pip 包或动态依赖。
- 依赖额外 ZIP、私有文件、运行时安装包的源会失败或需要显式打包依赖。
- 目前只调用 `homeContent`，不执行播放代理或持久服务模式。

## JS / JAR 为什么不冒充通过

MisaTV JS 执行不仅是 QuickJS 引擎，还依赖 bootstrap、同步网络 `sendMessage`、模块加载、缓存和内置 JS 库。当前项目没有等价的 Flutter/QuickJS 宿主桥。使用 Node.js `vm` 或 V8 执行会产生假阳性，因此 adapter 返回 `runtime-unsupported`。

MisaTV JAR 需要 SpiderHost、Android API、JVM/ART 桥接及可能的 JNI/原生库。普通 JVM 或 dex 类名存在检查不能证明首页方法可执行，因此 adapter 返回 `runtime-unsupported`。

## 测试

GitHub Actions `.github/workflows/misa-runtime.yml`：
1. 构建 Py Docker 镜像；
2. 在无网络沙箱中执行仓库固定 fixture，必须得到 `runtime-home`；
3. 检查 JS/JAR adapter 只能返回 `runtime-unsupported`，不得伪装成功。

固定 fixture 不访问公网，不会运行仓库收集到的真实第三方源。

## 生产策略

该执行器尚未接入每日聚合的删源决策。当前静态审计仍保留原有状态，Py 在线网络探测、JS QuickJS 宿主桥和 JAR Android Host 尚未完成前，不能据此改变正式产物。任何 `runtime-unsupported`、沙箱网络阻断或超时均不得视为源失效。
