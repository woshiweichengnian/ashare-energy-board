#!/usr/bin/env node
/**
 * Phase 0 数据源实测与可行性探针脚本
 *
 * 测试范围：
 * 1. 公开批量快照：东方财富 push2、腾讯 qt.gtimg.cn、新浪 hq.sinajs.cn
 * 2. 公开 1 分钟分时（今+昨）：东方财富 trends2、腾讯 minute/day/mkline、新浪分钟 K 线
 * 3. 成交额单位与口径交叉核验（重点核验 399001.SZ vs 399106.SZ 及分时累加 vs 快照）
 * 4. 同花顺 Fuyao API 最小有界探测（交易日历、标的搜索、指数快照、个股快照）
 * 5. 有界限流压测（3s × 20 次、5s × 12 次）与冷启动 7 标的 2 日分时拉取测试
 *
 * 用法：
 *   node scripts/spike-data-sources.mjs [--skip-stress] [--out <jsonPath>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SYMBOLS = [
  { thscode: '000001.SH', name: '上证指数', type: 'index', emSecid: '1.000001', txCode: 'sh000001', sinaCode: 'sh000001' },
  { thscode: '399106.SZ', name: '深证综指', type: 'index', emSecid: '0.399106', txCode: 'sz399106', sinaCode: 'sz399106' },
  { thscode: '399001.SZ', name: '深证成指', type: 'index', emSecid: '0.399001', txCode: 'sz399001', sinaCode: 'sz399001' },
  { thscode: '399006.SZ', name: '创业板指', type: 'index', emSecid: '0.399006', txCode: 'sz399006', sinaCode: 'sz399006' },
  { thscode: '399102.SZ', name: '创业板综', type: 'index', emSecid: '0.399102', txCode: 'sz399102', sinaCode: 'sz399102' },
  { thscode: '000688.SH', name: '科创50',   type: 'index', emSecid: '1.000688', txCode: 'sh000688', sinaCode: 'sh000688' },
  { thscode: '600519.SH', name: '贵州茅台', type: 'stock', emSecid: '1.600519', txCode: 'sh600519', sinaCode: 'sh600519' },
  { thscode: '300750.SZ', name: '宁德时代', type: 'stock', emSecid: '0.300750', txCode: 'sz300750', sinaCode: 'sz300750' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const skipStress = args.includes('--skip-stress');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveHithinkKey() {
  if (process.env.HITHINK_FINANCE_API_KEY?.trim()) {
    return { key: process.env.HITHINK_FINANCE_API_KEY.trim(), source: 'env:HITHINK_FINANCE_API_KEY' };
  }
  const appData = process.env.APPDATA || '';
  const credPath = path.join(appData, 'hithink-finance', 'credentials.env');
  if (appData && fs.existsSync(credPath)) {
    const content = fs.readFileSync(credPath, 'utf8');
    const match = content.match(/^\s*HITHINK_FINANCE_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) {
      const val = match[1].trim().replace(/^["']|["']$/g, '');
      if (val) return { key: val, source: 'file:credentials.env' };
    }
  }
  return { key: null, source: 'none' };
}

async function fetchTimed(url, options = {}) {
  const start = performance.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const latencyMs = Math.round((performance.now() - start) * 10) / 10;
    return {
      ok: res.ok,
      status: res.status,
      latencyMs,
      bytes: buf.length,
      buffer: buf,
      error: null,
    };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - start) * 10) / 10;
    return {
      ok: false,
      status: 0,
      latencyMs,
      bytes: 0,
      buffer: Buffer.alloc(0),
      error: err?.cause?.code || err?.name || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeGbk(buf) {
  return new TextDecoder('gb18030').decode(buf);
}

function toYi(yuan) {
  if (typeof yuan !== 'number' || Number.isNaN(yuan)) return null;
  return Math.round((yuan / 1e8) * 100) / 100;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// ============================================================
// 1. 批量实时快照测试
// ============================================================

async function testEastmoneySnapshot() {
  const secids = SYMBOLS.map((s) => s.emSecid).join(',');
  const fields = 'f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124';
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${secids}`;
  const res = await fetchTimed(url, {
    headers: { Referer: 'https://quote.eastmoney.com/' },
  });
  if (!res.ok) {
    return { provider: 'eastmoney', url, ok: false, status: res.status, latencyMs: res.latencyMs, error: res.error, items: [] };
  }
  let json;
  try {
    json = JSON.parse(res.buffer.toString('utf8'));
  } catch (err) {
    return { provider: 'eastmoney', url, ok: false, status: res.status, latencyMs: res.latencyMs, error: `JSON_PARSE_ERROR: ${err.message}`, items: [] };
  }
  const diff = json?.data?.diff || [];
  const items = diff.map((d) => {
    const market = d.f13 === 1 ? 'SH' : d.f13 === 0 ? 'SZ' : String(d.f13);
    const thscode = `${d.f12}.${market}`;
    return {
      thscode,
      name: d.f14,
      price: Number(d.f2),
      changePct: Number(d.f3),
      changeAmt: Number(d.f4),
      volumeRaw: Number(d.f5),       // 手
      turnoverRaw: Number(d.f6),     // 元
      turnoverYuan: Number(d.f6),
      turnoverYi: toYi(Number(d.f6)),
      open: Number(d.f17),
      prevClose: Number(d.f18),
      high: Number(d.f15),
      low: Number(d.f16),
      timestampSec: d.f124,
      rawSample: d,
    };
  });
  return {
    provider: 'eastmoney',
    url,
    ok: items.length === SYMBOLS.length,
    status: res.status,
    latencyMs: res.latencyMs,
    bytes: res.bytes,
    count: items.length,
    items,
  };
}

async function testTencentSnapshot() {
  const codes = SYMBOLS.map((s) => s.txCode).join(',');
  const url = `https://qt.gtimg.cn/q=${codes}`;
  const res = await fetchTimed(url, {
    headers: { Referer: 'https://gu.qq.com/' },
  });
  if (!res.ok) {
    return { provider: 'tencent', url, ok: false, status: res.status, latencyMs: res.latencyMs, error: res.error, items: [] };
  }
  const text = decodeGbk(res.buffer);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const m = line.match(/^v_(sh|sz)(\d{6})="(.+)";?$/);
    if (!m) continue;
    const market = m[1].toUpperCase();
    const code = m[2];
    const parts = m[3].split('~');
    const f35 = (parts[35] || '').split('/'); // 价/量/额(元)
    const f37Wan = Number(parts[37]);         // 成交额（万元）
    const f35Yuan = f35.length >= 3 ? Number(f35[2]) : null;
    items.push({
      thscode: `${code}.${market}`,
      name: parts[1],
      price: Number(parts[3]),
      prevClose: Number(parts[4]),
      open: Number(parts[5]),
      changeAmt: Number(parts[31]),
      changePct: Number(parts[32]),
      high: Number(parts[33]),
      low: Number(parts[34]),
      volumeF6: Number(parts[6]),
      volumeF36: Number(parts[36]),
      turnoverF37Raw: f37Wan,               // 万元
      turnoverF35YuanRaw: f35Yuan,          // 元
      turnoverYuanFromF37: f37Wan * 10000,
      turnoverYiFromF37: toYi(f37Wan * 10000),
      turnoverYiFromF35: f35Yuan !== null ? toYi(f35Yuan) : null,
      timeStr: parts[30],
      field35Raw: parts[35],
    });
  }
  return {
    provider: 'tencent',
    url,
    ok: items.length === SYMBOLS.length,
    status: res.status,
    latencyMs: res.latencyMs,
    bytes: res.bytes,
    count: items.length,
    items,
  };
}

async function testSinaSnapshot() {
  const codes = SYMBOLS.map((s) => s.sinaCode).join(',');
  const url = `https://hq.sinajs.cn/list=${codes}`;
  const res = await fetchTimed(url, {
    headers: { Referer: 'https://finance.sina.com.cn/' },
  });
  if (!res.ok) {
    return { provider: 'sina', url, ok: false, status: res.status, latencyMs: res.latencyMs, error: res.error, items: [] };
  }
  const text = decodeGbk(res.buffer);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const m = line.match(/^var hq_str_(sh|sz)(\d{6})="(.*)";?$/);
    if (!m || !m[3]) continue;
    const market = m[1].toUpperCase();
    const code = m[2];
    const parts = m[3].split(',');
    const price = Number(parts[3]);
    const prevClose = Number(parts[2]);
    const changeAmt = Math.round((price - prevClose) * 10000) / 10000;
    const changePct = prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
    items.push({
      thscode: `${code}.${market}`,
      name: parts[0],
      open: Number(parts[1]),
      prevClose,
      price,
      high: Number(parts[4]),
      low: Number(parts[5]),
      changeAmt,
      changePct,
      volumeRaw: Number(parts[8]),
      turnoverRaw: Number(parts[9]),
      turnoverYuan: Number(parts[9]),
      turnoverYi: toYi(Number(parts[9])),
      dateStr: parts[30],
      timeStr: parts[31],
    });
  }
  return {
    provider: 'sina',
    url,
    ok: items.length === SYMBOLS.length,
    status: res.status,
    latencyMs: res.latencyMs,
    bytes: res.bytes,
    count: items.length,
    items,
  };
}

// ============================================================
// 2. 分时 / 1 分钟接口测试（今 + 昨）
// ============================================================

async function testEastmoneyTrends2(sym, iscr = 1, host = 'push2his.eastmoney.com') {
  const url = `https://${host}/api/qt/stock/trends2/get?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=2&iscr=${iscr}&secid=${sym.emSecid}`;
  const res = await fetchTimed(url, {
    headers: { Referer: 'https://quote.eastmoney.com/' },
  });
  if (!res.ok) {
    return { thscode: sym.thscode, host, iscr, ok: false, status: res.status, latencyMs: res.latencyMs, error: res.error };
  }
  let json;
  try {
    json = JSON.parse(res.buffer.toString('utf8'));
  } catch (err) {
    return { thscode: sym.thscode, host, iscr, ok: false, status: res.status, latencyMs: res.latencyMs, error: `JSON_PARSE_ERROR: ${err.message}` };
  }
  const data = json?.data;
  const trends = data?.trends || [];
  const byDate = {};
  for (const row of trends) {
    const parts = row.split(',');
    // f51:时间, f52:开, f53:收(当前), f54:高, f55:低, f56:成交量(手), f57:成交额(元), f58:均价
    const dt = parts[0];
    const [dateStr, timeStr] = dt.split(' ');
    if (!byDate[dateStr]) {
      byDate[dateStr] = { count: 0, firstTime: timeStr, lastTime: timeStr, sumTurnover: 0, sumVolume: 0, pre0930Count: 0, pre0930Turnover: 0, sampleFirst: row, sampleAt0925: null, sampleAt0930: null, sampleAt1130: null, sampleAt1300: null, sampleLast: row };
    }
    const entry = byDate[dateStr];
    const vol = Number(parts[5]);
    const amt = Number(parts[6]);
    entry.count += 1;
    entry.lastTime = timeStr;
    entry.sumTurnover += amt;
    entry.sumVolume += vol;
    entry.sampleLast = row;
    if (timeStr < '09:30') {
      entry.pre0930Count += 1;
      entry.pre0930Turnover += amt;
    }
    if (timeStr === '09:25') entry.sampleAt0925 = row;
    if (timeStr === '09:30') entry.sampleAt0930 = row;
    if (timeStr === '11:30') entry.sampleAt1130 = row;
    if (timeStr === '13:00') entry.sampleAt1300 = row;
  }
  const dateSummary = Object.entries(byDate).map(([date, info]) => ({
    date,
    count: info.count,
    firstTime: info.firstTime,
    lastTime: info.lastTime,
    pre0930Count: info.pre0930Count,
    pre0930TurnoverYi: toYi(info.pre0930Turnover),
    sumTurnoverYuan: Math.round(info.sumTurnover),
    sumTurnoverYi: toYi(info.sumTurnover),
    sumVolume: info.sumVolume,
    sampleFirst: info.sampleFirst,
    sampleAt0925: info.sampleAt0925,
    sampleAt0930: info.sampleAt0930,
    sampleAt1130: info.sampleAt1130,
    sampleAt1300: info.sampleAt1300,
    sampleLast: info.sampleLast,
  }));
  return {
    thscode: sym.thscode,
    host,
    iscr,
    ok: trends.length > 0,
    status: res.status,
    latencyMs: res.latencyMs,
    bytes: res.bytes,
    preClose: data?.preClose,
    prePrice: data?.prePrice,
    trendsTotal: data?.trendsTotal,
    totalRows: trends.length,
    dates: dateSummary,
  };
}

async function testTencentIntraday(sym) {
  const results = {};

  // A: 当日分时 minute/query
  const minUrl = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sym.txCode}`;
  const minRes = await fetchTimed(minUrl, { headers: { Referer: 'https://gu.qq.com/' } });
  if (minRes.ok) {
    try {
      const json = JSON.parse(minRes.buffer.toString('utf8'));
      const d = json?.data?.[sym.txCode]?.data;
      const arr = d?.data || [];
      results.minuteQuery = {
        ok: arr.length > 0,
        status: minRes.status,
        latencyMs: minRes.latencyMs,
        date: d?.date,
        count: arr.length,
        sampleFirst3: arr.slice(0, 3),
        sampleLast3: arr.slice(-3),
      };
    } catch (e) {
      results.minuteQuery = { ok: false, error: String(e) };
    }
  } else {
    results.minuteQuery = { ok: false, status: minRes.status, error: minRes.error };
  }

  // B: 5日分时 day/query (检查是否含今+昨及成交额)
  const dayUrl = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${sym.txCode}`;
  const dayRes = await fetchTimed(dayUrl, { headers: { Referer: 'https://gu.qq.com/' } });
  if (dayRes.ok) {
    try {
      const json = JSON.parse(dayRes.buffer.toString('utf8'));
      const days = json?.data?.[sym.txCode]?.data || [];
      results.dayQuery = {
        ok: days.length > 0,
        status: dayRes.status,
        latencyMs: dayRes.latencyMs,
        dayCount: days.length,
        days: days.map((d) => ({
          date: d.date,
          prec: d.prec,
          count: d.data?.length || 0,
          sampleFirst: d.data?.[0],
          sampleAt1130: d.data?.find((r) => r.startsWith('1130')),
          sampleAt1300: d.data?.find((r) => r.startsWith('1300')),
          sampleLast: d.data?.[d.data.length - 1],
        })),
      };
    } catch (e) {
      results.dayQuery = { ok: false, error: String(e) };
    }
  } else {
    results.dayQuery = { ok: false, status: dayRes.status, error: dayRes.error };
  }

  // C: 1分钟 K 线 mkline
  const mkUrl = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${sym.txCode},m1,,500`;
  const mkRes = await fetchTimed(mkUrl, { headers: { Referer: 'https://gu.qq.com/' } });
  if (mkRes.ok) {
    try {
      const json = JSON.parse(mkRes.buffer.toString('utf8'));
      const arr = json?.data?.[sym.txCode]?.m1 || [];
      results.mkline = {
        ok: arr.length > 0,
        status: mkRes.status,
        latencyMs: mkRes.latencyMs,
        count: arr.length,
        sampleFirst: arr[0],
        sampleLast: arr[arr.length - 1],
      };
    } catch (e) {
      results.mkline = { ok: false, error: String(e) };
    }
  } else {
    results.mkline = { ok: false, status: mkRes.status, error: mkRes.error };
  }

  return { thscode: sym.thscode, ...results };
}

async function testSinaKline(sym) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym.sinaCode}&scale=5&ma=no&datalen=10`;
  const res = await fetchTimed(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  if (!res.ok) {
    return { thscode: sym.thscode, ok: false, status: res.status, latencyMs: res.latencyMs, error: res.error };
  }
  try {
    const json = JSON.parse(res.buffer.toString('utf8'));
    return {
      thscode: sym.thscode,
      ok: Array.isArray(json) && json.length > 0,
      status: res.status,
      latencyMs: res.latencyMs,
      count: Array.isArray(json) ? json.length : 0,
      sampleFirst: Array.isArray(json) ? json[0] : null,
      sampleLast: Array.isArray(json) ? json[json.length - 1] : null,
    };
  } catch (e) {
    return { thscode: sym.thscode, ok: false, status: res.status, latencyMs: res.latencyMs, error: String(e), textPreview: res.buffer.toString('utf8').slice(0, 120) };
  }
}

// ============================================================
// 3. 同花顺 Fuyao API 最小有界探测
// ============================================================

async function testHithink() {
  const { key, source } = resolveHithinkKey();
  if (!key) {
    return { configured: false, source, skipped: true };
  }

  const base = 'https://fuyao.aicubes.cn';
  const headers = { 'X-api-key': key };

  async function probe(name, endpoint) {
    const res = await fetchTimed(`${base}${endpoint}`, { headers, timeoutMs: 15000 });
    let body = null;
    try {
      body = JSON.parse(res.buffer.toString('utf8'));
    } catch {
      body = null;
    }
    return {
      name,
      endpoint,
      httpStatus: res.status,
      latencyMs: res.latencyMs,
      code: body?.code ?? null,
      message: body?.message ?? res.error,
      requestId: body?.request_id ?? null,
      data: body?.code === 0 ? body.data : null,
    };
  }

  const calendar = await probe('trading_days', '/api/a-share/calendar/trading-days');
  await sleep(600);
  const search = await probe('ticker_search', '/api/meta/tickers/search?q=' + encodeURIComponent('贵州茅台') + '&limit=5');
  await sleep(600);
  const indexSnap = await probe(
    'index_snapshot',
    '/api/a-share-index/prices/snapshot?thscodes=000001.SH,399106.SZ,399001.SZ,399006.SZ,399102.SZ,000688.SH'
  );
  await sleep(600);
  const stockSnap = await probe(
    'stock_snapshot',
    '/api/a-share/prices/snapshot?thscodes=600519.SH,300750.SZ'
  );

  const calItems = calendar.data?.item || [];
  return {
    configured: true,
    source,
    calendar: {
      httpStatus: calendar.httpStatus,
      code: calendar.code,
      message: calendar.message,
      latencyMs: calendar.latencyMs,
      count: calItems.length,
      first: calItems[0] || null,
      last5: calItems.slice(-5),
    },
    search: {
      httpStatus: search.httpStatus,
      code: search.code,
      message: search.message,
      latencyMs: search.latencyMs,
      count: search.data?.item?.length || 0,
      items: search.data?.item || [],
    },
    indexSnapshot: {
      httpStatus: indexSnap.httpStatus,
      code: indexSnap.code,
      message: indexSnap.message,
      latencyMs: indexSnap.latencyMs,
      timestamp: indexSnap.data?.timestamp ?? null,
      items: (indexSnap.data?.item || []).map((x) => ({
        ...x,
        turnoverYi: toYi(Number(x.turnover)),
      })),
    },
    stockSnapshot: {
      httpStatus: stockSnap.httpStatus,
      code: stockSnap.code,
      message: stockSnap.message,
      latencyMs: stockSnap.latencyMs,
      timestamp: stockSnap.data?.timestamp ?? null,
      items: (stockSnap.data?.item || []).map((x) => ({
        ...x,
        turnoverYi: toYi(Number(x.turnover)),
      })),
    },
  };
}

// ============================================================
// 4. 有界轮询压测（3s × 20 次 & 5s × 12 次）
// ============================================================

async function runStressLoop(name, fn, intervalMs, count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const iterStart = performance.now();
    const r = await fn();
    records.push({
      seq: i + 1,
      ok: r.ok,
      status: r.status,
      latencyMs: r.latencyMs,
      count: r.count ?? 0,
      error: r.error ?? null,
    });
    if (i < count - 1) {
      const elapsed = performance.now() - iterStart;
      const wait = Math.max(0, intervalMs - elapsed);
      await sleep(wait);
    }
  }
  const okRecords = records.filter((r) => r.ok);
  const latencies = okRecords.map((r) => r.latencyMs);
  return {
    provider: name,
    intervalMs,
    total: count,
    success: okRecords.length,
    failed: count - okRecords.length,
    successRatePct: Math.round((okRecords.length / count) * 1000) / 10,
    latencyMinMs: latencies.length ? Math.min(...latencies) : null,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: latencies.length ? Math.max(...latencies) : null,
    errors: records.filter((r) => !r.ok).map((r) => ({ seq: r.seq, status: r.status, error: r.error })),
  };
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[Phase 0 Spike] Started at ${startedAt}`);

  console.log('\n--- 1. Batch Snapshot Probes ---');
  const [emSnap, txSnap, sinaSnap] = await Promise.all([
    testEastmoneySnapshot(),
    testTencentSnapshot(),
    testSinaSnapshot(),
  ]);
  for (const s of [emSnap, txSnap, sinaSnap]) {
    console.log(`[${s.provider}] ok=${s.ok} status=${s.status} latency=${s.latencyMs}ms count=${s.count ?? 0}/${SYMBOLS.length} error=${s.error ?? 'none'}`);
  }

  console.log('\n--- 2. Hithink Fuyao Minimal Probe ---');
  const hithink = await testHithink();
  if (hithink.configured) {
    console.log(`[hithink] source=${hithink.source} cal=${hithink.calendar.code}(${hithink.calendar.count}d,${hithink.calendar.latencyMs}ms) search=${hithink.search.code}(${hithink.search.count},${hithink.search.latencyMs}ms) idx=${hithink.indexSnapshot.code}(${hithink.indexSnapshot.items.length},${hithink.indexSnapshot.latencyMs}ms) stk=${hithink.stockSnapshot.code}(${hithink.stockSnapshot.items.length},${hithink.stockSnapshot.latencyMs}ms)`);
  } else {
    console.log('[hithink] not configured');
  }

  console.log('\n--- 3. Cross-Source Turnover Verification (亿元) ---');
  const comparison = SYMBOLS.map((sym) => {
    const em = emSnap.items.find((i) => i.thscode === sym.thscode);
    const tx = txSnap.items.find((i) => i.thscode === sym.thscode);
    const sina = sinaSnap.items.find((i) => i.thscode === sym.thscode);
    const ths = hithink.configured
      ? [...(hithink.indexSnapshot.items || []), ...(hithink.stockSnapshot.items || [])].find((i) => i.thscode === sym.thscode)
      : null;
    return {
      thscode: sym.thscode,
      name: sym.name,
      eastmoney_yi: em?.turnoverYi ?? null,
      tencent_f37_yi: tx?.turnoverYiFromF37 ?? null,
      tencent_f35_yi: tx?.turnoverYiFromF35 ?? null,
      sina_yi: sina?.turnoverYi ?? null,
      hithink_yi: ths?.turnoverYi ?? null,
      price_em: em?.price ?? null,
      price_tx: tx?.price ?? null,
      price_ths: ths?.last_price ?? null,
    };
  });
  console.table(comparison);

  console.log('\n--- 4. Intraday 1-Min (Today + Prev Day) Probes ---');
  // 东财 trends2 全 8 标的（iscr=1，含竞价与对照 399102.SZ）并测冷启动串行耗时
  const emTrendsStart = performance.now();
  const emTrendsAll = [];
  for (const sym of SYMBOLS) {
    const r = await testEastmoneyTrends2(sym, 1, 'push2his.eastmoney.com');
    emTrendsAll.push(r);
    await sleep(150);
  }
  const emTrendsBatchMs = Math.round(performance.now() - emTrendsStart);
  // 也对比一次 iscr=0 与 push2.eastmoney.com（仅对 000001.SH）
  const emTrendsNoAuction = await testEastmoneyTrends2(SYMBOLS[0], 0, 'push2his.eastmoney.com');
  const emTrendsPush2 = await testEastmoneyTrends2(SYMBOLS[0], 1, 'push2.eastmoney.com');

  for (const r of emTrendsAll) {
    const datesDesc = (r.dates || []).map((d) => `${d.date}:${d.count}条(sum=${d.sumTurnoverYi}亿,pre0930=${d.pre0930Count}/${d.pre0930TurnoverYi}亿)`).join(' | ');
    console.log(`[em trends2] ${r.thscode} ok=${r.ok} ${r.latencyMs}ms => ${datesDesc}`);
  }
  console.log(`[em trends2 batch ${SYMBOLS.length} symbols] total=${emTrendsBatchMs}ms`);

  // 腾讯分时与分钟线（覆盖全部测试标的）
  const txIntraday = [];
  for (const sym of SYMBOLS) {
    const r = await testTencentIntraday(sym);
    txIntraday.push(r);
    console.log(`[tx intraday] ${sym.thscode} min=${r.minuteQuery?.ok}(${r.minuteQuery?.count}) day=${r.dayQuery?.ok}(${r.dayQuery?.dayCount}d) mkline=${r.mkline?.ok}(${r.mkline?.count})`);
  }

  // 新浪 5 分钟 K 线测试
  const sinaKline = await testSinaKline(SYMBOLS[0]);
  console.log(`[sina kline 5m] ${SYMBOLS[0].thscode} ok=${sinaKline.ok} status=${sinaKline.status} count=${sinaKline.count ?? 0}`);

  let stress3s = null;
  let stress5s = null;
  if (!skipStress) {
    console.log('\n--- 5. Bounded Rate-Limit Stress Tests ---');
    console.log('Running 3s x 20 batch requests in parallel across Eastmoney / Tencent / Sina (~60s)...');
    stress3s = await Promise.all([
      runStressLoop('eastmoney', testEastmoneySnapshot, 3000, 20),
      runStressLoop('tencent', testTencentSnapshot, 3000, 20),
      runStressLoop('sina', testSinaSnapshot, 3000, 20),
    ]);
    console.table(stress3s.map(({ errors, ...rest }) => ({ ...rest, errCount: errors.length })));

    console.log('Running 5s x 12 batch requests in parallel across Eastmoney / Tencent / Sina (~55s)...');
    stress5s = await Promise.all([
      runStressLoop('eastmoney', testEastmoneySnapshot, 5000, 12),
      runStressLoop('tencent', testTencentSnapshot, 5000, 12),
      runStressLoop('sina', testSinaSnapshot, 5000, 12),
    ]);
    console.table(stress5s.map(({ errors, ...rest }) => ({ ...rest, errCount: errors.length })));
  }

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    nodeVersion: process.version,
    snapshots: {
      eastmoney: emSnap,
      tencent: txSnap,
      sina: sinaSnap,
    },
    hithink,
    comparison,
    intraday: {
      eastmoneyTrends2All: emTrendsAll,
      eastmoneyTrends2BatchMs: emTrendsBatchMs,
      eastmoneyTrends2NoAuction: emTrendsNoAuction,
      eastmoneyTrends2Push2Host: emTrendsPush2,
      tencentIntraday: txIntraday,
      sinaKline5m: sinaKline,
    },
    stress: {
      interval3s: stress3s,
      interval5s: stress5s,
    },
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nSaved full probe report to ${outPath}`);
  }
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exitCode = 1;
});
