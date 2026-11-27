import { Notification } from 'electron';
import { describeAlert } from '../../shared/alertText';
import { getShanghaiParts, timestampToMinuteIndex } from '../../core/tradingClock';
import {
  MARKET_TOTAL_SYMBOL,
  MONITORED_INDEX_NAMES,
  SIMULATED_ALERT_PREFIX,
} from '../../shared/constants';
import type {
  AlertDirection,
  AlertDispatchPayload,
  AlertEventInput,
  BossKeyStatus,
} from '../../shared/types';
import type { AppDatabase } from '../storage/database';

export interface NativeNotificationRequest {
  title: string;
  body: string;
  silent: boolean;
  symbol?: string;
}

export interface AlertDispatcherOptions {
  database: Pick<AppDatabase, 'insertAlertEvent'>;
  isMuted: () => boolean;
  broadcastAlert: (payload: AlertDispatchPayload) => void;
  onNotificationClick?: (symbol: string) => void;
  sendNativeNotification?: (req: NativeNotificationRequest) => void;
  allowSimulation: boolean;
  nowFn?: () => number;
}

function formatSignedPct(value: number, digits = 2): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function isSimulatedAlertMessage(message: string): boolean {
  return message.startsWith(SIMULATED_ALERT_PREFIX);
}

export function buildAlertNotification(
  event: AlertEventInput,
  isSimulated: boolean
): Omit<NativeNotificationRequest, 'silent'> {
  const dirLabel = event.direction === 'SURGE' ? '快速放量' : '快速缩量';
  const prefix = isSimulated ? '【模拟测试】' : event.direction === 'SURGE' ? '⚡ ' : '📉 ';
  const title = `${prefix}${dirLabel} · ${event.name}`;

  const slopeText = `${formatSignedPct(event.slope, 2)}/分`;
  const multipleText = `${event.windowMultiple.toFixed(2)}x`;
  const ratioText = formatSignedPct(event.cumRatio * 100, 1);
  const simSuffix = isSimulated ? '（测试演练，非实盘信号）' : '';

  // 本机定制：先说人话，指标放在括号里
  const plain = describeAlert(event);
  const body = `${plain.headline.replace(event.name, '')}；累计比昨天同期 ${ratioText}（斜率 ${slopeText} · ${multipleText}）${simSuffix}`;
  return {
    title,
    body,
    symbol: event.symbol,
  };
}

/**
 * 告警多通道派发器：
 * 1. 持久化写入 SQLite alert_events 表
 * 2. 发送 Windows 原生 Notification（带标的名、方向、斜率与区间倍数）
 * 3. 通过 IPC 推送至渲染进程（HUD 呼吸高亮 + 可静音区分急放/急缩提示音）
 */
export class AlertDispatcher {
  private readonly database: Pick<AppDatabase, 'insertAlertEvent'>;
  private readonly isMuted: () => boolean;
  private readonly broadcastAlert: (payload: AlertDispatchPayload) => void;
  private readonly onNotificationClick?: (symbol: string) => void;
  private readonly sendNativeNotification: (req: NativeNotificationRequest) => void;
  private readonly allowSimulation: boolean;
  private readonly nowFn: () => number;

  constructor(options: AlertDispatcherOptions) {
    this.database = options.database;
    this.isMuted = options.isMuted;
    this.broadcastAlert = options.broadcastAlert;
    this.onNotificationClick = options.onNotificationClick;
    this.allowSimulation = options.allowSimulation;
    this.nowFn = options.nowFn ?? Date.now;
    this.sendNativeNotification =
      options.sendNativeNotification ?? ((req) => this.sendElectronNotification(req));
  }

  dispatch(event: AlertEventInput, options?: { isSimulated?: boolean }): AlertDispatchPayload {
    const isSimulated = Boolean(options?.isSimulated) || isSimulatedAlertMessage(event.message);
    const normalizedMessage =
      isSimulated && !isSimulatedAlertMessage(event.message)
        ? `${SIMULATED_ALERT_PREFIX} ${event.message}`
        : event.message;

    const eventToStore: AlertEventInput = {
      ...event,
      message: normalizedMessage,
    };

    // 1. 写入 alert_events 持久库
    const id = this.database.insertAlertEvent(eventToStore);

    // 2. 组装跨进程载荷（静音态仅抑制声音，其余通道照常）
    const muted = this.isMuted();
    const payload: AlertDispatchPayload = {
      ...eventToStore,
      id,
      isRead: false,
      isSimulated,
      muted,
    };

    // 3. 发送 Windows 原生系统通知（系统通知设为 silent，声音由可区分急放/急缩的 Web Audio 精准控制）
    const notification = buildAlertNotification(eventToStore, isSimulated);
    try {
      this.sendNativeNotification({
        ...notification,
        silent: true,
      });
    } catch (err: unknown) {
      console.error(
        '[alerts] Failed to display native notification:',
        err instanceof Error ? err.message : String(err)
      );
    }

    // 4. 经 IPC 通知 HUD 呼吸高亮、提示音与详情事件流
    this.broadcastAlert(payload);

    return payload;
  }

  /**
   * 触发开发态模拟测试告警（仅开发/测试环境可用，明确标记 [模拟测试]，绝不伪装为实盘告警）
   */
  dispatchSimulated(
    direction: AlertDirection,
    target?: { symbol?: string; name?: string }
  ): AlertDispatchPayload {
    if (!this.allowSimulation) {
      throw new Error('模拟告警仅限开发与测试环境使用。');
    }

    const nowMs = this.nowFn();
    const shanghai = getShanghaiParts(nowMs);
    const liveMinuteIndex = timestampToMinuteIndex(nowMs);
    const minuteIndex = liveMinuteIndex ?? 60;

    const symbol = target?.symbol?.trim() || MARKET_TOTAL_SYMBOL;
    const name =
      target?.name?.trim() ||
      (symbol === MARKET_TOTAL_SYMBOL
        ? '沪深两市'
        : MONITORED_INDEX_NAMES[symbol] ?? symbol);

    const isSurge = direction === 'SURGE';
    const slope = isSurge ? 4.85 : -4.68;
    const windowMultiple = isSurge ? 1.72 : 0.54;
    const cumRatio = isSurge ? 0.146 : -0.118;
    const dirLabel = isSurge ? '快速放量' : '快速缩量';

    const event: AlertEventInput = {
      symbol,
      name,
      tradeDate: shanghai.dateStr,
      minuteIndex,
      direction,
      slope,
      windowMultiple,
      cumRatio,
      message: `${SIMULATED_ALERT_PREFIX} ${name} 触发${dirLabel}演练（斜率 ${formatSignedPct(slope, 2)}/分，区间 ${windowMultiple.toFixed(2)}x）`,
      createdAt: nowMs,
    };

    return this.dispatch(event, { isSimulated: true });
  }

  notifyBossKeyConflict(status: BossKeyStatus): void {
    if (!status.conflictMessage) return;
    try {
      this.sendNativeNotification({
        title: '全局老板键冲突提醒',
        body: status.conflictMessage,
        silent: this.isMuted(),
      });
    } catch {
      // 忽略通知通道异常
    }
  }

  private sendElectronNotification(req: NativeNotificationRequest): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: req.title,
      body: req.body,
      silent: req.silent,
    });
    if (req.symbol && this.onNotificationClick) {
      const symbol = req.symbol;
      n.on('click', () => {
        this.onNotificationClick?.(symbol);
      });
    }
    n.show();
  }
}
