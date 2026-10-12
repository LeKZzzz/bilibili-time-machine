import { filterDanmakuXml, type DanmakuFilterOptions } from '../core/danmaku-xml';
import type { DanmakuFilterResult } from '../core/types';

export interface DanmakuAdapterOptions extends DanmakuFilterOptions {
  cutoff: string | number | null | undefined;
}

export interface DanmakuAdaptResult {
  handled: boolean;
  result: DanmakuFilterResult;
  reason?: 'unsupported-url' | 'parse-failed';
}

const DANMAKU_PATH = /(?:\/x\/v1\/dm\/list|\/x\/v2\/dm\/web|\/danmaku|\.xml)(?:\/|$)/i;

export function isDanmakuUrl(url: string): boolean {
  try {
    return DANMAKU_PATH.test(new URL(url, window.location.href).pathname);
  } catch {
    return DANMAKU_PATH.test(url.split('?')[0]);
  }
}

export function adaptDanmakuXml(xml: unknown, options: DanmakuAdapterOptions): DanmakuAdaptResult {
  try {
    return { handled: true, result: filterDanmakuXml(xml, options.cutoff, options) };
  } catch {
    return {
      handled: true,
      result: { ok: false, xml: '', records: [], hiddenCount: 0, reason: 'invalid-xml' },
      reason: 'parse-failed',
    };
  }
}

/** 只有明确匹配 XML 弹幕地址时才替换响应，其他播放器数据保持旁路。 */
export function adaptDanmakuResponse(
  url: string,
  xml: unknown,
  options: DanmakuAdapterOptions,
): DanmakuAdaptResult {
  if (!isDanmakuUrl(url)) {
    return { handled: false, result: { ok: false, xml: '', records: [], hiddenCount: 0, reason: 'empty' }, reason: 'unsupported-url' };
  }
  return adaptDanmakuXml(xml, options);
}

