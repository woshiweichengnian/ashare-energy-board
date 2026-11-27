import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/main/storage/database';
import { WatchlistService } from '../../src/main/storage/watchlistService';

const openDbs: AppDatabase[] = [];

function createMemoryDb(): AppDatabase {
  const db = new AppDatabase(':memory:');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe('WatchlistService', () => {
  it('supports add, deduplication, reorder, per-symbol alert toggle, custom thresholds, and delete', () => {
    const db = createMemoryDb();
    const service = new WatchlistService(db);

    service.add({ symbol: '600519.sh', name: '贵州茅台' });
    service.add({ symbol: '300750.SZ', name: '宁德时代' });
    service.add({ symbol: '002594.sz', name: '比亚迪' });

    // 重复添加应更新名称而不产生重复项
    let rows = service.add({ symbol: '600519.SH', name: '贵州茅台(龙头)' });
    expect(rows.map((r) => [r.symbol, r.name, r.sortOrder])).toEqual([
      ['600519.SH', '贵州茅台(龙头)', 0],
      ['300750.SZ', '宁德时代', 1],
      ['002594.SZ', '比亚迪', 2],
    ]);

    // 拖拽排序：比亚迪 -> 宁德时代 -> 贵州茅台
    rows = service.reorder(['002594.SZ', '300750.SZ', '600519.SH']);
    expect(rows.map((r) => [r.symbol, r.sortOrder])).toEqual([
      ['002594.SZ', 0],
      ['300750.SZ', 1],
      ['600519.SH', 2],
    ]);

    // 单股关闭提醒 + 设置自定义阈值
    rows = service.update({
      symbol: '300750.SZ',
      alertEnabled: false,
      customThresholds: {
        slopeWindow: 3,
        surgeSlopeThreshold: 2.0,
        surgeMultipleThreshold: 1.8,
        matchMode: 'OR',
        cooldownMinutes: 10,
      },
    });
    const catl = rows.find((r) => r.symbol === '300750.SZ')!;
    expect(catl.alertEnabled).toBe(false);
    expect(JSON.parse(catl.customThresholdsJson!)).toEqual({
      slopeWindow: 3,
      surgeSlopeThreshold: 2,
      surgeMultipleThreshold: 1.8,
      matchMode: 'OR',
      cooldownMinutes: 10,
    });

    // 清除自定义阈值恢复跟随全局
    rows = service.update({ symbol: '300750.SZ', customThresholds: null });
    expect(rows.find((r) => r.symbol === '300750.SZ')?.customThresholdsJson).toBeNull();

    // 删除中间项后重新紧凑排序
    rows = service.remove('300750.SZ');
    expect(rows.map((r) => [r.symbol, r.sortOrder])).toEqual([
      ['002594.SZ', 0],
      ['600519.SH', 1],
    ]);

    // 模拟重启重新读取持久化一致
    const reloaded = new WatchlistService(db).list();
    expect(reloaded.map((r) => r.symbol)).toEqual(['002594.SZ', '600519.SH']);
  });

  it('rejects invalid non-SH/SZ symbols and monitored core indices', () => {
    const db = createMemoryDb();
    const service = new WatchlistService(db);
    expect(() => service.add({ symbol: '830799.BJ', name: '北证测试' })).toThrow();
    expect(() => service.add({ symbol: 'INVALID', name: '无效代码' })).toThrow();

    // 五大基础固定监控指数（含科创综指与深证综指）严禁重复加入自选股
    for (const idx of ['000001.SH', '399001.SZ', '399006.SZ', '000680.SH', '399106.SZ']) {
      expect(() => service.add({ symbol: idx, name: '核心指数' })).toThrow(/核心大盘指数/);
    }

    // 四大可选扩展指数引导至设置中开启，避免与展示配置重复
    for (const idx of ['000016.SH', '000300.SH', '000852.SH', '000688.SH']) {
      expect(() => service.add({ symbol: idx, name: '扩展指数' })).toThrow(/指数展示配置/);
    }
  });
});
