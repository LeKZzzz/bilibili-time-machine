import {
  getCutoffSeconds,
  isBeforeCutoff,
  parseValidatedUnixSeconds,
  type TimeValidationOptions,
} from './time';
import type { SupplementPlan, VideoRecord, VideoSupplementCandidate, VideoVisibility } from './types';

export interface VideoFilterOptions extends TimeValidationOptions {
  /** 过滤关闭时旁路；设置 cutoff 时默认视为启用。 */
  enabled?: boolean;
}

function recordTimestamp(record: VideoRecord, options: TimeValidationOptions = {}) {
  return parseValidatedUnixSeconds(record.pubdate, options);
}

/** 对单个视频卡片做严格判定；封面应跟随该结果一起处理。 */
export function classifyVideo(
  record: VideoRecord,
  cutoff: number | string | null | undefined,
  options: VideoFilterOptions = {},
): VideoVisibility {
  const enabled = options.enabled ?? (cutoff !== null && cutoff !== undefined && cutoff !== '');
  if (!enabled) return { visible: true, reason: 'filter-disabled', timestamp: null, record };
  const cutoffSeconds = getCutoffSeconds(cutoff);
  const timestamp = recordTimestamp(record, options);
  if (cutoffSeconds === null || timestamp === null) {
    return { visible: false, reason: 'unknown-time', timestamp, record };
  }
  if ((record as Record<string, unknown>).__dateOnly === true) {
    const cutoffDate = new Date(cutoffSeconds * 1000);
    const recordDate = new Date(timestamp * 1000);
    if (cutoffDate.getFullYear() === recordDate.getFullYear()
      && cutoffDate.getMonth() === recordDate.getMonth()
      && cutoffDate.getDate() === recordDate.getDate()) {
      return { visible: false, reason: 'unknown-time', timestamp, record };
    }
  }
  if (timestamp < cutoffSeconds) {
    return { visible: true, reason: 'before-cutoff', timestamp, record };
  }
  return { visible: false, reason: 'at-or-after-cutoff', timestamp, record };
}

export const classifyVideoRecord = classifyVideo;
export const classifyVideoCard = classifyVideo;

export function isVideoVisible(
  record: VideoRecord,
  cutoff: number | string | null | undefined,
  options: VideoFilterOptions = {},
): boolean {
  return classifyVideo(record, cutoff, options).visible;
}

/** 只返回可展示视频；原数组和原记录保持不变。 */
export function filterVideos(
  records: readonly VideoRecord[],
  cutoff: number | string | null | undefined,
  options: VideoFilterOptions = {},
): VideoRecord[] {
  return records.filter((record) => classifyVideo(record, cutoff, options).visible);
}

export const filterVideoRecords = filterVideos;
export const filterVideo = classifyVideo;

function getBvid(record: VideoRecord): string | null {
  const bvid = record.bvid;
  return typeof bvid === 'string' && bvid.trim() !== '' ? bvid : null;
}

function missingTimestamp(record: VideoRecord, options: TimeValidationOptions): boolean {
  return recordTimestamp(record, options) === null || (record as Record<string, unknown>).__dateOnly === true;
}

/**
 * 生成元数据补请求候选。候选只来自页面已经出现的 bvid，且最多 budget 条；
 * budget 为 0 时保证不产生任何候选，并发始终受限于 3。
 */
export function planVideoSupplements(
  records: readonly VideoRecord[],
  budget = 20,
  options: TimeValidationOptions = {},
): SupplementPlan {
  const boundedBudget = Math.max(0, Math.min(100, Math.floor(Number.isFinite(budget) ? budget : 0)));
  const seen = new Set<string>();
  const candidates: VideoSupplementCandidate[] = [];
  if (boundedBudget === 0) return { candidates, budget: boundedBudget, concurrency: 3 };
  records.forEach((record, index) => {
    const bvid = getBvid(record);
    if (!bvid || seen.has(bvid) || !missingTimestamp(record, options) || candidates.length >= boundedBudget) return;
    seen.add(bvid);
    candidates.push({ bvid, index, record });
  });
  return { candidates, budget: boundedBudget, concurrency: 3 };
}

export const getSupplementCandidates = planVideoSupplements;
export const createSupplementPlan = planVideoSupplements;

/** 将响应内的分 P 记录统一按主视频发布时间判定，避免拆分视频与封面。 */
export function filterPartsByMainVideo<T extends Record<string, unknown>>(
  parts: readonly T[],
  mainVideo: VideoRecord,
  cutoff: number | string | null | undefined,
  options: VideoFilterOptions = {},
): T[] {
  return isVideoVisible(mainVideo, cutoff, options) ? [...parts] : [];
}
