# 严格筛选策略（宁可误杀）

## 规则

1. **有内容**：采集站 ac=list / 分类页必须返回真实条目
2. **搜索有结果**：必须 ac=search&wd=… 返回条目，否则标记 NO_SEARCH 剔除
3. **TTFB 优**：继续配合 VOD_ONLY_FAST，只保留快站
4. **判不准也剔**：严格模式下 403/429/超时 不再保留

## 代码位置

- `scripts/deepcheck.mjs`：deepCheckCms + HEALTH.NO_SEARCH + runDeepCheck 严格剔除 uncertain
- `scripts/pipeline.mjs`：deepKillUncertain 选项

## 环境变量

- `DEEP_CHECK_STRICT=1`（默认）
- `DEEP_KILL_UNCERTAIN=1`（默认跟随 deepStrict）
- `VOD_ONLY_FAST=1`
