/**
 * ops 数据源配置 —— 接真实数据源只改这个文件，无需动 collect.mjs。
 *
 * 每个源 = { id, cronType, fetch }：
 *   cronType: 'daily'（每日跑）| 'weekly'（仅周一跑）
 *   fetch() 返回：
 *     { level?, status:'full'|'partial', title, summary, indicators:[...], missing:[...] } → 生成条目
 *     { status:'skipped', title }                                                        → 生成 skipped 条目（今日无异动）
 *     null                                                                               → 今日无该任务条目
 *     抛错                                                                               → 自动记为 failed 条目
 *
 * 已接通的源：
 *   - 汇率：api.frankfurter.dev（欧洲央行 ECB 参考汇率，免费无 key）
 *   - 金价：Yahoo Finance 现货黄金 XAUUSD=X（主）→ CoinGecko PAXG（备，黄金代理）
 * 待接入（先以 skipped 诚实占位）：
 *   - policy_daily：可接 Coze 工作流 / 政策 RSS
 *   - housing_weekly：可接克而瑞 / 国家统计局月度数据
 */

export const TASK_META = {
  fx_gold: {
    emoji: '💰',
    name: '黄金与汇率异动',
    cron_desc: '每日 08:50（GitHub Actions 定时采集）',
    weekly: false,
  },
  macro_daily: {
    emoji: '📊',
    name: '人民币汇率晨报',
    cron_desc: '每日 08:50（GitHub Actions 定时采集）',
    weekly: false,
  },
  policy_daily: {
    emoji: '🏛️',
    name: '政策快讯',
    cron_desc: '每日 08:50（数据源待接入，可接 Coze 工作流）',
    weekly: false,
  },
  housing_weekly: {
    emoji: '🏠',
    name: '楼市周报',
    cron_desc: '每周一 08:50（数据源待接入）',
    weekly: true,
  },
};

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

async function getJson(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'ops-collector/1.0 (+github actions)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const sign = (n) => `${n > 0 ? '+' : ''}${r2(n)}%`;

/* ============ ① fx_gold：金价（Yahoo→CoinGecko 回退）+ 美元兑人民币（Frankfurter） ============ */
async function fetchFxGold() {
  const missing = [];
  let gold = null;
  let usdcny = null;

  // 主源：Yahoo 现货黄金
  try {
    const y = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=1d&range=5d');
    const meta = y?.chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice) {
      gold = { price: meta.regularMarketPrice, prev: meta.chartPreviousClose ?? meta.previousClose ?? null };
    }
  } catch {
    /* 降级到备源 */
  }

  // 备源：CoinGecko 的 PAXG（1:1 锚定金价的代币，作代理）
  if (!gold) {
    try {
      const cg = await getJson(
        'https://api.coingecko.com/api/v3/simple/price?ids=paxg&vs_currencies=usd&include_24hr_change=true'
      );
      const p = cg?.paxg;
      if (p?.usd) {
        const chg = p.usd_24h_change ?? 0;
        gold = { price: p.usd, prev: p.usd / (1 + chg / 100) };
      }
    } catch {
      /* 两个金价源都不可达 */
    }
  }

  // 汇率保底源
  try {
    const fx = await getJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY');
    if (fx?.rates?.CNY) usdcny = fx.rates.CNY;
  } catch {
    /* 汇率源不可达 */
  }

  if (!gold && !usdcny) throw new Error('全部数据源不可达');
  if (!gold) missing.push({ code: 'XAU_USD', reason: '金价源不可达（Yahoo/CoinGecko 均失败）' });

  const indicators = [];
  let chg = 0;
  if (gold) {
    chg = gold.prev ? ((gold.price - gold.prev) / gold.prev) * 100 : 0;
    indicators.push({
      code: 'XAU_USD',
      name: '现货黄金',
      value: r2(gold.price),
      unit: '美元/盎司',
      chg_pct: r2(chg),
      alert: Math.abs(chg) >= 1,
    });
  }
  if (usdcny) {
    indicators.push({ code: 'USD_CNY', name: '美元兑人民币', value: r4(usdcny), unit: '', chg_pct: 0, alert: false });
  }

  const level = Math.abs(chg) >= 1 ? 'alert' : 'routine';
  const status = missing.length ? 'partial' : 'full';
  const title = gold
    ? `现货黄金报 ${gold.price.toLocaleString('en-US')} 美元/盎司，日内 ${sign(chg)}`
    : `美元兑人民币报 ${r4(usdcny)}（金价源暂缺）`;
  const summary = gold
    ? '金价源：Yahoo Finance（备用 CoinGecko PAXG 代理）；汇率源：Frankfurter/ECB。日内波动 ≥1% 自动标记为异动。'
    : '金价与汇率源均未返回有效数据，请检查数据源或稍后重跑。';

  return { level, status, title, summary, indicators, missing };
}

/* ============ ② macro_daily：人民币汇率晨报（Frankfurter/ECB） ============ */
async function fetchMacroDaily() {
  const fx = await getJson('https://api.frankfurter.dev/v1/latest?base=CNY&symbols=USD,HKD,JPY,EUR');
  const rates = fx?.rates;
  if (!rates) throw new Error('汇率源未返回');
  const indicators = [
    { code: 'USD_CNY', name: '美元兑人民币', value: r4(1 / rates.USD), unit: '', chg_pct: 0, alert: false },
    { code: 'HKD_CNY', name: '港元兑人民币', value: r4(1 / rates.HKD), unit: '', chg_pct: 0, alert: false },
    { code: 'JPY_CNY', name: '100 日元兑人民币', value: r2(100 / rates.JPY), unit: '', chg_pct: 0, alert: false },
    { code: 'EUR_CNY', name: '欧元兑人民币', value: r4(1 / rates.EUR), unit: '', chg_pct: 0, alert: false },
  ];
  return {
    level: 'routine',
    status: 'full',
    title: `人民币汇率晨报：1 美元 = ${r4(1 / rates.USD)} 元`,
    summary: `数据源：Frankfurter（ECB 参考汇率，${fx.date} 交易日）。人民币汇率中长线观察用，非实时牌价。`,
    indicators,
    missing: [],
  };
}

/* ============ ③④ 待接入源：诚实占位（skipped） ============ */
async function fetchPolicyDaily() {
  return {
    status: 'skipped',
    title: '政策快讯：数据源待接入（可接 Coze 工作流或政策 RSS）',
  };
}

async function fetchHousingWeekly() {
  return {
    status: 'skipped',
    title: '楼市周报：数据源待接入（可接克而瑞/统计局月度数据）',
  };
}

export const SOURCES = [
  { id: 'fx_gold', cronType: 'daily', fetch: fetchFxGold },
  { id: 'macro_daily', cronType: 'daily', fetch: fetchMacroDaily },
  { id: 'policy_daily', cronType: 'daily', fetch: fetchPolicyDaily },
  { id: 'housing_weekly', cronType: 'weekly', fetch: fetchHousingWeekly },
];
