import { useCallback, useRef } from 'react';

type Axis = 'w' | 'h';

/**
 * 本机定制：悬浮窗的两个拖动手柄。
 * - 底边中间的短横线：上下拖，只改高度（票多时拉高即可全部看到）。
 * - 右下角的小三角：左右拖，整体放大（宽度变大，字和内容按比例一起放大）。
 * 鼠标位置由主进程自己读，这里只发"开始 / 移动 / 结束"。双击任一手柄恢复默认大小。
 */
function useResizeDrag(axis: Axis) {
  const state = useRef<{ raf: number | null } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      state.current = { raf: null };
      void window.api.hudResizeDrag('start', axis);
    },
    [axis]
  );

  const onPointerMove = useCallback(() => {
    const d = state.current;
    if (!d || d.raf !== null) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = null;
      if (state.current === d) void window.api.hudResizeDrag('move', axis);
    });
  }, [axis]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = state.current;
      if (!d) return;
      state.current = null;
      if (d.raf !== null) cancelAnimationFrame(d.raf);
      e.currentTarget.releasePointerCapture(e.pointerId);
      void window.api.hudResizeDrag('end', axis);
    },
    [axis]
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

export function HudResizeHandle() {
  const height = useResizeDrag('h');
  const zoom = useResizeDrag('w');
  const reset = () => void window.api.resetHudSize();

  return (
    <div className="hud-resize-row no-drag">
      <div
        className="hud-resize-handle"
        title="上下拖动调整窗口高度，双击恢复默认大小"
        onDoubleClick={reset}
        {...height}
      >
        <span />
      </div>
      <div
        className="hud-resize-corner"
        title="左右拖动整体放大或缩小，双击恢复默认大小"
        onDoubleClick={reset}
        {...zoom}
      />
    </div>
  );
}
