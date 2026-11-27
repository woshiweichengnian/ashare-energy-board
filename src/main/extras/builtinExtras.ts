import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { HudExtras, MarketSentiment } from '../../shared/types';
import { decodeGb18030 } from '../providers/http';
import {
  buildEtfBaseline,
  buildLadder,
  lastWindowEndMs,
  computeWwd,
  countLadder,
  parseFenbu,
  ratePct,
  summarizeFenbu,
  WWD_CORE_ETFS,
  type EtfBaseline,
  type EtfQuote,
  type LiveWindow,
  type Sina5mBar,
} from './extrasMath';

/**
 * 本机定制：附加数据的取数部分，全部内置在应用里，不依赖任何本机服务。
 *   韩综        Naver（备用腾讯）
 *   涨跌停、涨跌家数、情绪页   东财涨停板行情中心
 *   国家队      腾讯实时报价 + 新浪 5 分钟 K 线（20 日基准，每个交易日只算一次，缓存在用户数据目录）
 * 每一项都有缓存：盘中十几到二十几秒向外取一次；收盘后取到一次收盘值就不再取，直到下一个交易时段
 * （取失败的话 5 分钟后重试）。任何一项失败只影响它自己。
 */

const UA = { 'User-Agent': 'Mozilla/5.0' };
const EM_BASE = 'https://push2ex.eastmoney.com/';
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const IDLE_RETRY_MS = 300_000;

interface Cached<T> {
  /** 上一次成功取到的时间（结果可以是"今天还没有数据"的 null） */
  okAt: number;
  /** 上一次尝试的时间，成功失败都算 */
  tryAt: number;
  data: T | null;
}
const emptyCache = <T>(): Cached<T> => ({ okAt: 0, tryAt: 0, data: null });
const cache: {
  kospi: Cached<NonNullable<HudExtras['kospi']>>;
  limit: Cached<NonNullable<HudExtras['limit']>>;
  breadth: Cached<NonNullable<HudExtras['breadth']>>;
  wwd: Cached<NonNullable<HudExtras['wwd']>>;
  sentiment: Cached<MarketSentiment>;
} = {
  kospi: emptyCache(),
  limit: emptyCache(),
  breadth: emptyCache(),
  wwd: emptyCache(),
  sentiment: emptyCache(),
};

// ---------- 时间（北京时间，不依赖系统时区） ----------
interface ShNow {
  ymd: string; // 20261127
  dashed: string; // 2026-11-27
  hhmm: string; // 14:05
  hms: string;
  minutes: number;
  weekday: number; // 0 = 周日
}

function shNow(nowMs = Date.now()): ShNow {
  const d = new Date(nowMs + 8 * 3600_000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = p2(d.getUTCMonth() + 1);
  const da = p2(d.getUTCDate());
  const hh = p2(d.getUTCHours());
  const mm = p2(d.getUTCMinutes());
  return {
    ymd: `${y}${mo}${da}`,
    dashed: `${y}-${mo}-${da}`,
    hhmm: `${hh}:${mm}`,
    hms: `${hh}:${mm}:${p2(d.getUTCSeconds())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

const isWeekday = (n: ShNow): boolean => n.weekday >= 1 && n.weekday <= 5;

/** A 股：09:15–15:05 */
const ASHARE: LiveWindow = { start: 555, end: 905 };
/** 韩国：北京时间 08:00–14:35 */
const KOSPI: LiveWindow = { start: 480, end: 875 };

const isLive = (n: ShNow, w: LiveWindow): boolean =>
  isWeekday(n) && n.minutes >= w.start && n.minutes <= w.end;

/**
 * 缓存还能不能用。盘中：距上次尝试不到 liveTtlMs。
 * 非交易时段：收盘后已经成功取过一次就一直用到下次开盘；没取成功的每 5 分钟重试一次。
 */
function fresh<T>(c: Cached<T>, liveTtlMs: number, w: LiveWindow): boolean {
  const now = Date.now();
  if (isLive(shNow(now), w)) return now - c.tryAt < liveTtlMs;
  return (c.okAt > 0 && c.okAt >= lastWindowEndMs(now, w)) || now - c.tryAt < IDLE_RETRY_MS;
}

function store<T>(c: Cached<T>, data: T | null): T | null {
  c.okAt = Date.now();
  c.data = data;
  return data;
}

// ---------- 网络 ----------
async function getBuffer(url: string, headers: Record<string, string> = UA, timeoutMs = 6000): Promise<Buffer> {
  const res = await net.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getJson<T>(url: string, headers: Record<string, string> = UA, timeoutMs = 6000): Promise<T> {
  return JSON.parse((await getBuffer(url, headers, timeoutMs)).toString('utf-8')) as T;
}

function emUrl(name: string, params: Record<string, string | number>): string {
  const q = new URLSearchParams({ ut: EM_UT, dpt: 'wz.ztzt', _: String(Date.now()) });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${EM_BASE}${name}?${q.toString()}`;
}

interface EmPoolItem {
  c: string;
  n: string;
  lbc?: number;
  fbt?: number;
  zbc?: number;
  hybk?: string;
}
interface EmPool {
  tc?: number;
  pool?: EmPoolItem[];
}

async function emPool(name: string, day: string, pagesize: number, sort = 'fbt:asc'): Promise<EmPool> {
  const j = await getJson<{ data?: EmPool | null }>(
    emUrl(name, { Pageindex: 0, pagesize, sort, date: day })
  );
  return j.data ?? {};
}

// ---------- 韩综 ----------
async function kospiNaver(): Promise<NonNullable<HudExtras['kospi']>> {
  const j = await getJson<{ datas: Array<Record<string, string>> }>(
    'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI',
    UA,
    4000
  );
  const d = j.datas[0];
  const num = (x: string): number => Number(String(x).replace(/,/g, ''));
  const pct = num(d.fluctuationsRatio);
  const chg = Math.abs(num(d.compareToPreviousClosePrice));
  return {
    price: num(d.closePrice),
    chg: Math.round((pct >= 0 ? chg : -chg) * 100) / 100,
    pct,
    open: d.marketStatus === 'OPEN',
    at: String(d.localTradedAt ?? '').slice(11, 16),
    src: 'naver',
  };
}

async function kospiTencent(): Promise<NonNullable<HudExtras['kospi']>> {
  const v = decodeGb18030(await getBuffer('https://qt.gtimg.cn/q=gzKS11', UA, 4000)).split('~');
  const n = shNow();
  const price = Number(v[3]);
  if (!Number.isFinite(price) || price <= 0) throw new Error('bad quote');
  return {
    price,
    chg: Number(v[4]),
    pct: Number(v[5]),
    open: isWeekday(n) && n.minutes >= 480 && n.minutes < 870,
    at: String(v[2] ?? '').slice(11, 16),
    src: 'tencent',
  };
}

async function kospi(): Promise<HudExtras['kospi']> {
  if (fresh(cache.kospi, 8_000, KOSPI)) return cache.kospi.data;
  cache.kospi.tryAt = Date.now();
  for (const fn of [kospiNaver, kospiTencent]) {
    try {
      const data = await fn();
      if (!Number.isFinite(data.price) || !Number.isFinite(data.pct)) continue;
      return store(cache.kospi, data);
    } catch {
      // 换下一个源
    }
  }
  // 两个源都失败：盘中一分钟内沿用上一次的值，再久就不显示，不把旧数当新数；收盘后的值不会变，继续显示
  if (isLive(shNow(), KOSPI) && Date.now() - cache.kospi.okAt >= 60_000) return null;
  return cache.kospi.data;
}

// ---------- 涨跌停家数、涨跌家数 ----------
async function limitCounts(): Promise<HudExtras['limit']> {
  const n = shNow();
  if (fresh(cache.limit, 25_000, ASHARE)) return cache.limit.data;
  cache.limit.tryAt = Date.now();
  const one = async (name: string, sort: string): Promise<number | null> => {
    try {
      const tc = (await emPool(name, n.ymd, 1, sort)).tc;
      return typeof tc === 'number' ? tc : null;
    } catch {
      return null;
    }
  };
  const [zt, dt] = await Promise.all([one('getTopicZTPool', 'fbt:asc'), one('getTopicDTPool', 'fund:asc')]);
  if (zt === null && dt === null) return cache.limit.data;
  return store(cache.limit, { zt, dt });
}

async function fetchFenbu(): Promise<Map<number, number>> {
  const j = await getJson<{ data?: { fenbu?: unknown } | null }>(emUrl('getTopicZDFenBu', {}));
  const fen = parseFenbu(j.data?.fenbu);
  if (fen.size === 0) throw new Error('empty fenbu');
  return fen;
}

async function breadth(): Promise<HudExtras['breadth']> {
  if (fresh(cache.breadth, 25_000, ASHARE)) return cache.breadth.data;
  cache.breadth.tryAt = Date.now();
  try {
    const s = summarizeFenbu(await fetchFenbu());
    return store(cache.breadth, { up: s.up, down: s.down, flat: s.flat });
  } catch {
    if (isLive(shNow(), ASHARE) && Date.now() - cache.breadth.okAt >= 120_000) return null;
    return cache.breadth.data;
  }
}

// ---------- 国家队 ----------
interface BaselineFile {
  asOf: string;
  items: Record<string, EtfBaseline>;
}
let baselines: BaselineFile | null = null;
let baselineLoading: Promise<void> | null = null;

function baselinePath(): string {
  return path.join(app.getPath('userData'), 'wwd_baseline.json');
}

async function loadBaselines(today: string): Promise<void> {
  if (baselines?.asOf === today) return;
  if (!baselines) {
    try {
      baselines = JSON.parse(fs.readFileSync(baselinePath(), 'utf-8')) as BaselineFile;
    } catch {
      baselines = null;
    }
    if (baselines?.asOf === today) return;
  }
  const old = baselines?.items ?? {};
  const items: Record<string, EtfBaseline> = {};
  const codes = WWD_CORE_ETFS.map(([c]) => c);
  // 每次 4 只并发，新浪偶发失败的那只沿用旧基准
  for (let i = 0; i < codes.length; i += 4) {
    await Promise.all(
      codes.slice(i, i + 4).map(async (code) => {
        try {
          const rows = await getJson<Sina5mBar[]>(
            `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${code}&scale=5&ma=no&datalen=1100`,
            { ...UA, Referer: 'https://finance.sina.com.cn' },
            15_000
          );
          const b = Array.isArray(rows) ? buildEtfBaseline(rows, today) : null;
          if (b) items[code] = b;
          else if (old[code]) items[code] = old[code];
        } catch {
          if (old[code]) items[code] = old[code];
        }
      })
    );
  }
  if (Object.keys(items).length < codes.length / 2) {
    throw new Error('baseline unavailable');
  }
  baselines = { asOf: today, items };
  try {
    fs.writeFileSync(baselinePath(), JSON.stringify(baselines));
  } catch {
    // 写不了缓存不影响本次使用
  }
}

async function etfQuotes(): Promise<{ quotes: Map<string, EtfQuote>; date: string | null }> {
  const codes = WWD_CORE_ETFS.map(([c]) => c);
  const text = decodeGb18030(
    await getBuffer(`https://qt.gtimg.cn/q=${codes.join(',')}&r=${Math.floor(Date.now() / 1000)}`, UA, 8000)
  );
  const quotes = new Map<string, EtfQuote>();
  let date: string | null = null;
  for (const line of text.split('\n')) {
    const m = /v_(\w+)="/.exec(line);
    const v = line.split('~');
    if (!m || v.length < 40) continue;
    const num = (i: number): number => Number(v[i]) || 0;
    quotes.set(m[1], { amountYi: num(37) / 1e4, outerLots: num(7), innerLots: num(8) });
    date ??= String(v[30] ?? '').slice(0, 8) || null;
  }
  return { quotes, date };
}

async function wwd(): Promise<HudExtras['wwd']> {
  const n = shNow();
  const trading = isWeekday(n) && ((n.minutes >= 570 && n.minutes < 690) || (n.minutes >= 780 && n.minutes < 900));
  const lunch = isWeekday(n) && n.minutes >= 690 && n.minutes < 780;
  if (fresh(cache.wwd, 20_000, ASHARE)) return cache.wwd.data;
  cache.wwd.tryAt = Date.now();
  try {
    baselineLoading ??= loadBaselines(n.dashed).finally(() => {
      baselineLoading = null;
    });
    await baselineLoading;
    const { quotes, date } = await etfQuotes();
    // 行情日期不是今天（盘前、周末、节假日）：今天还没有数据，不显示
    if (!baselines || date !== n.ymd) return store(cache.wwd, null);
    const eff = trading ? n.hhmm : lunch ? '11:30' : null;
    const verdict = computeWwd(quotes, new Map(Object.entries(baselines.items)), eff);
    if (!verdict) return null;
    const at = trading ? n.hhmm : lunch ? '11:30' : n.minutes >= 900 ? '15:00' : n.hhmm;
    return store(cache.wwd, { ...verdict, at });
  } catch (err: unknown) {
    console.warn('[extras] wwd failed:', err instanceof Error ? err.message : String(err));
    if (isLive(shNow(), ASHARE) && Date.now() - cache.wwd.okAt >= 180_000) return null;
    return cache.wwd.data;
  }
}

// ---------- 悬浮窗附加行 ----------
export async function buildHudExtras(): Promise<HudExtras> {
  const safe = async <T>(p: Promise<T | null | undefined>): Promise<T | null> => {
    try {
      return (await p) ?? null;
    } catch {
      return null;
    }
  };
  const [k, w, l, b] = await Promise.all([safe(kospi()), safe(wwd()), safe(limitCounts()), safe(breadth())]);
  return { kospi: k, wwd: w, limit: l, breadth: b, at: shNow().hms };
}

// ---------- 情绪页 ----------
let prevDay: { date: string; zt: number; zb: number; dt: number; ladder: Map<number, number> } | null = null;

/**
 * tradeDate / prevTradeDate 用应用自己已经确定的两个交易日（量能主功能本来就要知道），
 * 这里不再另找接口去问日历。
 */
export async function buildMarketSentiment(
  tradeDate: string | null,
  prevTradeDate: string | null
): Promise<MarketSentiment | null> {
  if (fresh(cache.sentiment, 25_000, ASHARE)) return cache.sentiment.data;
  if (!tradeDate || !prevTradeDate) return null;
  cache.sentiment.tryAt = Date.now();
  try {
    const day = tradeDate.replace(/-/g, '');
    const prev = prevTradeDate.replace(/-/g, '');
    const [fen, zt, zb, dt] = await Promise.all([
      fetchFenbu(),
      emPool('getTopicZTPool', day, 1000),
      emPool('getTopicZBPool', day, 1000),
      emPool('getTopicDTPool', day, 1000, 'fund:asc'),
    ]);
    // 昨天的三个池收盘后不再变，同一个交易日只取一次
    if (prevDay?.date !== prev) {
      const [pzt, pzb, pdt] = await Promise.all([
        emPool('getTopicZTPool', prev, 1000),
        emPool('getTopicZBPool', prev, 1000),
        emPool('getTopicDTPool', prev, 1000, 'fund:asc'),
      ]);
      prevDay = {
        date: prev,
        zt: pzt.pool?.length ?? 0,
        zb: pzb.pool?.length ?? 0,
        dt: pdt.pool?.length ?? 0,
        ladder: countLadder(pzt.pool ?? []),
      };
    }
    const ztPool = zt.pool ?? [];
    const zbCount = zb.pool?.length ?? 0;
    const summary = summarizeFenbu(fen);
    const leaders = ztPool
      .filter((x) => Number(x.lbc ?? 1) >= 2)
      .sort((a, b) => Number(b.lbc) - Number(a.lbc) || Number(a.fbt ?? 0) - Number(b.fbt ?? 0))
      .slice(0, 30)
      .map((x) => ({
        code: x.c,
        name: x.n,
        boards: Number(x.lbc),
        industry: x.hybk ?? '',
        breaks: Number(x.zbc ?? 0),
      }));
    const data: MarketSentiment = {
      date: day,
      prevDate: prev,
      at: shNow().hms,
      ...summary,
      limitUp: ztPool.length,
      limitDown: dt.pool?.length ?? 0,
      broken: zbCount,
      sealRate: ratePct(ztPool.length, ztPool.length + zbCount),
      prev: {
        limitUp: prevDay.zt,
        limitDown: prevDay.dt,
        sealRate: ratePct(prevDay.zt, prevDay.zt + prevDay.zb),
      },
      ladder: buildLadder(countLadder(ztPool), prevDay.ladder),
      leaders,
    };
    return store(cache.sentiment, data);
  } catch (err: unknown) {
    console.warn('[sentiment] failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
