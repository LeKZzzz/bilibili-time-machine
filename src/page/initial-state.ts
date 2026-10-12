import { classifyVideo, type VideoFilterOptions } from '../core/video';
import { parseDisplayedCardDate } from './search-card-date';
import type { VideoRecord } from '../core/types';
import { parseValidatedUnixSeconds, getCutoffSeconds } from '../core/time';
import { cardDecisionLog, devLog } from '../core/dev-log';

export interface InitialStateWindow {
  __INITIAL_STATE__?: unknown;
}

export interface InitialStateResult {
  records: VideoRecord[];
  hidden: VideoRecord[];
  state: unknown;
}

const VIDEO_KEYS = new Set([
  'videoData',
  'archive',
  'archives',
  'videos',
  'list',
  'items',
  'item',
  'recommend',
  'recommendData',
  'feed',
  'data',
  'result',
]); // 仅读取 B 站常见结构键

function looksLikeVideo(value: unknown): value is VideoRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return 'bvid' in record || 'aid' in record || ('pubdate' in record && ('pic' in record || 'title' in record));
}

function collect(value: unknown, result: VideoRecord[], seen: Set<object>): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collect(item, result, seen);
    return;
  }
  if (looksLikeVideo(value)) result.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (VIDEO_KEYS.has(key)) collect(child, result, seen);
  }
}

export function readInitialState(source: InitialStateWindow | unknown): unknown {
  if (!source || typeof source !== 'object') return undefined;
  return (source as InitialStateWindow).__INITIAL_STATE__;
}

export function readInitialVideoRecords(source: InitialStateWindow | unknown): VideoRecord[] {
  const state = readInitialState(source);
  const records: VideoRecord[] = [];
  collect(state, records, new Set<object>());
  return records;
}

export function filterInitialState(source: InitialStateWindow | unknown, cutoff: string | number | null | undefined, options: VideoFilterOptions = {}): InitialStateResult {
  const state = readInitialState(source);
  const records = readInitialVideoRecords(source);
  const hidden = records.filter((record) => !classifyVideo(record, cutoff, options).visible);
  return { records, hidden, state };
}

function setVisible(element: Element, visible: boolean): void {
  const html = element as HTMLElement;
  if (!visible) {
    html.hidden = true;
    html.setAttribute('data-time-filter-hidden', '1');
  } else if (html.getAttribute('data-time-filter-hidden') === '1') {
    html.hidden = false;
    html.removeAttribute('data-time-filter-hidden');
  }
}

function setCardVisible(element: Element, visible: boolean): void {
  setVisible(element, visible);
  const gridCell = element.closest('.col_3, .col_xs_1_5, .col_md_2, .col_xl_1_7');
  if (gridCell) setVisible(gridCell, visible);
}

function recordFromCard(card: Element): VideoRecord {
  const html = card as HTMLElement;
  const bvid = html.getAttribute('data-bvid') || card.querySelector('[data-bvid]')?.getAttribute('data-bvid') || undefined;
  const aid = html.getAttribute('data-aid') || card.querySelector('[data-aid]')?.getAttribute('data-aid') || undefined;
  const pubdate = html.getAttribute('data-pubdate') || card.querySelector('[data-pubdate]')?.getAttribute('data-pubdate') || undefined;
  const pic = html.querySelector('img')?.getAttribute('src') || undefined;
  const title = html.getAttribute('title') || card.querySelector('[title]')?.getAttribute('title') || undefined;
  const href = card.querySelector<HTMLAnchorElement>('a[href*="/video/BV"], a[href*="/video/av"]')?.getAttribute('href') || '';
  const videoId = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(href)?.[1];
  const displayed = parseDisplayedCardDate(card.querySelector<HTMLElement>('.bili-video-card__info--date')?.textContent);
  return { bvid: bvid || (videoId?.toLowerCase().startsWith('bv') ? videoId : undefined), aid, pubdate: pubdate || displayed?.timestamp, pic, title, ...(displayed ? { __dateOnly: true } : {}) };
}

function mergeDefined(base: VideoRecord, override: VideoRecord): VideoRecord {
  const merged: VideoRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined && value !== null && value !== '') merged[key] = value;
  }
  return merged;
}

function stateRecordMap(source: unknown): Map<string, VideoRecord> {
  const map = new Map<string, VideoRecord>();
  for (const record of readInitialVideoRecords(source)) {
    const key = typeof record.bvid === 'string' && record.bvid.trim()
      ? `bvid:${record.bvid.trim()}`
      : record.aid !== undefined && record.aid !== null
        ? `aid:${String(record.aid)}`
        : null;
    if (key && !map.has(key)) map.set(key, record);
  }
  return map;
}

function recordStateKey(record: VideoRecord): string | null {
  if (typeof record.bvid === 'string' && record.bvid.trim()) return `bvid:${record.bvid.trim()}`;
  if (record.aid !== undefined && record.aid !== null) return `aid:${String(record.aid)}`;
  return null;
}

export interface DomScanResult {
  checked: number;
  hidden: number;
  unknown: number;
}

function parseDynamicDate(text: string | null | undefined, now = new Date()): number | null {
  if (!text) return null;
  const value = text.trim();
  const full = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+|[T ])(\d{1,2}):?(\d{2})(?::(\d{2}))?/.exec(value);
  if (full) {
    const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), Number(full[6] || 0));
    return parseValidatedUnixSeconds(Math.trunc(date.getTime() / 1000));
  }
  const dateOnly = /(\d{4})年(\d{1,2})月(\d{1,2})日?|\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1] || dateOnly[4]);
    const month = Number(dateOnly[2] || dateOnly[5]);
    const day = Number(dateOnly[3] || dateOnly[6]);
    return Math.trunc(new Date(year, month - 1, day).getTime() / 1000);
  }
  const monthDay = /(\d{1,2})月(\d{1,2})日?/.exec(value);
  if (monthDay) return Math.trunc(new Date(now.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2])).getTime() / 1000);
  const monthDayTime = /\b(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (monthDayTime) {
    const date = new Date(now.getFullYear(), Number(monthDayTime[1]) - 1, Number(monthDayTime[2]), Number(monthDayTime[3]), Number(monthDayTime[4]), Number(monthDayTime[5] || 0));
    return parseValidatedUnixSeconds(Math.trunc(date.getTime() / 1000));
  }
  const relative = /(\d+)\s*(天|小时|分鐘|分钟|分钟前|小时前)前/.exec(value);
  if (relative) {
    const units: Record<string, number> = { 天: 86400, 小时: 3600, 分钟: 60, 分鐘: 60 };
    return Math.trunc(now.getTime() / 1000) - Number(relative[1]) * (units[relative[2]] || 60);
  }
  if (value.includes('昨天')) return Math.trunc(now.getTime() / 1000) - 86400;
  if (value.includes('今天') || value.includes('刚刚')) return Math.trunc(now.getTime() / 1000);
  return null;
}

/** 动态页没有稳定的 data 属性，使用页面显示的发布时间作为配置变更后的兜底重扫依据。 */
export function scanRenderedDynamics(
  root: ParentNode,
  cutoff: string | number | null | undefined,
  options: VideoFilterOptions = {},
): DomScanResult {
  const outerElements = Array.from(root.querySelectorAll('.bili-dyn-list__item, .opus-card'));
  const elements = outerElements.length > 0 ? outerElements : Array.from(root.querySelectorAll('.bili-dyn-item'));
  const cutoffSeconds = getCutoffSeconds(cutoff);
  let hidden = 0;
  let unknown = 0;
  elements.forEach((element, index) => {
    const html = element as HTMLElement;
    const timestamp = parseValidatedUnixSeconds(
      html.getAttribute('data-pub-ts') || html.getAttribute('data-pubtime') || html.getAttribute('data-timestamp')
        || parseDynamicDate(element.querySelector('.bili-dyn-item__desc, .opus-card__subtitle')?.textContent),
    );
    const visible = !(options.enabled ?? Boolean(cutoff))
      || (cutoffSeconds !== null && timestamp !== null && timestamp < cutoffSeconds);
    if (__TIME_FILTER_DEV__) {
      devLog.log({
        reason: 'dynamic-decision',
        message: '动态时间判定',
        key: `dynamic:${index}:${timestamp ?? 'null'}:${visible}:${cutoff ?? 'none'}`,
        details: {
          pubdate: timestamp,
          cutoff: cutoff === null || cutoff === undefined ? null : String(cutoff),
          verdict: visible ? 'before-cutoff' : timestamp === null ? 'unknown-time' : 'at-or-after-cutoff',
          visible,
          source: 'dynamic',
        },
      });
    }
    if (!visible) {
      html.hidden = true;
      html.setAttribute('data-time-filter-hidden', '1');
      hidden += 1;
      if (timestamp === null) unknown += 1;
    } else if (html.getAttribute('data-time-filter-hidden') === '1') {
      html.hidden = false;
      html.removeAttribute('data-time-filter-hidden');
    }
  });
  return { checked: elements.length, hidden, unknown };
}

/** 过滤视频详情页主视频信息，避免只过滤推荐卡片而放行主标题。 */
export function scanRenderedMainVideo(
  root: ParentNode,
  cutoff: string | number | null | undefined,
  options: VideoFilterOptions = {},
  initialStateSource?: unknown,
): DomScanResult {
  if (initialStateSource === undefined) return { checked: 0, hidden: 0, unknown: 0 };
  const documentRef = (root as Document).nodeType === 9 ? root as Document : (root as Node).ownerDocument;
  const pathname = documentRef?.defaultView?.location?.pathname ?? '';
  const match = pathname.match(/^\/video\/(bv[0-9a-z]+|av\d+)(?:\/|$)/i);
  if (!match) return { checked: 0, hidden: 0, unknown: 0 };
  const key = match[1].toLowerCase();
  const record = readInitialVideoRecords(initialStateSource).find((item) => {
    if (key.startsWith('bv')) return typeof item.bvid === 'string' && item.bvid.toLowerCase() === key;
    return String(item.aid ?? '').toLowerCase() === key.slice(2);
  });
  if (!record) return { checked: 0, hidden: 0, unknown: 0 };
  const decision = classifyVideo(record, cutoff, options);
  if (__TIME_FILTER_DEV__) devLog.log(cardDecisionLog(record, decision, cutoff, 'main-video'));
  const elements = Array.from(root.querySelectorAll('#viewbox_report, .video-info-container, h1.video-title'));
  for (const element of elements) setVisible(element, decision.visible);
  return {
    checked: elements.length,
    hidden: decision.visible ? 0 : elements.length,
    unknown: decision.reason === 'unknown-time' ? elements.length : 0,
  };
}

/** 仅扫描明确的视频卡片/封面容器，未知时间先隐藏，避免首屏闪现。 */
export function scanRenderedVideoCards(
  root: ParentNode,
  cutoff: string | number | null | undefined,
  options: VideoFilterOptions = {},
  initialStateSource?: unknown,
): DomScanResult {
  const elements = Array.from(root.querySelectorAll('[data-bvid], [data-aid].bili-video-card, .bili-video-card, .video-card'));
  const initialRecords = initialStateSource === undefined ? new Map<string, VideoRecord>() : stateRecordMap(initialStateSource);
  let hidden = 0;
  let unknown = 0;
  for (const element of elements) {
    const cardRecord = recordFromCard(element);
    const stateRecord = recordStateKey(cardRecord) ? initialRecords.get(recordStateKey(cardRecord) as string) : undefined;
    const record = stateRecord ? mergeDefined(stateRecord, cardRecord) : cardRecord;
    const decision = classifyVideo(record, cutoff, options);
    if (__TIME_FILTER_DEV__) devLog.log(cardDecisionLog(record, decision, cutoff, stateRecord ? 'initial-state' : 'dom'));
    setCardVisible(element, decision.visible);
    if (!decision.visible) hidden += 1;
    if (decision.reason === 'unknown-time') unknown += 1;
  }
  return { checked: elements.length, hidden, unknown };
}
