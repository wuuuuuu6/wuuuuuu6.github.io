# ops 数据采集器

为工作台「资讯流 / 自动化中心」模块生产数据：每日由 GitHub Actions 定时运行，
把结果写成站点根目录的 `data/ops-feed.json` 与 `data/ops-missions.json` 并自动提交，
GitHub Pages 随之更新（约 1 分钟生效）。

## 文件

| 文件 | 说明 |
|---|---|
| `sources.mjs` | **数据源配置（唯一需要改的文件）**：接新数据源 / 改任务元信息 |
| `collect.mjs` | 编排器：跑源 → 合并 feed → 维护运行历史 → 落盘，一般不用动 |
| `state.json` | 各任务运行历史（自动生成并提交，用于计算 7 日成功率 / 连续失败） |

## 手动触发

- **云端**：GitHub 仓库 → Actions → ops-data → Run workflow
- **本地**：`node scripts/collect/collect.mjs`（跑完记得 commit + push，否则线上不变）

## 接入新数据源

在 `sources.mjs` 里加/改一个源即可，返回值约定见文件头注释：

- 正常：`{ level, status:'full'|'partial', title, summary, indicators, missing }`
- 无事可报：`{ status:'skipped', title }`（前端折叠为「今日无异动 ×N」）
- 今日不跑：返回 `null`（不生成条目，也不影响成功率）
- 抛错：自动记为 failed 条目并计入连续失败

## 口径说明

- 业务日期统一按北京时间（+08:00）；7 日成功率 = 近 7 次*运行*中成功占比，skipped 视为成功。
- feed 条目滚动保留近 10 天、上限 300 条，旧数据（含此前的演示数据）自动淘汰。
- 首次启用若 Actions 推送报 403：仓库 Settings → Actions → General →
  Workflow permissions 勾选「Read and write permissions」。
