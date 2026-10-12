import { classifyVideo, planVideoSupplements, type VideoFilterOptions } from '../core/video';
import type { FilterConfig, VideoRecord } from '../core/types';
import { scanRenderedDynamics, scanRenderedMainVideo, scanRenderedVideoCards, type DomScanResult } from '../page/initial-state';
import { parseDisplayedCardDate } from '../page/search-card-date';
import { cardDecisionLog, devLog, supplementFailedLog, supplementPlanLog, supplementStartLog, supplementSuccessLog } from '../core/dev-log';

export interface VideoControllerOptions {
  root?: ParentNode;
  config: FilterConfig;
  fetchVideo?: (bvid: string) => Promise<VideoRecord | null>;
  onNotice?: (reason: 'supplement-failed' | 'unknown-time') => void;
  observe?: boolean;
}

export interface VideoController {
  scan(): DomScanResult;
  enqueue(records: readonly VideoRecord[]): Promise<void>;
  updateConfig(config: FilterConfig): void;
  /** 仅更新截止时间并重扫，保留补请求预算状态。 */
  updateCutoff(cutoffMinute: string | null): void;
  disconnect(): void;
}

const PAGE_STATE_KEY = '__bilibiliTimeFilterPageState';
interface PageState {
  pageKey: string;
  contentSignature: string;
}

/** 使用当前页面会话补取单个视频的最小元数据。 */
export function createPageVideoFetcher(target?: Window): (bvid: string) => Promise<VideoRecord | null> {
  const page = target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!page?.fetch) return async () => null;
  const request = page.fetch.bind(page);
  return async (bvid: string): Promise<VideoRecord | null> => {
    try {
      // B 站视频详情接口位于 API 主机；使用页面 fetch 保留当前会话凭据。
      const url = new URL('https://api.bilibili.com/x/web-interface/view');
      url.searchParams.set('bvid', bvid);
      const response = await request(url.toString(), { credentials: 'include' });
      if (!response.ok) return null;
      const payload = await response.json() as unknown;
      if (!payload || typeof payload !== 'object') return null;
      const envelope = payload as { code?: unknown; data?: unknown };
      if (envelope.code !== undefined && envelope.code !== 0) return null;
      const data = envelope.data;
      if (!data || typeof data !== 'object') return null;
      const value = data as Record<string, unknown>;
      return {
        bvid: typeof value.bvid === 'string' && value.bvid ? value.bvid : bvid,
        aid: typeof value.aid === 'string' || typeof value.aid === 'number' ? value.aid : undefined,
        pubdate: typeof value.pubdate === 'string' || typeof value.pubdate === 'number' ? value.pubdate : undefined,
        pic: typeof value.pic === 'string' ? value.pic : undefined,
        title: typeof value.title === 'string' ? value.title : undefined,
      };
    } catch {
      return null;
    }
  };
}

function cardSelector(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('[data-bvid], [data-aid].bili-video-card, .bili-video-card, .video-card'));
}

function readCardRecord(card: Element): VideoRecord {
  const element = card as HTMLElement;
  const value = (name: string) => element.getAttribute(`data-${name}`) || card.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`) || undefined;
  const href = card.querySelector<HTMLAnchorElement>('a[href*="/video/BV"], a[href*="/video/av"]')?.getAttribute('href') || '';
  const videoId = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(href)?.[1];
  const displayed = parseDisplayedCardDate(card.querySelector<HTMLElement>('.bili-video-card__info--date')?.textContent);
  return {
    bvid: value('bvid') || (videoId?.toLowerCase().startsWith('bv') ? videoId : undefined),
    aid: value('aid'),
    pubdate: value('pubdate') || displayed?.timestamp,
    ...(displayed ? { __dateOnly: true } : {}),
    pic: card.querySelector('img')?.getAttribute('src') || undefined,
    title: element.getAttribute('title') || card.querySelector('[title]')?.getAttribute('title') || undefined,
  };
}

function setCardVisible(card: Element, visible: boolean, unknown = false): void {
  const element = card as HTMLElement;
  const gridCell = card.closest('.col_3, .col_xs_1_5, .col_md_2, .col_xl_1_7') as HTMLElement | null;
  if (!visible) {
    element.hidden = true;
    element.setAttribute('data-time-filter-hidden', '1');
    if (unknown) element.setAttribute('data-time-filter-unknown', '1');
    if (gridCell) {
      gridCell.hidden = true;
      gridCell.setAttribute('data-time-filter-hidden', '1');
    }
  } else {
    element.hidden = false;
    element.removeAttribute('data-time-filter-hidden');
    element.removeAttribute('data-time-filter-unknown');
    if (gridCell?.getAttribute('data-time-filter-hidden') === '1') {
      gridCell.hidden = false;
      gridCell.removeAttribute('data-time-filter-hidden');
    }
  }
}

function applyFetchedRecord(root: ParentNode, bvid: string, fetched: VideoRecord, cutoffMinute: string | null, enabled: boolean): void {
  for (const card of cardSelector(root)) {
    const record = readCardRecord(card);
    if (record.bvid !== bvid) continue;
    if (fetched.pubdate !== undefined && fetched.pubdate !== null) {
      (card as HTMLElement).setAttribute('data-pubdate', String(fetched.pubdate));
    }
    const decision = classifyVideo({ ...fetched, bvid }, cutoffMinute, { enabled });
    if (__TIME_FILTER_DEV__) devLog.log(cardDecisionLog({ ...fetched, bvid }, decision, cutoffMinute, 'supplement'));
    setCardVisible(card, decision.visible, decision.reason === 'unknown-time');
  }
}

/** 记录一次补请求成功；只输出 bvid 与解析出的发布时间。 */
function logSupplementSuccess(bvid: string, fetched: VideoRecord): void {
  if (!__TIME_FILTER_DEV__) return;
  const pubdate = typeof fetched.pubdate === 'number' ? fetched.pubdate : Number(fetched.pubdate);
  devLog.log(supplementSuccessLog('dom', bvid, Number.isFinite(pubdate) && pubdate > 0 ? pubdate : null));
}

/** 记录一次补请求失败；bvid 可能因排队/异常而缺失。 */
function logSupplementFailure(bvid: string | null, cause: string): void {
  if (!__TIME_FILTER_DEV__) return;
  devLog.log(supplementFailedLog('dom', bvid, cause));
}

export function createVideoController(options: VideoControllerOptions): VideoController {
  const root = options.root ?? (typeof document !== 'undefined' ? document : null);
  if (!root) throw new Error('A document root is required');
  let config = { ...options.config };
  let disposed = false;
  let observer: MutationObserver | null = null;
  let activeScan: Promise<void> = Promise.resolve();
  const pending = new Set<string>();
  const attempted = new Set<string>();
  const fetchVideo = options.fetchVideo;
  const notify = options.onNotice ?? (() => undefined);
  const pageKey = (): string => {
    const documentRef = root.nodeType === 9 ? root as Document : (root as Node).ownerDocument;
    const location = documentRef?.defaultView?.location;
    if (!location) return '';
    const params = new URLSearchParams(location.search);
    // B 站分页同时使用 page 和 o；其余签名/展示参数不应重置当前页预算。
    return `${location.pathname}|page=${params.get('page') ?? '1'}|o=${params.get('o') ?? ''}`;
  };
  const documentRef = root.nodeType === 9 ? root as Document : (root as Node).ownerDocument;
  const view = documentRef?.defaultView as (Window & { [PAGE_STATE_KEY]?: PageState }) | null;
  const initialPageKey = pageKey();
  const savedPageState = view?.[PAGE_STATE_KEY];
  const isSearchPage = /^(\/all|\/search|\/$)/.test(view?.location.pathname ?? '');
  const previousPageState = isSearchPage && savedPageState && savedPageState.pageKey !== initialPageKey ? savedPageState : undefined;
  let lastPageKey = previousPageState?.pageKey ?? initialPageKey;
  let lastContentSignature = previousPageState?.contentSignature ?? '';
  let awaitingPageContent = false;
  let pageRescanTimers: number[] = [];
  let configRescanTimers: number[] = [];

  const contentSignature = (): string => cardSelector(root).slice(0, 6).map((card) => {
    const href = card.querySelector<HTMLAnchorElement>('a[href*="/video/"]')?.getAttribute('href') || '';
    return `${href}|${card.querySelector('[title]')?.textContent || ''}`;
  }).join('||');

  const initialStateSource = (): unknown => {
    const documentRef = (root as Document).nodeType === 9
      ? root as Document
      : (root as Node).ownerDocument;
    return documentRef?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  };

  const scan = (): DomScanResult => {
    if (disposed) return { checked: 0, hidden: 0, unknown: 0 };
    const currentPageKey = pageKey();
    if (currentPageKey !== lastPageKey) {
      lastPageKey = currentPageKey;
      attempted.clear();
      pending.clear();
      awaitingPageContent = true;
      const view = (root.nodeType === 9 ? root as Document : (root as Node).ownerDocument)?.defaultView;
      pageRescanTimers.forEach((timer) => view?.clearTimeout(timer));
      pageRescanTimers = view
        ? [50, 250, 800, 1600, 3000, 5000].map((delay) => view.setTimeout(() => { if (!disposed) scan(); }, delay))
        : [];
    }
    const signature = contentSignature();
    if (awaitingPageContent) {
      if (!signature || signature === lastContentSignature) return { checked: 0, hidden: 0, unknown: 0 };
      awaitingPageContent = false;
    }
    lastContentSignature = signature;
    if (view) view[PAGE_STATE_KEY] = { pageKey: currentPageKey, contentSignature: signature };
    // 将 SSR 注入的 __INITIAL_STATE__ 作为首屏元数据源，与卡片扫描共用同一判定函数。
    const source = initialStateSource();
    const cards = scanRenderedVideoCards(root, config.cutoffMinute, { enabled: config.enabled }, source);
    const mainVideo = scanRenderedMainVideo(root, config.cutoffMinute, { enabled: config.enabled }, source);
    const dynamics = scanRenderedDynamics(root, config.cutoffMinute, { enabled: config.enabled });
    const result = {
      checked: cards.checked + mainVideo.checked + dynamics.checked,
      hidden: cards.hidden + mainVideo.hidden + dynamics.hidden,
      unknown: cards.unknown + mainVideo.unknown + dynamics.unknown,
    };
    if (config.enabled && config.cutoffMinute && fetchVideo) {
      const cards = cardSelector(root);
      const records = cards.map(readCardRecord);
      const remainingBudget = Math.max(0, config.supplementBudget - attempted.size);
      const plan = planVideoSupplements(records.filter((record) => !attempted.has(String(record.bvid))), remainingBudget);
      const candidates = plan.candidates.filter((candidate) => !pending.has(candidate.bvid));
      candidates.forEach((candidate) => attempted.add(candidate.bvid));
      candidates.forEach((candidate) => pending.add(candidate.bvid));
      if (__TIME_FILTER_DEV__ && candidates.length > 0) {
        devLog.log(supplementPlanLog('dom', candidates.length, plan.budget, plan.concurrency));
      }
      if (candidates.length > 0) {
        activeScan = activeScan.then(async () => {
          const queue = candidates.slice();
          const worker = async () => {
            while (!disposed && queue.length > 0) {
              const candidate = queue.shift();
              if (!candidate) return;
              if (__TIME_FILTER_DEV__) {
                devLog.log(supplementStartLog('dom', candidate.bvid, plan.concurrency));
              }
              try {
                const fetched = await fetchVideo(candidate.bvid);
                if (fetched) {
                  logSupplementSuccess(candidate.bvid, fetched);
                  applyFetchedRecord(root, candidate.bvid, fetched, config.cutoffMinute, config.enabled);
                } else {
                  logSupplementFailure(candidate.bvid, 'empty');
                  notify('supplement-failed');
                }
              } catch {
                logSupplementFailure(candidate.bvid, 'error');
                notify('supplement-failed');
              } finally {
                pending.delete(candidate.bvid);
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(plan.concurrency, candidates.length) }, worker));
        });
      }
    }
    if (result.unknown > 0) {
      if (__TIME_FILTER_DEV__) {
        devLog.log({ reason: 'unknown-time', message: '存在无法验证时间的内容', count: result.unknown, details: { source: 'dom', hidden: result.hidden } });
      }
      notify('unknown-time');
    }
    return result;
  };

  const enqueue = async (records: readonly VideoRecord[]): Promise<void> => {
    if (!config.enabled || !config.cutoffMinute || !fetchVideo || disposed) return;
    const remainingBudget = Math.max(0, config.supplementBudget - attempted.size);
    const plan = planVideoSupplements(records.filter((record) => !attempted.has(String(record.bvid))), remainingBudget);
    const rootRecords = plan.candidates.filter((candidate) => !pending.has(candidate.bvid));
    rootRecords.forEach((candidate) => pending.add(candidate.bvid));
    rootRecords.forEach((candidate) => attempted.add(candidate.bvid));
    if (__TIME_FILTER_DEV__ && rootRecords.length > 0) {
      devLog.log(supplementPlanLog('enqueue', rootRecords.length, plan.budget, plan.concurrency));
    }
    const queue = rootRecords.slice();
    const worker = async () => {
      while (!disposed && queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate) return;
        if (__TIME_FILTER_DEV__) {
          devLog.log(supplementStartLog('enqueue', candidate.bvid, plan.concurrency));
        }
        try {
          const fetched = await fetchVideo(candidate.bvid);
          if (!fetched) {
            logSupplementFailure(candidate.bvid, 'empty');
            notify('supplement-failed');
          } else {
            logSupplementSuccess(candidate.bvid, fetched);
            applyFetchedRecord(root, candidate.bvid, fetched, config.cutoffMinute, config.enabled);
          }
        } catch {
          logSupplementFailure(candidate.bvid, 'error');
          notify('supplement-failed');
        } finally {
          pending.delete(candidate.bvid);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(plan.concurrency, queue.length) }, worker));
  };

  const updateConfig = (next: FilterConfig): void => {
    if (next.enabled !== config.enabled || next.cutoffMinute !== config.cutoffMinute) {
      attempted.clear();
      pending.clear();
    }
    config = { ...next };
    scan();
    const timerView = documentRef?.defaultView;
    configRescanTimers.forEach((timer) => timerView?.clearTimeout(timer));
    configRescanTimers = timerView
      ? [50, 250, 800, 1500].map((delay) => timerView.setTimeout(() => { if (!disposed) scan(); }, delay))
      : [];
  };

  const updateCutoff = (cutoffMinute: string | null): void => {
    if (disposed || config.cutoffMinute === cutoffMinute) return;
    config = { ...config, cutoffMinute };
    scan();
  };

  if (options.observe !== false && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => scan());
    observer.observe(root as Node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-bvid', 'data-aid', 'data-pubdate'],
    });
  }

  const disconnect = (): void => {
    disposed = true;
    const view = (root.nodeType === 9 ? root as Document : (root as Node).ownerDocument)?.defaultView;
    pageRescanTimers.forEach((timer) => view?.clearTimeout(timer));
    pageRescanTimers = [];
    configRescanTimers.forEach((timer) => view?.clearTimeout(timer));
    configRescanTimers = [];
    observer?.disconnect();
    observer = null;
  };

  return { scan, enqueue, updateConfig, updateCutoff, disconnect };
}

