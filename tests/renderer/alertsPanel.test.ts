import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AlertsPanel, type AlertsPanelProps } from '../../src/renderer/src/detail/AlertsPanel';
import type { AlertEventRow } from '../../src/shared/types';

function makeAlert(overrides: Partial<AlertEventRow> & { id: number }): AlertEventRow {
  return {
    symbol: '300750.SZ',
    name: '宁德时代',
    tradeDate: '2026-11-25',
    minuteIndex: 45,
    direction: 'SURGE',
    slope: 4.12,
    windowMultiple: 1.88,
    cumRatio: 0.21,
    message: '宁德时代触发快速放量',
    createdAt: Date.parse('2026-11-25T02:15:00.000Z'),
    isRead: false,
    ...overrides,
  };
}

function renderPanel(overrides?: Partial<AlertsPanelProps>): string {
  const props: AlertsPanelProps = {
    alerts: [
      makeAlert({ id: 1, name: '宁德时代', isRead: false }),
      makeAlert({ id: 2, symbol: '600519.SH', name: '贵州茅台', direction: 'SHRINK', isRead: true }),
    ],
    scope: 'today',
    tradeDate: '2026-11-25',
    isDev: false,
    onScopeChange: vi.fn(),
    onRefresh: vi.fn(),
    onMarkRead: vi.fn(),
    onMarkAllRead: vi.fn(),
    onSimulate: vi.fn(async () => {}),
    onJumpToChart: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(createElement(AlertsPanel, props));
}

describe('AlertsPanel read/unread UI', () => {
  it('distinguishes unread and read rows and exposes mark-read and mark-all-read actions', () => {
    const html = renderPanel();

    // 计数与全部已读按钮
    expect(html).toContain('未读 (1)');
    expect(html).toContain('已读 (1)');
    expect(html).toContain('全部已读 (1)');
    expect(html).not.toMatch(/disabled=""[^>]*>全部已读/);

    // 未读行包含未读圆点、未读角标与单条「标为已读」按钮；已读行使用 read 样式与已读角标
    expect(html).toContain('alert-row clickable surge unread');
    expect(html).toContain('alert-row clickable shrink read');
    expect(html).toContain('unread-dot');
    expect(html).toContain('>未读</span>');
    expect(html).toContain('>已读</span>');
    expect((html.match(/>标为已读</g) ?? []).length).toBe(1);
  });

  it('disables mark-all-read button and hides unread dots when all alerts are read', () => {
    const html = renderPanel({
      alerts: [
        makeAlert({ id: 1, isRead: true }),
        makeAlert({ id: 2, isRead: true }),
      ],
    });

    expect(html).toContain('未读 (0)');
    expect(html).toContain('已读 (2)');
    expect(html).toMatch(/disabled=""[^>]*>全部已读</);
    expect(html).not.toContain('unread-dot');
    expect(html).not.toContain('>标为已读<');
  });
});
