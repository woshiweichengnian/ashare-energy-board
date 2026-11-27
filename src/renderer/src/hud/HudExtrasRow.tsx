import { useEffect, useState } from 'react';
import type { HudExtras } from '../../../shared/types';

/** 本机定制：悬浮窗附加行（韩国综指 / 国家队是否上班 / 涨跌停家数 / 涨跌家数），取数内置在主进程 */
export function HudExtrasRow() {
  const [extras, setExtras] = useState<HudExtras | null>(null);

  useEffect(() => {
    const api = window.api;
    if (!api?.getHudExtras) return undefined;
    api
      .getHudExtras()
      .then(setExtras)
      .catch(() => {});
    return api.onHudExtrasUpdated(setExtras);
  }, []);

  const k = extras?.kospi ?? null;
  const w = extras?.wwd ?? null;
  const l = extras?.limit ?? null;
  const b = extras?.breadth ?? null;
  const bTotal = b ? b.up + b.down + b.flat : 0;
  const signed = (v: number, digits: number) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
  const tone = (v: number) => (v > 0 ? 'tone-up' : v < 0 ? 'tone-down' : '');
  const wwdTone = w?.level === 'hot' ? 'up' : w?.level === 'mid' ? 'warn' : 'flat';

  return (
    <>
    <div className="hud-extras no-drag">
      <div
        className="hud-extras-cell"
        title={k ? `韩国综指 · ${k.open ? '交易中' : '已收盘'} · 交易时间 08:00–14:30（北京时间）` : '韩国综指：未取到数据'}
      >
        <span className="hud-extras-label">韩综</span>
        {k ? (
          <>
            <span className="hud-extras-num">{k.price.toFixed(1)}</span>
            <span className={`hud-extras-num ${tone(k.pct)}`}>{signed(k.pct, 2)}%</span>
            {!k.open && <span className="hud-extras-dim">收</span>}
          </>
        ) : (
          <span className="hud-extras-dim">—</span>
        )}
      </div>
      <div
        className="hud-extras-cell"
        title={
          w
            ? `汪汪队（宽基 ETF 池）${w.at}：成交是历史同时点的 ${w.ratio.toFixed(2)} 倍，主动净买入 ${signed(w.net, 1)} 亿。1.8 倍以上且净买入为正 = 上班了；1.3 倍以上 = 有迹象`
            : '汪汪队：今天还没有数据'
        }
      >
        <span className="hud-extras-label">汪汪队</span>
        {w ? (
          <>
            <span className={`badge badge-${wwdTone}`}>{w.label}</span>
            <span className="hud-extras-num">{w.ratio.toFixed(2)}x</span>
            <span className={`hud-extras-num ${tone(w.net)}`}>{signed(w.net, 0)}亿</span>
          </>
        ) : (
          <span className="hud-extras-dim">—</span>
        )}
      </div>
      <div className="hud-extras-cell" title="涨停 / 跌停家数（东财涨停池、跌停池）">
        <span className="hud-extras-label">涨跌停</span>
        {l ? (
          <>
            <span className="hud-extras-num tone-up">{l.zt ?? '—'}</span>
            <span className="hud-extras-dim">/</span>
            <span className="hud-extras-num tone-down">{l.dt ?? '—'}</span>
          </>
        ) : (
          <span className="hud-extras-dim">—</span>
        )}
      </div>
    </div>
    {b && bTotal > 0 && (
      <div
        className="hud-breadth no-drag"
        title={`上涨 ${b.up} 家 / 平 ${b.flat} 家 / 下跌 ${b.down} 家（沪深，不含北交所）`}
      >
        <span className="hud-extras-num tone-up">涨 {b.up}</span>
        <div className="hud-breadth-bar">
          <div className="hud-breadth-up" style={{ width: `${(b.up / bTotal) * 100}%` }} />
          <div className="hud-breadth-flat" style={{ width: `${(b.flat / bTotal) * 100}%` }} />
        </div>
        <span className="hud-extras-num tone-down">跌 {b.down}</span>
      </div>
    )}
    </>
  );
}
