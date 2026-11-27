import {
  DEFAULT_HUD_OPACITY,
  HUD_DEFAULT_HEIGHT,
  HUD_DEFAULT_WIDTH,
  HUD_MINIMAL_HEIGHT,
  HUD_MINIMAL_WIDTH,
  MAX_HUD_OPACITY,
  MIN_HUD_OPACITY,
} from '../../shared/constants';
import type { HudMode, WindowPosition } from '../../shared/types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 按展示模式返回 HUD 窗口目标尺寸 */
export function getHudSizeForMode(mode: HudMode): Size {
  return mode === 'minimal'
    ? { width: HUD_MINIMAL_WIDTH, height: HUD_MINIMAL_HEIGHT }
    : { width: HUD_DEFAULT_WIDTH, height: HUD_DEFAULT_HEIGHT };
}

/** 将 HUD 透明度钳制在 [0.3, 1.0]，非法值回退默认值 */
export function clampHudOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HUD_OPACITY;
  const clamped = Math.max(MIN_HUD_OPACITY, Math.min(MAX_HUD_OPACITY, value));
  return Math.round(clamped * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function intersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function fitsInside(rect: Rect, bounds: Rect): boolean {
  return (
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.width <= bounds.x + bounds.width &&
    rect.y + rect.height <= bounds.y + bounds.height
  );
}

/**
 * 判断窗口是否处于可见区域内：
 * - 与任一显示器工作区重叠宽度 >= 80px 且重叠高度 >= 40px
 * - 且窗口顶部不超出该工作区顶部太多（避免标题拖拽区不可达）
 */
export function isRectSufficientlyVisible(rect: Rect, workAreas: readonly Rect[]): boolean {
  const minVisibleWidth = Math.min(80, rect.width);
  const minVisibleHeight = Math.min(40, rect.height);

  for (const wa of workAreas) {
    const left = Math.max(rect.x, wa.x);
    const right = Math.min(rect.x + rect.width, wa.x + wa.width);
    const top = Math.max(rect.y, wa.y);
    const bottom = Math.min(rect.y + rect.height, wa.y + wa.height);
    const overlapW = right - left;
    const overlapH = bottom - top;

    if (overlapW >= minVisibleWidth && overlapH >= minVisibleHeight && rect.y >= wa.y - 16) {
      return true;
    }
  }
  return false;
}

/** 默认 HUD 位置：主屏幕工作区右上角留边距，不遮挡任务栏 */
export function getDefaultHudPosition(
  hudSize: Size,
  primaryWorkArea: Rect,
  margin = 20
): WindowPosition {
  const maxX = primaryWorkArea.x + Math.max(0, primaryWorkArea.width - hudSize.width);
  const maxY = primaryWorkArea.y + Math.max(0, primaryWorkArea.height - hudSize.height);
  const x = clamp(primaryWorkArea.x + primaryWorkArea.width - hudSize.width - margin, primaryWorkArea.x, maxX);
  const y = clamp(primaryWorkArea.y + margin, primaryWorkArea.y, maxY);
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 解析启动时 HUD 最终坐标：
 * - 有保存位置且仍在当前多屏工作区可见范围内：直接恢复
 * - 否则回落到主屏幕工作区可见区域（若部分与主屏重叠则拉回可见边缘，完全离屏则重置到默认右上角）
 */
export function resolveHudBounds(
  savedPosition: WindowPosition | null,
  hudSize: Size,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect
): Rect {
  const areas = workAreas.length > 0 ? workAreas : [primaryWorkArea];

  if (
    savedPosition &&
    Number.isFinite(savedPosition.x) &&
    Number.isFinite(savedPosition.y)
  ) {
    const candidate: Rect = {
      x: Math.round(savedPosition.x),
      y: Math.round(savedPosition.y),
      width: hudSize.width,
      height: hudSize.height,
    };

    if (isRectSufficientlyVisible(candidate, areas)) {
      return candidate;
    }

    // 寻找重叠最多的显示器；若完全无重叠（例如拔掉了外接副屏），重置回主屏默认位置
    let bestArea: Rect | null = null;
    let bestOverlap = 0;
    for (const wa of areas) {
      const area = intersectionArea(candidate, wa);
      if (area > bestOverlap) {
        bestOverlap = area;
        bestArea = wa;
      }
    }

    if (bestArea) {
      const maxX = bestArea.x + Math.max(0, bestArea.width - hudSize.width);
      const maxY = bestArea.y + Math.max(0, bestArea.height - hudSize.height);
      return {
        x: Math.round(clamp(candidate.x, bestArea.x, maxX)),
        y: Math.round(clamp(candidate.y, bestArea.y, maxY)),
        width: hudSize.width,
        height: hudSize.height,
      };
    }
  }

  const fallback = getDefaultHudPosition(hudSize, primaryWorkArea);
  return {
    x: fallback.x,
    y: fallback.y,
    width: hudSize.width,
    height: hudSize.height,
  };
}

/** 找出最匹配给定窗口矩形的工作区 */
export function findTargetWorkArea(
  anchor: Rect | null,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect
): Rect {
  if (!anchor || workAreas.length === 0) {
    return primaryWorkArea;
  }

  const centerX = anchor.x + anchor.width / 2;
  const centerY = anchor.y + anchor.height / 2;
  for (const wa of workAreas) {
    if (
      centerX >= wa.x &&
      centerX <= wa.x + wa.width &&
      centerY >= wa.y &&
      centerY <= wa.y + wa.height
    ) {
      return wa;
    }
  }

  let bestArea = primaryWorkArea;
  let bestOverlap = 0;
  for (const wa of workAreas) {
    const overlap = intersectionArea(anchor, wa);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestArea = wa;
    }
  }
  return bestArea;
}

/**
 * 计算详情浮层弹出位置：
 * - 优先贴近 HUD（左 → 右 → 下 → 上）且完整留在目标显示器工作区内
 * - 空间不足时在目标显示器工作区居中显示
 */
export function computeDetailOverlayBounds(
  hudBounds: Rect | null,
  detailSize: Size,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect,
  gap = 12
): Rect {
  const wa = findTargetWorkArea(hudBounds, workAreas, primaryWorkArea);
  const width = Math.min(detailSize.width, wa.width);
  const height = Math.min(detailSize.height, wa.height);

  const maxX = wa.x + Math.max(0, wa.width - width);
  const maxY = wa.y + Math.max(0, wa.height - height);

  if (hudBounds) {
    const candidates: Rect[] = [
      // 1. 贴近 HUD 左侧
      {
        x: Math.round(hudBounds.x - gap - width),
        y: Math.round(clamp(hudBounds.y, wa.y, maxY)),
        width,
        height,
      },
      // 2. 贴近 HUD 右侧
      {
        x: Math.round(hudBounds.x + hudBounds.width + gap),
        y: Math.round(clamp(hudBounds.y, wa.y, maxY)),
        width,
        height,
      },
      // 3. 贴近 HUD 下方
      {
        x: Math.round(clamp(hudBounds.x + hudBounds.width - width, wa.x, maxX)),
        y: Math.round(hudBounds.y + hudBounds.height + gap),
        width,
        height,
      },
      // 4. 贴近 HUD 上方
      {
        x: Math.round(clamp(hudBounds.x + hudBounds.width - width, wa.x, maxX)),
        y: Math.round(hudBounds.y - gap - height),
        width,
        height,
      },
    ];

    for (const candidate of candidates) {
      if (fitsInside(candidate, wa)) {
        return candidate;
      }
    }
  }

  // 贴近空间不足时屏幕工作区居中
  return {
    x: Math.round(wa.x + Math.max(0, (wa.width - width) / 2)),
    y: Math.round(wa.y + Math.max(0, (wa.height - height) / 2)),
    width,
    height,
  };
}

/**
 * 计算 HUD 在标准/极简模式间切换后的目标边界：
 * - 位于当前工作区右半侧时保持右边缘对齐，位于左半侧时保持左边缘对齐
 * - 若缩放后超出工作区边界，则 clamp 回当前显示器工作区可见范围内
 */
export function computeResizedHudBounds(
  currentBounds: Rect,
  nextSize: Size,
  workAreas: readonly Rect[],
  primaryWorkArea: Rect
): Rect {
  const areas = workAreas.length > 0 ? workAreas : [primaryWorkArea];
  const wa = findTargetWorkArea(currentBounds, areas, primaryWorkArea);
  const centerX = currentBounds.x + currentBounds.width / 2;
  const waMidX = wa.x + wa.width / 2;

  const rawX =
    centerX >= waMidX
      ? currentBounds.x + currentBounds.width - nextSize.width
      : currentBounds.x;
  const rawY = currentBounds.y;

  const maxX = wa.x + Math.max(0, wa.width - nextSize.width);
  const maxY = wa.y + Math.max(0, wa.height - nextSize.height);

  return {
    x: Math.round(clamp(rawX, wa.x, maxX)),
    y: Math.round(clamp(rawY, wa.y, maxY)),
    width: nextSize.width,
    height: nextSize.height,
  };
}
