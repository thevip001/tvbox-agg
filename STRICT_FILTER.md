# 源审计策略（MisaTV home 口径）

## 核心判定

### CMS（type 0/1/4）：运行时主页审计语义

复刻 MisaTV `CmsSource.home()` + `SourceHealth.fromHome()`：

1. 原样请求 `site.api`，不擅自拼接 `ac=list`。
2. 解析主页返回的影视条目和分类。
3. 主页没有条目但有分类时，按类型请求第一个分类第一页：
   - type 0：`ac=videolist&t=<首分类>&pg=1`
   - 其它 CMS：`ac=detail&t=<首分类>&pg=1`
4. 主页/回退拿到条目 → `ok-content`。
5. 有分类但暂时没有条目 → `ok-classes`，保留；与 MisaTV 一致，不能把「无推荐」当成失效。
6. 既无条目也无分类 → `empty`，剔除。
7. 搜索不作为删源门槛。搜索接口可能不支持、关键词可能不匹配，不等于主页不可用。

### Py / JS / Jar：静态规则审计

Node.js 聚合流水线没有 MisaTV 的 Android/Flutter 运行时，不能声称已执行蜘蛛的真实 `home()`。因此采用可复现的静态能力审计，并明确标注审计模式：

- Py：检查远程脚本包含 `class Spider` 与 home/search 入口，抽取规则目标并探测目标站。
- JS：检查规则结构、加载的 ext 子资源和规则目标站。
- Jar：检查最终生效 jar 的 ZIP/dex 与 `csp_*` 类名，校验 ext 规则和目标站；可从同批 jar 中修复缺类引用。
- `ok-target` 只表示规则结构/类检查通过且目标站可达，**不等于已在 Android/QuickJS 中实际执行成功**。
- 缺少必要 ext、规则明确无效、jar 缺类、目标站确定全部失效 → 剔除。
- 没有可验证目标、403/429/5xx/超时等无法确认 → 标记 uncertain，默认保留并降级，不进精选。

## 速度与输出

- TTFB 仍由原有多次取样逻辑决定；`VOD_ONLY_FAST=1` 只控制最终精选输出。
- 体检失败会写入 `聚合接口/剔除报告.json`，保留 health 状态和具体原因。
- 预算用尽未检查的源不判死，留给下一轮。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---:|---|
| `DEEP_CHECK` | 1 | 开启深度审计 |
| `DEEP_CHECK_CATEGORIES` | `cj,py,js,spider` | CMS、Py、JS、Jar 全部覆盖 |
| `DEEP_CHECK_STRICT` | 跟随 STRICTNESS | 控制确定性错误是否剔除 |
| `DEEP_KILL_UNCERTAIN` | 0 | 只有显式设为 1 才删除判不准源 |
| `DEEP_JAR_CLASS` | 1 | 校验 jar 中的蜘蛛类 |
| `DEEP_CHECK_WORKERS` | 16 | 并发数 |
| `BUDGET_DEEP_CHECK` | 600 | 深度审计预算（秒） |
| `DEEP_TARGET_TIMEOUT_MS` | 8000 | 目标站请求超时 |
| `DEEP_MAX_TARGETS` | 3 | 每条规则最多探测的目标站数 |

## 自检

`node scripts/selftest.mjs`：完全离线，覆盖 CMS 主页/分类回退、空壳、Py 规则、Jar 类名、目标站、限流保留和自动修复。
