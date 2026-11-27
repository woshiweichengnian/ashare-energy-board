import { useEffect, useMemo, useState } from 'react';
import {
  describeAlertGroup,
  formatAlertClock,
  groupAlerts,
} from '../../../shared/alertText';
import type { AlertEventInput, OpenDetailOptions } from '../../../shared/types';

const MAX_LINES = 3;
const FETCH_LIMIT = 80;

/**
 * 本机定制：悬浮窗上常驻的"最近提醒"。
 * 原来的提醒只有一条 6 秒就消失的横幅，错过就看不到了。这里把今天的提醒留在悬浮窗上，
 * 同一两分钟内多个指数一起触发的合并成一行，最多显示最近 3 行，点击进提醒页。
 */
export function HudRecentAlerts({
  tradeDate,
  onOpenDetail,
}: {
  tradeDate: string | null | undefined;
  onOpenDetail: (options?: OpenDetailOptions) => void;
}) {
  const [alerts, setAlerts] = useState<AlertEventInput[]>([]);

  useEffect(() => {
    const api = window.api;
    if (!api?.getRecentAlerts || !tradeDate) {
      setAlerts([]);
      return undefined;
    }
    let cancelled = false;
    api
      .getRecentAlerts(tradeDate, FETCH_LIMIT)
      .then((rows) => {
        if (!cancelled) setAlerts(rows);
      })
      .catch(() => {});
    const unsub = api.onAlertTriggered((payload) => {
      if (payload.tradeDate !== tradeDate) return;
      setAlerts((prev) => [payload, ...prev].slice(0, FETCH_LIMIT));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [tradeDate]);

  const groups = useMemo(() => groupAlerts(alerts).slice(0, MAX_LINES), [alerts]);
  if (groups.length === 0) return null;

  return (
    <div className="hud-recent-alerts no-drag" title="今天最近的放量/缩量提醒，点击看全部">
      {groups.map((g) => {
        const { who, what } = describeAlertGroup(g);
        return (
          <button
            type="button"
            key={`${g.latestAt}-${g.direction}-${g.symbol}`}
            className={`hud-recent-alert ${g.direction === 'SURGE' ? 'surge' : 'shrink'}`}
            onClick={() => onOpenDetail({ symbol: g.symbol, tab: 'alerts' })}
            title={`${formatAlertClock(g.latestAt)} ${g.names.join('、')}：最近几分钟的成交${
              g.direction === 'SURGE' ? '是' : '只有'
            }昨天同时段的 ${what.replace(/^放量 |^缩到 /, '')}`}
          >
            <span className="hud-recent-alert-time">{formatAlertClock(g.latestAt)}</span>
            <span className="hud-recent-alert-who">{who}</span>
            <span className="hud-recent-alert-what">{what}</span>
          </button>
        );
      })}
    </div>
  );
}
