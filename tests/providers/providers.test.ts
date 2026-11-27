import { describe, expect, it, vi } from 'vitest';
import {
  EastmoneyProvider,
  HithinkProvider,
  ProviderRequestError,
  SinaProvider,
  TencentProvider,
  parseEastmoneyIntradayResponse,
  parseEastmoneySearchResponse,
  parseEastmoneySnapshotResponse,
  parseHithinkSearchResults,
  parseHithinkSnapshotData,
  parseSinaSnapshotResponse,
  parseTencentIntradayResponse,
  parseTencentSearchResponse,
  parseTencentSnapshotResponse,
  type FetchLike,
} from '../../src/main/providers';

// "上证指数" 的真实 GB18030 字节编码
const GB18030_SH_INDEX_NAME = Buffer.from([0xc9, 0xcf, 0xd6, 0xa4, 0xd6, 0xb8, 0xca, 0xfd]);

function encodeAsciiWithGb18030Name(templateWithPlaceholder: string): Buffer {
  const parts = templateWithPlaceholder.split('__GB_NAME__');
  const buffers: Buffer[] = [];
  for (let i = 0; i < parts.length; i++) {
    buffers.push(Buffer.from(parts[i], 'ascii'));
    if (i < parts.length - 1) {
      buffers.push(GB18030_SH_INDEX_NAME);
    }
  }
  return Buffer.concat(buffers);
}

function buildTencentLine(params: {
  txCode: string;
  name: string;
  code: string;
  price: string;
  prevClose: string;
  open: string;
  volHands: string;
  timeStr: string;
  changeAmt: string;
  changePct: string;
  high: string;
  low: string;
  f35: string;
  f37Wan: string;
}): string {
  const fields = new Array<string>(45).fill('0');
  fields[0] = '1';
  fields[1] = params.name;
  fields[2] = params.code;
  fields[3] = params.price;
  fields[4] = params.prevClose;
  fields[5] = params.open;
  fields[6] = params.volHands;
  fields[30] = params.timeStr;
  fields[31] = params.changeAmt;
  fields[32] = params.changePct;
  fields[33] = params.high;
  fields[34] = params.low;
  fields[35] = params.f35;
  fields[36] = params.volHands;
  fields[37] = params.f37Wan;
  return `v_${params.txCode}="${fields.join('~')}";`;
}

function buildSinaLine(params: {
  sinaCode: string;
  name: string;
  open: string;
  prevClose: string;
  price: string;
  high: string;
  low: string;
  volume: string;
  turnoverYuan: string;
  dateStr: string;
  timeStr: string;
}): string {
  const fields = new Array<string>(33).fill('0');
  fields[0] = params.name;
  fields[1] = params.open;
  fields[2] = params.prevClose;
  fields[3] = params.price;
  fields[4] = params.high;
  fields[5] = params.low;
  fields[8] = params.volume;
  fields[9] = params.turnoverYuan;
  fields[30] = params.dateStr;
  fields[31] = params.timeStr;
  return `var hq_str_${params.sinaCode}="${fields.join(',')}";`;
}

describe('TencentProvider parsers & HTTP', () => {
  it('parses batch snapshots with exact yuan from f35, fallback to f37*10000, and hands->shares conversion', () => {
    const sample = [
      buildTencentLine({
        txCode: 'sh000001',
        name: '上证指数',
        code: '000001',
        price: '3548.37',
        prevClose: '3538.95',
        open: '3567.84',
        volHands: '493526296',
        timeStr: '20261124150003',
        changeAmt: '9.42',
        changePct: '0.27',
        high: '3585.22',
        low: '3539.01',
        f35: '3548.37/493526296/771861010309',
        f37Wan: '77186101',
      }),
      // f35 缺失第三段时自动回退至 f37(万元) × 10000
      buildTencentLine({
        txCode: 'sz399106',
        name: '深证综指',
        code: '399106',
        price: '1965.43',
        prevClose: '1950.00',
        open: '1955.00',
        volHands: '590663196',
        timeStr: '20261124150003',
        changeAmt: '15.43',
        changePct: '0.79',
        high: '1970.00',
        low: '1948.00',
        f35: '1965.43/590663196/',
        f37Wan: '88322492',
      }),
    ].join('\n');

    const map = parseTencentSnapshotResponse(sample);
    expect(map.size).toBe(2);

    const sh = map.get('000001.SH')!;
    expect(sh.name).toBe('上证指数');
    expect(sh.price).toBe(3548.37);
    expect(sh.turnover).toBe(771_861_010_309); // 精确到元
    expect(sh.volumeShares).toBe(49_352_629_600); // 手 × 100
    expect(sh.tradeDate).toBe('2026-11-24');
    expect(sh.source).toBe('tencent');

    const sz = map.get('399106.SZ')!;
    expect(sz.turnover).toBe(883_224_920_000); // 万元 × 10000
    expect(sz.volumeShares).toBe(59_066_319_600);
  });

  it('cleans day/query intraday bars: extracts 0930 auction, drops 1300 duplicate & >1500 after-hours, never zero-fills gaps', () => {
    const payload = {
      data: {
        sh600519: {
          data: [
            {
              date: '20261124',
              prec: '1450.00',
              data: [
                '0930 1425.00 763 108727500.00', // 开盘竞价锚点
                '0931 1430.00 1763 251727500.00', // minuteIndex 0
                // 刻意缺失 0932（minuteIndex 1）验证不补零
                '0933 1435.00 2263 323477500.00', // minuteIndex 2
                '1130 1440.00 20000 2880000000.00', // minuteIndex 119
                '1300 1440.00 20000 2880000000.00', // 腾讯午休重复节点 → 必须丢弃
                '1301 1442.00 20500 2952100000.00', // minuteIndex 120
                '1500 1460.00 42562 6214192454.00', // minuteIndex 239
                '1505 1460.00 42568 6215068454.00', // 盘后固定价格交易 → 必须丢弃
                '1530 1460.00 42568 6215068454.00', // 盘后固定价格交易 → 必须丢弃
              ],
            },
          ],
        },
      },
    };

    const days = parseTencentIntradayResponse(payload, '600519.SH', 2);
    expect(days).toHaveLength(1);
    const day = days[0];
    expect(day.tradeDate).toBe('2026-11-24');
    expect(day.auction).toEqual({ openPrice: 1425, auctionTurnover: 108_727_500 });
    expect(day.bars.map((b) => b.minuteIndex)).toEqual([0, 2, 119, 120, 239]);
    // 验证未补零 minuteIndex 1
    expect(day.bars.find((b) => b.minuteIndex === 1)).toBeUndefined();
    // 验证第 0 分钟纯连续竞价增量 = cum(0931) - auction(0930)
    expect(day.bars[0].barTurnover).toBeCloseTo(143_000_000, 2);
    expect(day.bars[0].cumVolume).toBe(176_300);
    // 验证收盘精确为 1500，不含 1530 盘后额
    expect(day.bars[day.bars.length - 1].cumTurnover).toBe(6_214_192_454);
  });

  it('parses smartbox search response and filters to A-share stocks and indices', () => {
    const raw =
      'v_hint="sz~300750~\\u5b81\\u5fb7\\u65f6\\u4ee3~ndsd~GP-A^hk~00700~\\u817e\\u8baf~tx~GP-HK^sh~000001~\\u4e0a\\u8bc1\\u6307\\u6570~szzs~ZS";';
    const items = parseTencentSearchResponse(raw, 10);
    expect(items).toEqual([
      {
        symbol: '300750.SZ',
        ticker: '300750',
        name: '宁德时代',
        exchange: 'SZ',
        assetType: 'STOCK',
        source: 'tencent',
      },
      {
        symbol: '000001.SH',
        ticker: '000001',
        name: '上证指数',
        exchange: 'SH',
        assetType: 'INDEX',
        source: 'tencent',
      },
    ]);
  });

  it('throws rateLimited error on HTTP 429', async () => {
    const mockFetch: FetchLike = vi.fn(async () => new Response('Too Many Requests', { status: 429 }));
    const provider = new TencentProvider({ fetchImpl: mockFetch });
    await expect(provider.fetchBatchSnapshots(['000001.SH'])).rejects.toMatchObject({
      name: 'ProviderRequestError',
      provider: 'tencent',
      httpStatus: 429,
      rateLimited: true,
    });
  });

  it('decodes real GB18030 Chinese names, rejects empty turnover without zero-fill, and chunks >50 symbols', async () => {
    // 1. 真实 GB18030 字节流解码验证
    const gbPayload = encodeAsciiWithGb18030Name(
      buildTencentLine({
        txCode: 'sh000001',
        name: '__GB_NAME__',
        code: '000001',
        price: '3548.37',
        prevClose: '3538.95',
        open: '3567.84',
        volHands: '493526296',
        timeStr: '20261124150003',
        changeAmt: '9.42',
        changePct: '0.27',
        high: '3585.22',
        low: '3539.01',
        f35: '3548.37/493526296/771861010309',
        f37Wan: '77186101',
      })
    );
    const gbFetch: FetchLike = vi.fn(async () => new Response(new Uint8Array(gbPayload), { status: 200 }));
    const gbProvider = new TencentProvider({ fetchImpl: gbFetch });
    const gbSnaps = await gbProvider.fetchBatchSnapshots(['000001.SH']);
    expect(gbSnaps.get('000001.SH')?.name).toBe('上证指数');

    // 2. 空成交额 / 空价格绝不静默补零
    const emptyLine = buildTencentLine({
      txCode: 'sh600519',
      name: '贵州茅台',
      code: '600519',
      price: '1460.00',
      prevClose: '1450.00',
      open: '1455.00',
      volHands: '100',
      timeStr: '20261124103000',
      changeAmt: '10.00',
      changePct: '0.69',
      high: '1465.00',
      low: '1450.00',
      f35: '1460.00/100/',
      f37Wan: '',
    });
    expect(parseTencentSnapshotResponse(emptyLine).size).toBe(0);

    // 3. 乱序分时记录先排序再计算单分钟增量
    const outOfOrderPayload = {
      data: {
        sh600519: {
          data: [
            {
              date: '20261124',
              prec: '1450.00',
              data: [
                '0932 1435.00 2263 323477500.00',
                '0931 1430.00 1763 251727500.00',
                '0930 1425.00 763 108727500.00',
              ],
            },
          ],
        },
      },
    };
    const days = parseTencentIntradayResponse(outOfOrderPayload, '600519.SH', 1);
    expect(days[0].bars.map((b) => b.minuteIndex)).toEqual([0, 1]);
    expect(days[0].bars[0].barTurnover).toBeCloseTo(143_000_000, 2);
    expect(days[0].bars[1].barTurnover).toBeCloseTo(71_750_000, 2);

    // 4. >50 标的自动按 50 分批请求
    const symbols55 = Array.from({ length: 55 }, (_, i) => `${String(600000 + i)}.SH`);
    const batchUrls: string[] = [];
    const batchFetch: FetchLike = vi.fn(async (url) => {
      batchUrls.push(String(url));
      const codes = String(url).split('q=')[1].split(',');
      const body = codes
        .map((code) =>
          buildTencentLine({
            txCode: code,
            name: code,
            code: code.slice(2),
            price: '10.00',
            prevClose: '10.00',
            open: '10.00',
            volHands: '100',
            timeStr: '20261124103000',
            changeAmt: '0',
            changePct: '0',
            high: '10.00',
            low: '10.00',
            f35: '10.00/100/100000',
            f37Wan: '10',
          })
        )
        .join('\n');
      return new Response(body, { status: 200 });
    });
    const batchProvider = new TencentProvider({ fetchImpl: batchFetch });
    const merged = await batchProvider.fetchBatchSnapshots(symbols55);
    expect(batchUrls).toHaveLength(2);
    expect(merged.size).toBe(55);
  });
});

describe('SinaProvider parsers & HTTP', () => {
  it('handles SH-index hands vs SZ-index/stock shares volume trap and matches yuan turnover', () => {
    const sample = [
      buildSinaLine({
        sinaCode: 'sh000001',
        name: '上证指数',
        open: '3567.8405',
        prevClose: '3538.95',
        price: '3548.37',
        high: '3585.22',
        low: '3539.01',
        volume: '493526296', // 沪市指数单位为手！
        turnoverYuan: '771861010309',
        dateStr: '2026-11-24',
        timeStr: '15:00:03',
      }),
      buildSinaLine({
        sinaCode: 'sz399106',
        name: '深证综指',
        open: '1955.00',
        prevClose: '1950.00',
        price: '1965.43',
        high: '1970.00',
        low: '1948.00',
        volume: '59066319600', // 深市指数单位为股！
        turnoverYuan: '883224915526',
        dateStr: '2026-11-24',
        timeStr: '15:00:03',
      }),
      buildSinaLine({
        sinaCode: 'sh600519',
        name: '贵州茅台',
        open: '1425.00',
        prevClose: '1450.00',
        price: '1460.00',
        high: '1465.00',
        low: '1420.00',
        volume: '4256200', // 沪市个股单位为股！
        turnoverYuan: '6214192454',
        dateStr: '2026-11-24',
        timeStr: '15:00:00',
      }),
    ].join('\n');

    const map = parseSinaSnapshotResponse(sample);
    expect(map.get('000001.SH')?.volumeShares).toBe(49_352_629_600); // ×100
    expect(map.get('000001.SH')?.turnover).toBe(771_861_010_309);
    expect(map.get('000001.SH')?.changePct).toBeCloseTo(0.27, 2);

    expect(map.get('399106.SZ')?.volumeShares).toBe(59_066_319_600); // ×1
    expect(map.get('399106.SZ')?.turnover).toBe(883_224_915_526);

    expect(map.get('600519.SH')?.volumeShares).toBe(4_256_200); // ×1
    expect(map.get('600519.SH')?.turnover).toBe(6_214_192_454);
  });

  it('sends required finance.sina.com.cn Referer header, decodes GB18030, and rejects empty turnover', async () => {
    let capturedReferer = '';
    const gbPayload = encodeAsciiWithGb18030Name(
      buildSinaLine({
        sinaCode: 'sh000001',
        name: '__GB_NAME__',
        open: '3567.84',
        prevClose: '3538.95',
        price: '3548.37',
        high: '3585.22',
        low: '3539.01',
        volume: '493526296',
        turnoverYuan: '771861010309',
        dateStr: '2026-11-24',
        timeStr: '15:00:03',
      })
    );
    const mockFetch: FetchLike = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      capturedReferer = headers?.Referer ?? '';
      return new Response(new Uint8Array(gbPayload), { status: 200 });
    });

    const provider = new SinaProvider({ fetchImpl: mockFetch });
    const res = await provider.fetchBatchSnapshots(['000001.SH']);
    expect(capturedReferer).toBe('https://finance.sina.com.cn/');
    expect(res.get('000001.SH')?.name).toBe('上证指数');
    expect(res.get('000001.SH')?.turnover).toBe(771_861_010_309);

    const emptyTurnoverLine = buildSinaLine({
      sinaCode: 'sh600519',
      name: '贵州茅台',
      open: '1450.00',
      prevClose: '1450.00',
      price: '1460.00',
      high: '1465.00',
      low: '1450.00',
      volume: '100',
      turnoverYuan: '',
      dateStr: '2026-11-24',
      timeStr: '10:30:00',
    });
    expect(parseSinaSnapshotResponse(emptyTurnoverLine).size).toBe(0);
  });
});

describe('EastmoneyProvider parsers', () => {
  it('accumulates prefix-sum turnover from f57 starting with 09:30 auction and uses f53 price', () => {
    const payload = {
      data: {
        preClose: 3538.95,
        trends: [
          // 历史日 f52 为 0.00，必须取 f53（index 2）
          '2026-11-23 09:30,0.00,3520.00,3520.00,3520.00,1000,100000000,3520.00',
          '2026-11-23 09:31,0.00,3525.00,3528.00,3518.00,2000,250000000,3523.00',
          '2026-11-24 09:30,3567.84,3567.84,3567.84,3567.84,7725349,12728771688.50,3567.84',
          '2026-11-24 09:31,3567.84,3559.78,3568.00,3558.00,22333229,38616172951.90,3562.00',
          '2026-11-24 13:01,3550.00,3552.00,3553.00,3549.00,5000000,8000000000.00,3551.00',
        ],
      },
    };

    const days = parseEastmoneyIntradayResponse(payload, '000001.SH', 2);
    expect(days).toHaveLength(2);
    expect(days[0].tradeDate).toBe('2026-11-24');
    expect(days[0].auction).toEqual({
      openPrice: 3567.84,
      auctionTurnover: 12_728_771_688.5,
    });
    expect(days[0].bars.map((b) => b.minuteIndex)).toEqual([0, 120]);
    expect(days[0].bars[0].cumTurnover).toBeCloseTo(51_344_944_640.4, 2);
    expect(days[0].bars[0].barTurnover).toBeCloseTo(38_616_172_951.9, 2);
    expect(days[0].prevClose).toBe(3538.95);
    expect(days[1].tradeDate).toBe('2026-11-23');
    // 历史日期不错误套用最新日的 data.preClose
    expect(days[1].prevClose).toBeNull();
    expect(days[1].bars[0].price).toBe(3525);
  });

  it('parses Eastmoney batch snapshot payload and rejects suspended/empty turnover entries', () => {
    const payload = {
      data: {
        diff: [
          {
            f12: '000001',
            f13: 1,
            f14: '上证指数',
            f2: 3548.37,
            f3: 0.27,
            f4: 9.42,
            f5: 493526296,
            f6: 771861010309,
            f15: 3585.22,
            f16: 3539.01,
            f17: 3567.84,
            f18: 3538.95,
            f124: 1795503600,
          },
          // 停牌/缺失成交额绝不补零
          { f12: '600519', f13: 1, f14: '停牌测试', f2: '-', f6: '', f124: 1795503600 },
          { f12: '300750', f13: 0, f14: '空额测试', f2: 227.37, f6: null, f124: 1795503600 },
        ],
      },
    };
    const snaps = parseEastmoneySnapshotResponse(payload);
    expect(snaps.size).toBe(1);
    const sh = snaps.get('000001.SH')!;
    expect(sh.name).toBe('上证指数');
    expect(sh.turnover).toBe(771_861_010_309);
    expect(sh.volumeShares).toBe(49_352_629_600);
    expect(sh.source).toBe('eastmoney');
  });

  it('parses Eastmoney suggest search results accurately', () => {
    const payload = {
      QuotationCodeTable: {
        Data: [
          { Code: '600519', Name: '贵州茅台', MktNum: '1', Classify: 'AStock', SecurityTypeName: '沪A' },
          { Code: '00700', Name: '腾讯控股', MktNum: '116', Classify: 'HK', SecurityTypeName: '港股' },
        ],
      },
    };
    const res = parseEastmoneySearchResponse(payload, 10);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      symbol: '600519.SH',
      name: '贵州茅台',
      exchange: 'SH',
      assetType: 'STOCK',
      source: 'eastmoney',
    });
  });

  it('fetches trends2 from push2his host via EastmoneyProvider', async () => {
    let capturedUrl = '';
    const mockFetch: FetchLike = vi.fn(async (url) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          data: {
            preClose: 3538.95,
            trends: [
              '2026-11-24 09:30,3567.84,3567.84,3567.84,3567.84,1000,1000000,3567.84',
              '2026-11-24 09:31,3567.84,3560.00,3568.00,3559.00,2000,2000000,3562.00',
            ],
          },
        }),
        { status: 200 }
      );
    });

    const provider = new EastmoneyProvider({ fetchImpl: mockFetch });
    const days = await provider.fetchIntradayMinutes('000001.SH', 2);
    expect(capturedUrl).toContain('https://push2his.eastmoney.com/');
    expect(capturedUrl).toContain('ndays=2');
    expect(capturedUrl).toContain('secid=1.000001');
    expect(days[0].bars).toHaveLength(1);
  });
});

describe('HithinkProvider security, parsing & code=4001 backoff', () => {
  it('sends API key strictly via X-api-key header and never exposes it in URL or errors', async () => {
    const secret = 'SUPER-SECRET-HITHINK-TOKEN-XYZ';
    const capturedUrls: string[] = [];
    const capturedKeys: string[] = [];

    const mockFetch: FetchLike = vi.fn(async (url, init) => {
      capturedUrls.push(String(url));
      const headers = init?.headers as Record<string, string>;
      capturedKeys.push(headers?.['X-api-key'] ?? '');

      if (String(url).includes('/calendar/trading-days')) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: { item: [{ date: '20261123' }, { date: '20261124' }] },
          }),
          { status: 200 }
        );
      }

      if (String(url).includes('/a-share-index/prices/snapshot')) {
        return new Response(
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: {
              timestamp: 1795503600000,
              item: [
                {
                  thscode: '000001.SH',
                  last_price: 3548.37,
                  price_change_ratio_pct: 0.27,
                  volume: 49352629600,
                  turnover: 771861010309,
                },
              ],
            },
          }),
          { status: 200 }
        );
      }

      return new Response(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            timestamp: 1795503600000,
            item: [
              {
                thscode: '600519.SH',
                last_price: 1460,
                price_change_ratio_pct: 0.69,
                volume: 4256200,
                turnover: 6214192454,
              },
            ],
          },
        }),
        { status: 200 }
      );
    });

    const provider = new HithinkProvider({
      secretStore: { getApiKey: () => secret },
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    const days = await provider.fetchTradingDays();
    expect(days).toEqual([
      { date: '2026-11-23', isOpen: true },
      { date: '2026-11-24', isOpen: true },
    ]);

    const snaps = await provider.fetchBatchSnapshots(
      ['000001.SH', '600519.SH'],
      new Map([['600519.SH', '贵州茅台']])
    );
    expect(snaps.get('000001.SH')?.name).toBe('上证指数');
    expect(snaps.get('000001.SH')?.turnover).toBe(771_861_010_309);
    expect(snaps.get('600519.SH')?.name).toBe('贵州茅台');
    expect(snaps.get('600519.SH')?.volumeShares).toBe(4_256_200);

    expect(capturedUrls.every((u) => !u.includes(secret))).toBe(true);
    expect(capturedKeys.every((k) => k === secret)).toBe(true);
  });

  it('retries code=4001 with exponential backoff up to 3 times and fails without leaking key', async () => {
    const secret = 'DO-NOT-LEAK-4001-KEY';
    const backoffDelays: number[] = [];
    let calls = 0;

    const mockFetch: FetchLike = vi.fn(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ code: 4001, message: 'rate limit exceeded' }),
        { status: 200 }
      );
    });

    const provider = new HithinkProvider({
      secretStore: { getApiKey: () => secret },
      fetchImpl: mockFetch,
      sleepImpl: async (ms) => {
        backoffDelays.push(ms);
      },
      initialBackoffMs: 100,
      maxRetries: 3,
    });

    let caught: unknown = null;
    try {
      await provider.fetchTradingDays();
    } catch (err) {
      caught = err;
    }

    expect(calls).toBe(4); // 首次 + 最多重试 3 次
    expect(backoffDelays).toEqual([100, 200, 400]);
    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect((caught as ProviderRequestError).apiCode).toBe(4001);
    expect((caught as ProviderRequestError).rateLimited).toBe(true);
    expect(String(caught)).not.toContain(secret);
  });

  it('parses ticker search results, rejects empty turnover, and chunks >50 stock snapshots', async () => {
    const searchItems = parseHithinkSearchResults(
      {
        item: [
          { thscode: '600519.SH', ticker: '600519', name: '贵州茅台', exchange: 'SH', asset_type: 'stock' },
          { thscode: '000001.SH', ticker: '000001', name: '上证指数', exchange: 'SH', asset_type: 'index' },
          { thscode: '830799.BJ', ticker: '830799', name: '北证测试', exchange: 'BJ', asset_type: 'stock' },
          { thscode: '600519.SH', ticker: '600519', name: '重复项', exchange: 'SH', asset_type: 'stock' },
        ],
      },
      10
    );
    expect(searchItems).toEqual([
      { symbol: '600519.SH', ticker: '600519', name: '贵州茅台', exchange: 'SH', assetType: 'STOCK', source: 'hithink' },
      { symbol: '000001.SH', ticker: '000001', name: '上证指数', exchange: 'SH', assetType: 'INDEX', source: 'hithink' },
    ]);

    const emptyTurnoverSnaps = parseHithinkSnapshotData(
      {
        timestamp: 1795503600000,
        item: [
          { thscode: '600519.SH', last_price: 1460, turnover: '' },
          { thscode: '300750.SZ', last_price: 227, turnover: null as unknown as number },
        ],
      },
      1795503600000
    );
    expect(emptyTurnoverSnaps.size).toBe(0);

    // >50 只个股按 50 分批请求
    const stock55 = Array.from({ length: 55 }, (_, i) => `${String(600000 + i)}.SH`);
    const capturedUrls: string[] = [];
    const mockFetch: FetchLike = vi.fn(async (url) => {
      capturedUrls.push(String(url));
      const encoded = String(url).split('thscodes=')[1] ?? '';
      const syms = decodeURIComponent(encoded).split(',');
      return new Response(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            timestamp: 1795503600000,
            item: syms.map((s) => ({
              thscode: s,
              last_price: 10,
              price_change_ratio_pct: 0,
              volume: 1000,
              turnover: 10000,
            })),
          },
        }),
        { status: 200 }
      );
    });
    const provider = new HithinkProvider({
      secretStore: { getApiKey: () => 'chunk-test-key' },
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });
    const merged = await provider.fetchBatchSnapshots(stock55);
    expect(capturedUrls).toHaveLength(2);
    expect(merged.size).toBe(55);
  });
});
