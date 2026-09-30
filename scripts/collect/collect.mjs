/**
 * ops 数据采集编排器（由 GitHub Actions 每日调用，也可本地手跑）：
 *   1. 逐个执行 sources.mjs 的数据源（按 cronType 决定今天是否该跑）
 *   2. 生成 feed 条目 → 与 data/ops-feed.json 既有条目合并（保留 read/starred，滚动保留近 10 天）
 *   3. 依据 scripts/collect/state.json 的运行历史计算 7 日成功率 / 连续失败 → 生成 ops-missions.json
 *   4. 全部落盘；无任何外部依赖（Node 18+ 原生 fetch）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, TASK_META } from './sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..'); // 仓库根 = 站点根
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(__dirname, 'state.json');

const RETENTION_DAYS = 10; // feed 条目保留天数（自动淘汰过期数据）
const FEED_CAP = 300; // feed 条目上限

/* ---- 时间工具（统一按北京时间 +08:00 计算业务日期） ---- */
const cstNow = () => new Date(Date.now() + 8 * 3600 * 1000); // 用 UTC getter 读即北京挂钟
const cstDate = (d = cstNow()) => d.toISOString().slice(0, 10);
const cstStamp = (d = cstNow()) => `${cstDate(d).replaceAll('-', '')}${d.toISOString().slice(11, 16).replace(':', '')}`;

function nextDailyIso() {
  const n = new Date();
  const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 50)); // 00:50 UTC = 北京 08:50
  if (t.getTime() <= n.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString();
}

function nextWeeklyIso() {
  const n = new Date();
  const t = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 0, 50));
  do {
    t.setUTCDate(t.getUTCDate() + 1);
  } while (t.getUTCDay() !== 1); // 下一个周一
  return t.toISOString();
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const nowIso = new Date().toISOString();
const runId = `run-${cstStamp()}`;

/* ---- 1. 跑数据源 ---- */
const state = readJson(STATE_FILE) ?? { tasks: {} };
const feedNew = [];
const runResult = {}; // task_id -> 'success' | 'failed' | 'not-scheduled'

for (const src of SOURCES) {
  const scheduled = src.cronType === 'daily' || cstNow().getUTCDay() === 1; // weekly 仅周一
  let result = null;
  if (scheduled) {
    try {
      result = await src.fetch();
    } catch (err) {
      result = {
        level: 'routine',
        status: 'failed',
        title: `${TASK_META[src.id].name}：本次运行失败`,
        summary: String(err?.message ?? err).slice(0, 80),
        indicators: [],
        missing: [{ code: 'RUN', reason: '采集器异常' }],
      };
    }
  }

  if (result) {
    feedNew.push({
      entry_id: `${src.id}-${cstStamp()}`,
      run_id: runId,
      task_id: src.id,
      level: result.level ?? 'routine',
      status: result.status,
      title: result.title,
      summary: result.summary ?? '',
      indicators: result.indicators ?? [],
      missing: result.missing ?? [],
      created_at: nowIso,
      read: false,
      starred: false,
    });
    runResult[src.id] = 'success';
  } else {
    runResult[src.id] = 'not-scheduled';
  }
}

/* ---- 2. 合并 feed（保留已读/星标，滚动淘汰过期条目） ---- */
mkdirSync(DATA_DIR, { recursive: true });
const feedFile = path.join(DATA_DIR, 'ops-feed.json');
const oldFeed = readJson(feedFile)?.feed ?? [];
const byId = new Map();
for (const e of oldFeed) byId.set(e.entry_id, e);
for (const e of feedNew) {
  const old = byId.get(e.entry_id);
  byId.set(e.entry_id, old ? { ...e, read: e.read || old.read, starred: e.starred || old.starred } : e);
}
const cutoff = Date.now() - RETENTION_DAYS * 86400000;
const feed = [...byId.values()]
  .filter((e) => Date.parse(e.created_at) >= cutoff)
  .sort((a, b) => b.created_at.localeCompare(a.created_at))
  .slice(0, FEED_CAP);
writeFileSync(feedFile, `${JSON.stringify({ generated_at: nowIso, feed }, null, 2)}\n`);

/* ---- 3. 更新运行历史 + 生成 missions ---- */
for (const src of SOURCES) {
  const st = (state.tasks[src.id] ??= { runs: [], lastRunAt: null, lastStatus: 'success' });
  if (runResult[src.id] === 'not-scheduled') continue;
  st.runs = st.runs.filter((r) => r.date !== cstDate()); // 幂等：同日重跑只留一条
  st.runs.push({ date: cstDate(), status: runResult[src.id] === 'failed' ? 'failed' : 'success' });
  st.runs.sort((a, b) => a.date.localeCompare(b.date));
  st.lastRunAt = nowIso;
  st.lastStatus = runResult[src.id] === 'failed' ? 'failed' : 'success';
}
writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

const missions = SOURCES.map((src) => {
  const meta = TASK_META[src.id];
  const rec = state.tasks[src.id] ?? { runs: [], lastRunAt: null, lastStatus: 'success' };
  const last7 = rec.runs.slice(-7);
  const succ = last7.filter((r) => r.status !== 'failed').length; // skipped 记 success（任务正常完成但无事可报）
  const rate = last7.length ? Math.round((100 * succ) / last7.length) : 100;
  let cf = 0;
  for (let i = rec.runs.length - 1; i >= 0 && rec.runs[i].status === 'failed'; i--) cf++;
  return {
    task_id: src.id,
    name: meta.name,
    emoji: meta.emoji,
    cron_desc: meta.cron_desc,
    enabled: true,
    last_status: rec.lastStatus,
    last_run_at: rec.lastRunAt,
    next_run_at: meta.weekly ? nextWeeklyIso() : nextDailyIso(),
    success_rate_7d: rate,
    consecutive_failures: cf,
  };
});
writeFileSync(path.join(DATA_DIR, 'ops-missions.json'), `${JSON.stringify({ generated_at: nowIso, missions }, null, 2)}\n`);

/* ---- 4. 摘要 ---- */
const okCount = Object.values(runResult).filter((s) => s === 'success').length;
const failCount = Object.values(runResult).filter((s) => s === 'failed').length;
console.log(`[ops] run=${runId} 新条目=${feedNew.length} 成功=${okCount} 失败=${failCount} feed总条数=${feed.length}`);
for (const [id, s] of Object.entries(runResult)) console.log(`[ops]   - ${id}: ${s}`);
