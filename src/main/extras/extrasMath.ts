/**
 * 本机定制：附加数据（国家队、涨跌分布、连板）的纯计算部分，不碰网络和系统时钟，方便测试。
 * 国家队口径：同时点放量倍数 = 池子累计成交额 ÷（20 日均额 × 该时点历史平均已走完比例）；
 * 主动净买入 =（外盘 − 内盘）÷（外盘 + 内盘）× 成交额。
 */

/** 宽基 ETF 池：[腾讯代码, 名称]。汇金前十大持有人口径的 20 只，判定只看这一池。 */
export const WWD_CORE_ETFS: ReadonlyArray<readonly [string, string]> = [
  ['sh510300', '沪深300ETF华泰柏瑞'],
  ['sh510310', '沪深300ETF易方达'],
  ['sh510050', '上证50ETF华夏'],
  ['sh510330', '沪深300ETF华夏'],
  ['sz159919', '沪深300ETF嘉实'],
  ['sh512100', '中证1000ETF南方'],
  ['sh588080', '科创50ETF易方达'],
  ['sz159915', '创业板ETF易方达'],
  ['sh510500', '中证500ETF南方'],
  ['sz159845', '中证1000ETF华夏'],
  ['sh560010', '中证1000ETF广发'],
  ['sh510180', '上证180ETF华安'],
  ['sz159629', '中证1000ETF富国'],
  ['sh510230', '金融ETF国泰'],
  ['sz159922', '中证500ETF嘉实'],
  ['sh512500', '中证500ETF华夏'],
  ['sh515800', '中证800ETF汇添富'],
  ['sz159952', '创业板ETF广发'],
  ['sh588050', '科创50ETF工银'],
  ['sz159901', '深证100ETF易方达'],
];

export const WWD_BASE_DAYS = 20;

export interface EtfBaseline {
  /** 20 日日均成交额（亿元） */
  avg20Yi: number;
  /** [HH:MM, 到这一刻平均已走完全天的比例] */
  shape: Array<[string, number]>;
}

export interface Sina5mBar {
  day: string;
  close: string;
  volume: string;
}

/** 用新浪 5 分钟 K 线算一只 ETF 的 20 日基准：日均额 + 分时累计占比曲线。excludeDate='YYYY-MM-DD' */
export function buildEtfBaseline(rows: readonly Sina5mBar[], excludeDate: string): EtfBaseline | null {
  const byDay = new Map<string, Array<[string, number]>>();
  for (const b of rows) {
    const d = b.day.slice(0, 10);
    if (d === excludeDate) continue;
    const amt = Number(b.volume) * Number(b.close);
    if (!Number.isFinite(amt)) continue;
    const list = byDay.get(d) ?? [];
    list.push([b.day.slice(11, 16), amt]);
    byDay.set(d, list);
  }
  const days = [...byDay.keys()]
    .filter((d) => (byDay.get(d)?.length ?? 0) >= 40)
    .sort()
    .slice(-WWD_BASE_DAYS);
  if (days.length === 0) return null;

  const totals: number[] = [];
  const cumByTime = new Map<string, number[]>();
  for (const d of days) {
    const bars = (byDay.get(d) ?? []).slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const tot = bars.reduce((s, [, a]) => s + a, 0) || 1;
    totals.push(tot);
    let c = 0;
    for (const [hm, a] of bars) {
      c += a;
      const list = cumByTime.get(hm) ?? [];
      list.push(c / tot);
      cumByTime.set(hm, list);
    }
  }
  const shape = [...cumByTime.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([hm, v]): [string, number] => [hm, v.reduce((s, x) => s + x, 0) / v.length]);
  return { avg20Yi: totals.reduce((s, x) => s + x, 0) / totals.length / 1e8, shape };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** 分时累计占比曲线在某一时刻的值（线性插值） */
export function shapeAt(shape: ReadonlyArray<readonly [string, number]>, hhmm: string): number | null {
  if (shape.length === 0) return null;
  const tx = toMinutes(hhmm);
  if (tx <= toMinutes(shape[0][0])) return shape[0][1];
  if (tx >= toMinutes(shape[shape.length - 1][0])) return shape[shape.length - 1][1];
  for (let i = 1; i < shape.length; i += 1) {
    const t1 = toMinutes(shape[i][0]);
    if (tx <= t1) {
      const t0 = toMinutes(shape[i - 1][0]);
      if (t1 <= t0) return shape[i][1];
      return shape[i - 1][1] + ((shape[i][1] - shape[i - 1][1]) * (tx - t0)) / (t1 - t0);
    }
  }
  return shape[shape.length - 1][1];
}

export interface EtfQuote {
  amountYi: number;
  outerLots: number;
  innerLots: number;
}

export type WwdLevel = 'hot' | 'mid' | 'cool';

export interface WwdVerdict {
  level: WwdLevel;
  label: string;
  /** 池子成交额 ÷ 历史同时点应有的成交额 */
  ratio: number;
  /** 主动净买入（亿元）=（外盘−内盘）÷（外盘+内盘）× 成交额，逐只相加 */
  net: number;
}

const WWD_LABEL: Record<WwdLevel, string> = { hot: '上班了', mid: '有迹象', cool: '没上班' };

/**
 * 国家队判定。effHhmm 为 null 表示不在盘中（按全天对全天比）。
 * 倍数≥1.8 且净买入>0 → 上班了；倍数≥1.3 → 有迹象；其余 → 没上班。
 */
export function computeWwd(
  quotes: ReadonlyMap<string, EtfQuote>,
  baselines: ReadonlyMap<string, EtfBaseline>,
  effHhmm: string | null
): WwdVerdict | null {
  let sumAmt = 0;
  let sumBaseAdj = 0;
  let sumNet = 0;
  let used = 0;
  for (const [code] of WWD_CORE_ETFS) {
    const q = quotes.get(code);
    const b = baselines.get(code);
    if (!q || !b || !(b.avg20Yi > 0)) continue;
    let p = 1;
    if (effHhmm !== null) {
      const s = shapeAt(b.shape, effHhmm);
      p = Math.min(1, s === null || s < 0.02 ? 0.5 : s);
    }
    const oi = q.outerLots + q.innerLots;
    sumAmt += q.amountYi;
    sumBaseAdj += b.avg20Yi * p;
    sumNet += oi > 0 ? ((q.outerLots - q.innerLots) / oi) * q.amountYi : 0;
    used += 1;
  }
  // 池子里拿到数的不到一半时不出结论，免得用几只票代表整池
  if (used < WWD_CORE_ETFS.length / 2 || !(sumBaseAdj > 0)) return null;
  const ratio = sumAmt / sumBaseAdj;
  const level: WwdLevel = ratio >= 1.8 && sumNet > 0 ? 'hot' : ratio >= 1.3 ? 'mid' : 'cool';
  return {
    level,
    label: WWD_LABEL[level],
    ratio: Math.round(ratio * 1000) / 1000,
    net: Math.round(sumNet * 100) / 100,
  };
}

/** 东财涨跌分布（每 1% 一档；11 = 涨停，-11 = 跌停）并成 9 档 */
const BUCKET_DEFS: ReadonlyArray<readonly [string, readonly number[], 'up' | 'flat' | 'down']> = [
  ['涨停', [11], 'up'],
  ['7%以上', [8, 9, 10], 'up'],
  ['3~7%', [4, 5, 6, 7], 'up'],
  ['0~3%', [1, 2, 3], 'up'],
  ['平', [0], 'flat'],
  ['0~-3%', [-1, -2, -3], 'down'],
  ['-3~-7%', [-4, -5, -6, -7], 'down'],
  ['-7%以下', [-8, -9, -10], 'down'],
  ['跌停', [-11], 'down'],
];

export function parseFenbu(raw: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const key = Number(k);
      const val = Number(v);
      if (Number.isFinite(key) && Number.isFinite(val)) out.set(key, val);
    }
  }
  return out;
}

export function summarizeFenbu(fen: ReadonlyMap<number, number>): {
  up: number;
  down: number;
  flat: number;
  buckets: Array<{ label: string; count: number; side: 'up' | 'flat' | 'down' }>;
} {
  let up = 0;
  let down = 0;
  for (const [k, v] of fen) {
    if (k > 0) up += v;
    else if (k < 0) down += v;
  }
  return {
    up,
    down,
    flat: fen.get(0) ?? 0,
    buckets: BUCKET_DEFS.map(([label, keys, side]) => ({
      label,
      side,
      count: keys.reduce((s, k) => s + (fen.get(k) ?? 0), 0),
    })),
  };
}

/** 连板数 -> 家数 */
export function countLadder(pool: ReadonlyArray<{ lbc?: number | null }>): Map<number, number> {
  const out = new Map<number, number>();
  for (const x of pool) {
    const n = Math.max(1, Math.round(Number(x.lbc ?? 1)) || 1);
    out.set(n, (out.get(n) ?? 0) + 1);
  }
  return out;
}

export function ratePct(a: number, b: number): number | null {
  return b > 0 ? Math.round((a / b) * 100) : null;
}

/** 一板到高度板的家数与连板率：N 板连板率 = 今天 N 板 ÷ 昨天 N-1 板；高度板 = 5 板及以上 ÷ 昨天 4 板及以上 */
export function buildLadder(
  today: ReadonlyMap<number, number>,
  prev: ReadonlyMap<number, number>
): Array<{ label: string; count: number; rate: number | null }> {
  const sumFrom = (m: ReadonlyMap<number, number>, from: number): number => {
    let s = 0;
    for (const [k, v] of m) if (k >= from) s += v;
    return s;
  };
  const out: Array<{ label: string; count: number; rate: number | null }> = [
    { label: '一板', count: today.get(1) ?? 0, rate: null },
  ];
  (
    [
      [2, '二板'],
      [3, '三板'],
      [4, '四板'],
    ] as const
  ).forEach(([n, label]) => {
    out.push({ label, count: today.get(n) ?? 0, rate: ratePct(today.get(n) ?? 0, prev.get(n - 1) ?? 0) });
  });
  const high = sumFrom(today, 5);
  out.push({ label: '高度板', count: high, rate: ratePct(high, sumFrom(prev, 4)) });
  return out;
}

/** 一个"数据会变"的时段：周一到周五，北京时间第 start 到第 end 分钟（含） */
export interface LiveWindow {
  start: number;
  end: number;
}

const DAY_MS = 86_400_000;
const SH_OFFSET_MS = 8 * 3600_000;

/**
 * 最近一个已经结束的时段的结束时刻（毫秒时间戳）。
 * 用来判断"收盘值是不是已经取过了"：缓存的成功时间不早于它，就不用再取。
 */
export function lastWindowEndMs(nowMs: number, w: LiveWindow): number {
  const todayStart = Math.floor((nowMs + SH_OFFSET_MS) / DAY_MS) * DAY_MS - SH_OFFSET_MS;
  for (let back = 0; back <= 7; back += 1) {
    const dayStart = todayStart - back * DAY_MS;
    const weekday = new Date(dayStart + SH_OFFSET_MS).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const endMs = dayStart + (w.end + 1) * 60_000;
    if (endMs <= nowMs) return endMs;
  }
  return 0;
}
