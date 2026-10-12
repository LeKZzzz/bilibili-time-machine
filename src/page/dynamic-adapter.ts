import { isBeforeCutoff, parseValidatedUnixSeconds, type TimeValidationOptions } from '../core/time';

export interface DynamicAdapterOptions extends TimeValidationOptions {
  cutoff: string | number | null | undefined;
  enabled?: boolean;
}

export interface DynamicAdaptResult<T = unknown> {
  handled: boolean;
  payload: T;
  hiddenCount: number;
  /** 本批次收到的动态条目总数。 */
  totalCount: number;
  /** 过滤后保留的动态条目数。 */
  visibleCount: number;
  reason?: 'unsupported-shape' | 'parse-failed';
}

const DYNAMIC_PATH = /\/x\/polymer\/web-dynamic\/v1\/(?:feed\/all|feed\/space|opus\/feed\/space)(?:\/|$)/i;

export function isDynamicUrl(url: string): boolean {
  try {
    return DYNAMIC_PATH.test(new URL(url, window.location.href).pathname);
  } catch {
    return DYNAMIC_PATH.test(url.split('?')[0]);
  }
}

function numericTime(value: unknown, options: TimeValidationOptions): number | null {
  return parseValidatedUnixSeconds(value, options);
}

function dynamicTimestamp(item: Record<string, unknown>, options: TimeValidationOptions): number | null {
  const modules = item.modules;
  if (modules && typeof modules === 'object') {
    const author = (modules as Record<string, unknown>).module_author;
    if (author && typeof author === 'object') {
      const timestamp = numericTime((author as Record<string, unknown>).pub_ts, options);
      if (timestamp !== null) return timestamp;
    }
  }
  for (const key of ['publish_time', 'pub_ts', 'pubdate', 'ctime']) {
    const timestamp = numericTime(item[key], options);
    if (timestamp !== null) return timestamp;
  }
  const data = item.data;
  if (data && typeof data === 'object') {
    const view = (data as Record<string, unknown>).view;
    if (view && typeof view === 'object') {
      for (const key of ['pub_time', 'publish_time', 'pub_ts']) {
        const timestamp = numericTime((view as Record<string, unknown>)[key], options);
        if (timestamp !== null) return timestamp;
      }
    }
  }
  return null;
}

function filterItems(items: unknown[], cutoff: DynamicAdapterOptions): { items: unknown[]; hiddenCount: number } {
  let hiddenCount = 0;
  const filtered = items.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const timestamp = dynamicTimestamp(item as Record<string, unknown>, cutoff);
    const visible = timestamp !== null && isBeforeCutoff(timestamp, cutoff.cutoff, cutoff);
    if (!visible) hiddenCount += 1;
    return visible;
  });
  return { items: filtered, hiddenCount };
}

/** 过滤动态接口的当前批次，保留 offset、has_more 等分页元数据。 */
export function adaptDynamicPayload<T = unknown>(payload: T, options: DynamicAdapterOptions): DynamicAdaptResult<T> {
  if (!options.cutoff || !options.enabled) return { handled: true, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0 };
  if (!payload || typeof payload !== 'object') return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'unsupported-shape' };
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>).items)) {
    return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'unsupported-shape' };
  }
  try {
    const items = (data as Record<string, unknown>).items as unknown[];
    const result = filterItems(items, options);
    return {
      handled: true,
      payload: { ...root, data: { ...(data as Record<string, unknown>), items: result.items } } as T,
      hiddenCount: result.hiddenCount,
      totalCount: items.length,
      visibleCount: result.items.length,
    };
  } catch {
    return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'parse-failed' };
  }
}
