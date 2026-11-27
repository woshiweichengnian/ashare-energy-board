import { useState } from 'react';
import { REPLAY_ALERT_PREFIX, SIMULATED_ALERT_PREFIX } from '../../../shared/constants';
import type { AlertDirection, AlertEventRow } from '../../../shared/types';
import { describeAlert } from '../../../shared/alertText';
import { formatClockTime } from '../utils/format';

export type AlertHistoryScope = 'today' | 'all';

export type AlertReadFilter = 'ALL' | 'UNREAD' | 'READ';

export interface AlertsPanelProps {
  alerts: readonly AlertEventRow[];
  scope: AlertHistoryScope;
  tradeDate?: string | null;
  isDev: boolean;
  isDayReplay?: boolean;
  replayTradeDate?: string | null;
  onScopeChange: (scope: AlertHistoryScope) => void;
  onRefresh: () => void;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  onSimulate: (direction: AlertDirection) => Promise<void>;
  onJumpToChart: (symbol: string) => void;
}

export function AlertsPanel({
  alerts,
  scope,
  tradeDate,
  isDev,
  isDayReplay = false,
  replayTradeDate = null,
  onScopeChange,
  onRefresh,
  onMarkRead,
  onMarkAllRead,
  onSimulate,
  onJumpToChart,
}: AlertsPanelProps) {
  const [filter, setFilter] = useState<'ALL' | AlertDirection>('ALL');
  const [readFilter, setReadFilter] = useState<AlertReadFilter>('ALL');

  const unreadCount = alerts.reduce((cnt, item) => cnt + (item.isRead ? 0 : 1), 0);

  const filtered = alerts.filter((item) => {
    if (filter !== 'ALL' && item.direction !== filter) return false;
    if (readFilter === 'UNREAD' && item.isRead) return false;
    if (readFilter === 'READ' && !item.isRead) return false;
    return true;
  });

  return (
    <section className="panel-card">
      <h2 className="panel-title">
        <span>
          {scope === 'today'
            ? `当日异动事件流${tradeDate ? ` (${tradeDate})` : ''}`
            : '全部历史异动事件流'}
          （点击记录可跳转图表并标为已读）
        </span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="segmented-group">
            <button
              type="button"
              className={`seg-btn ${scope === 'today' ? 'active' : ''}`}
              onClick={() => onScopeChange('today')}
            >
              当日
            </button>
            <button
              type="button"
              className={`seg-btn ${scope === 'all' ? 'active' : ''}`}
              onClick={() => onScopeChange('all')}
            >
              全部历史
            </button>
          </div>
          <div className="segmented-group">
            <button
              type="button"
              className={`seg-btn ${readFilter === 'ALL' ? 'active' : ''}`}
              onClick={() => setReadFilter('ALL')}
            >
              全部 ({alerts.length})
            </button>
            <button
              type="button"
              className={`seg-btn ${readFilter === 'UNREAD' ? 'active' : ''}`}
              onClick={() => setReadFilter('UNREAD')}
            >
              未读 ({unreadCount})
            </button>
            <button
              type="button"
              className={`seg-btn ${readFilter === 'READ' ? 'active' : ''}`}
              onClick={() => setReadFilter('READ')}
            >
              已读 ({alerts.length - unreadCount})
            </button>
          </div>
          <div className="segmented-group">
            <button
              type="button"
              className={`seg-btn ${filter === 'ALL' ? 'active' : ''}`}
              onClick={() => setFilter('ALL')}
            >
              不限方向
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === 'SURGE' ? 'active' : ''}`}
              onClick={() => setFilter('SURGE')}
            >
              急放
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === 'SHRINK' ? 'active' : ''}`}
              onClick={() => setFilter('SHRINK')}
            >
              急缩
            </button>
          </div>
          <button
            type="button"
            className="btn btn-accent"
            disabled={unreadCount === 0}
            title={
              scope === 'today'
                ? '将当日所有未读异动标记为已读'
                : '将全部历史未读异动标记为已读'
            }
            onClick={onMarkAllRead}
          >
            {unreadCount > 0 ? `全部已读 (${unreadCount})` : '全部已读'}
          </button>
          {isDev && !isDayReplay && (
            <>
              <button
                type="button"
                className="btn btn-surge"
                onClick={() => void onSimulate('SURGE')}
              >
                模拟急放
              </button>
              <button
                type="button"
                className="btn btn-shrink"
                onClick={() => void onSimulate('SHRINK')}
              >
                模拟急缩
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </h2>

      {isDayReplay && (
        <div
          className="hud-conflict-banner"
          style={{ marginBottom: '10px', cursor: 'default' }}
        >
          回放模式（{replayTradeDate ?? ''}）：以下为本次回放实时触发的演练告警，仅内存展示，不写入实盘
          alert_events，不弹出 Windows 系统通知。
        </div>
      )}

      {filtered.length === 0 ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: '12px', padding: '16px 0' }}>
          {readFilter === 'UNREAD' && alerts.length > 0
            ? '当前范围内没有未读异动记录。'
            : '暂无符合条件的异动告警记录。盘中触发快速放量或快速缩量时将自动记录并推送。'}
        </div>
      ) : (
        <div className="alert-list">
          {filtered.map((item) => {
            const isReplay = item.message.startsWith(REPLAY_ALERT_PREFIX);
            const isSim = item.message.startsWith(SIMULATED_ALERT_PREFIX);
            const isSurge = item.direction === 'SURGE';
            return (
              <div
                key={item.id}
                className={`alert-row clickable ${isSurge ? 'surge' : 'shrink'} ${item.isRead ? 'read' : 'unread'}`}
                onClick={() => {
                  if (!item.isRead) {
                    onMarkRead(item.id);
                  }
                  onJumpToChart(item.symbol);
                }}
                title={`点击定位 ${item.name} (${item.symbol}) 分时对比图`}
              >
                <div className="alert-row-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {!item.isRead && <span className="unread-dot" aria-label="未读" />}
                    <span className={`badge ${isSurge ? 'badge-up' : 'badge-down'}`}>
                      {isSurge ? '快速放量' : '快速缩量'}
                    </span>
                    <span
                      className={`badge badge-compact ${item.isRead ? 'badge-muted' : 'badge-unread'}`}
                    >
                      {item.isRead ? '已读' : '未读'}
                    </span>
                    {isReplay && <span className="badge badge-flat">回放</span>}
                    {isSim && <span className="badge badge-warn">模拟测试</span>}
                    <strong className="alert-row-title">
                      {item.name} ({item.symbol})
                    </strong>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {!item.isRead && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        title="仅标记此条为已读"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMarkRead(item.id);
                        }}
                      >
                        标为已读
                      </button>
                    )}
                    <span className="alert-row-meta">
                      {item.tradeDate} {formatClockTime(item.createdAt)} · 点击看图 →
                    </span>
                  </div>
                </div>
                <div className="alert-row-message">
                  {describeAlert(item).headline}；{describeAlert(item).detail}
                </div>
                <div className="alert-row-meta">{describeAlert(item).metrics}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
