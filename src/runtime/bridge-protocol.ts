import type { FilterConfig } from '../core/types';

/** 页面上下文与隔离世界之间的最小消息集合。禁止在消息中携带响应正文或 Cookie。 */
export type BridgeNoticeReason =
  | 'config-pending'
  | 'config-read-failed'
  | 'parse-failed'
  | 'unknown-time'
  | 'supplement-failed'
  | 'hook-failed'
  | 'unsupported-route'
  | 'other';

export interface ConfigUpdateMessage {
  type: 'time-filter/config-update';
  config: FilterConfig;
}

export interface NoticeMessage {
  type: 'time-filter/notice';
  reason: BridgeNoticeReason;
  /** 仅用于页面内提示的短文案；不接受正文、URL 或凭据。 */
  message?: string;
}

export type BridgeMessage = ConfigUpdateMessage | NoticeMessage;

const NOTICE_REASONS = new Set<BridgeNoticeReason>([
  'config-pending',
  'config-read-failed',
  'parse-failed',
  'unknown-time',
  'supplement-failed',
  'hook-failed',
  'unsupported-route',
  'other',
]);

function isConfig(value: unknown): value is FilterConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<FilterConfig>;
  return (
    (config.cutoffMinute === null || typeof config.cutoffMinute === 'string') &&
    typeof config.enabled === 'boolean' &&
    typeof config.supplementBudget === 'number' &&
    Number.isInteger(config.supplementBudget) &&
    config.supplementBudget >= 0 &&
    config.supplementBudget <= 100 &&
    typeof config.debug === 'boolean' &&
    (config.autoAdvance === undefined || typeof config.autoAdvance === 'boolean') &&
    (config.autoAdvanceStartedAt === undefined || config.autoAdvanceStartedAt === null || (typeof config.autoAdvanceStartedAt === 'number' && Number.isFinite(config.autoAdvanceStartedAt))) &&
    (config.autoAdvanceBaseCutoffMinute === undefined || config.autoAdvanceBaseCutoffMinute === null || typeof config.autoAdvanceBaseCutoffMinute === 'string')
  );
}

function isSafeNoticeText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && !/[\r\n]/.test(value);
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<BridgeMessage>;
  if (message.type === 'time-filter/config-update') return isConfig(message.config);
  if (message.type === 'time-filter/notice') {
    return NOTICE_REASONS.has(message.reason as BridgeNoticeReason) &&
      (message.message === undefined || isSafeNoticeText(message.message));
  }
  return false;
}

export function serializeBridgeMessage(message: BridgeMessage): string {
  if (!isBridgeMessage(message)) throw new TypeError('Invalid bridge message');
  return JSON.stringify(message);
}

export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return isBridgeMessage(parsed) ? parsed : null;
}

export function postBridgeMessage(target: Window, message: BridgeMessage): void {
  target.postMessage(message, target.location?.origin || '*');
}

