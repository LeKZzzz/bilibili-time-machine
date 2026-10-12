import type { UnixSeconds } from './types';

/** B 站时间值允许的未来误差（秒），用于容忍客户端与服务器的小幅时钟偏差。 */
export const DEFAULT_FUTURE_TOLERANCE_SECONDS = 5 * 60;

export interface TimeValidationOptions {
  nowSeconds?: number;
  futureToleranceSeconds?: number;
}

/** 将本地 datetime-local 值转换成 Unix 秒，并校验真实日历日期。 */
export function parseLocalMinute(value: unknown): UnixSeconds | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) return null;
  const seconds = date.getTime() / 1000;
  return Number.isFinite(seconds) ? seconds : null;
}

/** 兼容常见的截止时间命名。 */
export const parseCutoffMinute = parseLocalMinute;
export const parseLocalDateTimeMinute = parseLocalMinute;
export const parseLocalMinuteInput = parseLocalMinute;
export const parseCutoffInput = parseLocalMinute;

/** 接受有限的 Unix 秒；毫秒值、零值、负值和非数字均拒绝。 */
export function parseUnixSeconds(value: unknown): UnixSeconds | null {
  let numeric: number;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') numeric = Number(value);
  else return null;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1e12) return null;
  // Unix 秒可以有小数（例如弹幕时间字段），但毫秒数在本核心内不自动转换。
  return numeric;
}

export const isValidUnixSeconds = (value: unknown, options: TimeValidationOptions = {}): boolean =>
  parseValidatedUnixSeconds(value, options) !== null;

export function parseValidatedUnixSeconds(
  value: unknown,
  { nowSeconds = Date.now() / 1000, futureToleranceSeconds = DEFAULT_FUTURE_TOLERANCE_SECONDS }: TimeValidationOptions = {},
): UnixSeconds | null {
  const timestamp = parseUnixSeconds(value);
  if (timestamp === null || !Number.isFinite(nowSeconds)) return null;
  if (timestamp > nowSeconds + Math.max(0, futureToleranceSeconds)) return null;
  return timestamp;
}

/** 严格判断内容是否在截止时间之前。无法确认时间时返回 false。 */
export function isBeforeCutoff(
  contentTime: unknown,
  cutoff: unknown,
  options: TimeValidationOptions = {},
): boolean {
  const timestamp = parseValidatedUnixSeconds(contentTime, options);
  const cutoffSeconds = typeof cutoff === 'number' ? cutoff : parseLocalMinute(cutoff);
  return timestamp !== null && cutoffSeconds !== null && Number.isFinite(cutoffSeconds) && timestamp < cutoffSeconds;
}

export const isContentBeforeCutoff = isBeforeCutoff;
export const isTimeBeforeCutoff = isBeforeCutoff;
export const validateUnixSeconds = parseValidatedUnixSeconds;

export function getCutoffSeconds(value: unknown): UnixSeconds | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  return parseLocalMinute(value);
}
