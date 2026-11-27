import { useEffect, useState } from 'react';
import type { MarketSentiment } from '../../../shared/types';

const REFRESH_MS = 30_000;

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}

/**
 * 本机定制：「情绪」页——涨跌分布、涨停表现、连板梯队。
 * 数据来自东财涨停板行情中心（取数在主进程 extras/builtinExtras.ts），
 * 只在打开这一页时每 30 秒读一次。
 */
export function SentimentPanel() {
  const [data, setData] = useState<MarketSentiment | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      window.api
        .getMarketSentiment()
        .then((next) => {
          if (cancelled) return;
          if (next) setData(next);
          setFailed(!next);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!data) {
    return (
      <section className="panel-card">
        <h2 className="panel-title">市场情绪</h2>
        <div className="sentiment-empty">
          {failed ? '没取到数据：东财接口暂时不通，或今天的行情还没准备好，稍后会自动重试。' : '加载中…'}
        </div>
      </section>
    );
  }

  const maxCount = Math.max(1, ...data.buckets.map((b) => b.count));
  const total = data.up + data.down + data.flat;
  const upShare = total > 0 ? (data.up / total) * 100 : 50;
  const dateLabel = `${data.date.slice(4, 6)}-${data.date.slice(6, 8)}`;

  return (
    <>
      <section className="panel-card">
        <h2 className="panel-title">
          <span>涨跌分布 {dateLabel}</span>
          <span className="sentiment-updated">
            {failed ? '刷新失败，显示的是上一次的数 · ' : ''}
            {data.at} 更新
          </span>
        </h2>
        <div className="sentiment-bars">
          {data.buckets.map((b) => (
            <div key={b.label} className={`sentiment-bar-col ${b.side}`}>
              <span className="sentiment-bar-count">{b.count}</span>
              <div className="sentiment-bar-track">
                <div
                  className="sentiment-bar-fill"
                  style={{ height: `${Math.max(b.count > 0 ? 2 : 0, (b.count / maxCount) * 100)}%` }}
                />
              </div>
              <span className="sentiment-bar-label">{b.label}</span>
            </div>
          ))}
        </div>
        <div className="sentiment-split">
          <div className="sentiment-split-up" style={{ width: `${upShare}%` }} />
        </div>
        <div className="sentiment-split-legend">
          <span className="tone-up">涨 {data.up} 家</span>
          <span className="sentiment-dim">平 {data.flat}</span>
          <span className="tone-down">跌 {data.down} 家</span>
        </div>
      </section>

      <section className="panel-card">
        <h2 className="panel-title">涨停表现</h2>
        <div className="sentiment-stats">
          <div className="sentiment-stat">
            <span className="sentiment-stat-label">涨停</span>
            <span className="sentiment-stat-value">
              <span className="tone-up">{data.limitUp}</span>
              <span className="sentiment-dim"> / {data.prev.limitUp}</span>
            </span>
            <span className="sentiment-stat-sub">今日 / 昨日</span>
          </div>
          <div className="sentiment-stat" title="封板率 = 涨停家数 ÷（涨停 + 炸板）">
            <span className="sentiment-stat-label">封板率</span>
            <span className="sentiment-stat-value">
              <span className="tone-up">{pct(data.sealRate)}</span>
              <span className="sentiment-dim"> / {pct(data.prev.sealRate)}</span>
            </span>
            <span className="sentiment-stat-sub">今日 / 昨日 · 炸板 {data.broken} 家</span>
          </div>
          <div className="sentiment-stat">
            <span className="sentiment-stat-label">跌停</span>
            <span className="sentiment-stat-value">
              <span className="tone-down">{data.limitDown}</span>
              <span className="sentiment-dim"> / {data.prev.limitDown}</span>
            </span>
            <span className="sentiment-stat-sub">今日 / 昨日</span>
          </div>
        </div>
        <div
          className="sentiment-ladder"
          title="连板率 = 今天 N 板家数 ÷ 昨天 N-1 板家数；高度板 = 5 板及以上"
        >
          {data.ladder.map((step) => (
            <div key={step.label} className="sentiment-ladder-cell">
              <span className="sentiment-stat-label">{step.label}</span>
              <span className="sentiment-ladder-count">{step.count}</span>
              <span className="sentiment-stat-sub">
                {step.rate === null ? (step.label === '一板' ? '首板' : '昨日无') : `连板率 ${step.rate}%`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-card">
        <h2 className="panel-title">
          <span>连板股（2 板及以上，{data.leaders.length} 只）</span>
        </h2>
        {data.leaders.length === 0 ? (
          <div className="sentiment-empty">今天没有 2 板及以上的票。</div>
        ) : (
          <div className="sentiment-leaders">
            {data.leaders.map((s) => (
              <div key={s.code} className="sentiment-leader">
                <span className="badge badge-up">{s.boards} 板</span>
                <span className="sentiment-leader-name">{s.name}</span>
                <span className="sentiment-dim">{s.industry}</span>
                {s.breaks > 0 && <span className="sentiment-dim">炸过 {s.breaks} 次</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
