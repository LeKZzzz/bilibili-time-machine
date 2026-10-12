import { parseLocalMinute } from './time';
import type { FilterConfig } from './types';

const MINUTE_MS = 60 * 1000;

function formatLocalMinute(timestampSeconds: number, includeSeconds: boolean): string | null {
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}${includeSeconds ? `:${second}` : ''}`;
}

/** 根据自动推进锚点计算当前有效配置，不写入持久化状态。 */
export function resolveAutoAdvanceConfig(config: FilterConfig, nowMs = Date.now()): FilterConfig {
  if (!config.autoAdvance) return config;
  const baseCutoff = config.autoAdvanceBaseCutoffMinute || config.cutoffMinute;
  const startedAt = config.autoAdvanceStartedAt;
  const baseSeconds = parseLocalMinute(baseCutoff);
  if (!baseCutoff || baseSeconds === null || !Number.isFinite(startedAt)) {
    return { ...config, autoAdvance: false, autoAdvanceStartedAt: null, autoAdvanceBaseCutoffMinute: null };
  }
  const elapsedMinutes = Math.floor(Math.max(0, nowMs - Number(startedAt)) / MINUTE_MS);
  const cutoffMinute = formatLocalMinute(baseSeconds + elapsedMinutes * 60, /T\d{2}:\d{2}:\d{2}$/.test(baseCutoff)) ?? baseCutoff;
  return { ...config, cutoffMinute, autoAdvanceBaseCutoffMinute: baseCutoff };
}

/** 从当前截止时间开始自动推进。 */
export function startAutoAdvance(config: FilterConfig, nowMs = Date.now()): FilterConfig {
  if (!config.cutoffMinute || parseLocalMinute(config.cutoffMinute) === null) return { ...config, autoAdvance: false };
  return {
    ...config,
    autoAdvance: true,
    autoAdvanceStartedAt: nowMs,
    autoAdvanceBaseCutoffMinute: config.cutoffMinute,
  };
}

/** 停止自动推进，并把此刻的有效截止时间固化。 */
export function stopAutoAdvance(config: FilterConfig, nowMs = Date.now()): FilterConfig {
  const effective = resolveAutoAdvanceConfig(config, nowMs);
  return {
    ...effective,
    autoAdvance: false,
    autoAdvanceStartedAt: null,
    autoAdvanceBaseCutoffMinute: null,
  };
}
