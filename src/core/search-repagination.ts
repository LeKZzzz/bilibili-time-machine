/**
 * 搜索结果跨页补齐的纯逻辑。
 *
 * 搜索页按时间过滤后，当前页可见结果可能明显少于原页容量。运行时用 B 站原生
 * 分页收集后续页快照，这里把多个快照合并成一个“已过滤、按 BV 号去重”的可见流，
 * 再按原页容量从当前页起始位置重新分配，并给出每个节点的最终处置。核心不接触
 * DOM、网络或浏览器 API，便于用 fixture 直接验证补齐、去重、页脚重算与安全退回。
 */
import { classifyVideo } from './video';
import type { VideoRecord } from './types';

/** 每次搜索最多继续获取的原生后续页数。 */
export const SEARCH_PAGE_PROBE_LIMIT = 2;
/** 无法从 DOM 读取原页容量时使用的 B 站搜索默认每页数量。 */
export const SEARCH_PAGE_SIZE_FALLBACK = 30;
/** 可见结果低于原页容量这一比例时触发补齐。 */
export const SEARCH_HALF_PAGE_RATIO = 0.5;

/** 单个搜索条目在补齐后的处置。 */
export type SearchItemDecision = 'keep' | 'advance' | 'hide' | 'drop';

export interface SearchItemInput {
  /** 稳定标识：优先 BV 号，其次 aid，最后位置键。 */
  id: string;
  /** 可判定的视频记录；非视频条目或无法构造记录时为 null。 */
  record: VideoRecord | null;
  /** 非视频活动/广告条目不参与时间过滤，但仍应保留在综合页视频分组中。 */
  filterable?: boolean;
}

export interface SearchPageSnapshot {
  /** 原始页码，从 1 开始。 */
  page: number;
  items: SearchItemInput[];
}

export interface SearchReflowPlan {
  /** 原页容量（目标页每页槽位数）。 */
  capacity: number;
  /** 用户当前页，也是重新分配的起始页。 */
  startPage: number;
  /** 已扫描页范围，闭区间。 */
  endPage: number;
  /** 绝对页码 -> 该页最终展示的可见 id 顺序。 */
  pages: Map<number, string[]>;
  /** 每个已扫描节点的最终处置。 */
  states: Map<string, SearchItemDecision>;
  /** 已前移到其原页之前、后续页不应再重复的 id 集合。 */
  advancedIds: Set<string>;
  /** 原页在补齐前的可见数量。 */
  originalVisible: number;
  /** 已扫描范围内的可见总数。 */
  total: number;
  /** 已扫描范围内容纳可见结果所需的页数。 */
  pageCount: number;
}

export interface SearchReflowOptions {
  cutoff: string | number | null | undefined;
  enabled: boolean;
  nowSeconds?: number;
  /** 用户当前页，重新分配从这里开始。 */
  originalPage: number;
  /** 原页已扫描到的最后一页。 */
  endPage: number;
  /** 原页容量；缺省时使用原页快照条目数，再缺省为 30。 */
  capacity?: number;
}

export interface SearchFooterSummary {
  /** 已扫描范围内的可见总数。 */
  total: number;
  /** 按原页容量换算的页数。 */
  pages: number;
  currentPage: number;
  pageSize: number;
}

function toUnixSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function hasVideoIdentity(record: Record<string, unknown>): boolean {
  if (typeof record.bvid === 'string' && record.bvid.trim() !== '') return true;
  if (typeof record.aid === 'number' || (typeof record.aid === 'string' && record.aid.trim() !== '')) return true;
  // 搜索卡片有时只给出 pic/title + pubdate，仍按视频记录处理。
  return 'pubdate' in record && ('pic' in record || 'title' in record);
}

function bvidOf(record: Record<string, unknown>): string | null {
  return typeof record.bvid === 'string' && record.bvid.trim() !== '' ? record.bvid.trim() : null;
}

/**
 * 把 B 站搜索响应或卡片条目标准化成可判定的视频记录。
 * - 明确带 bvid/aid/pubdate 的条目按视频处理；
 * - 动态条目读取 `modules.module_author.pub_ts`，或顶层 `pub_ts/pubtime/ctime`；
 * - 其余条目返回 null，占位但按未知时间隐藏。
 */
export function normalizeSearchResultRecord(item: unknown): VideoRecord | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  if (hasVideoIdentity(record)) return record as VideoRecord;
  const modules = record.modules;
  if (modules && typeof modules === 'object') {
    const author = (modules as Record<string, unknown>).module_author;
    if (author && typeof author === 'object') {
      const pubTs = toUnixSeconds((author as Record<string, unknown>).pub_ts);
      if (pubTs !== null) return { pubdate: pubTs };
    }
  }
  const pubTs = toUnixSeconds(record.pub_ts ?? record.pubtime ?? record.ctime);
  if (pubTs !== null && (typeof record.type === 'string' || 'id_str' in record)) {
    return { pubdate: pubTs };
  }
  return null;
}

/** 为条目生成去重 id；有 BV 号时使用规范化的 BV 号，否则回退 aid，再回退位置键。 */
export function searchItemId(record: VideoRecord | null, index: number): string {
  if (record) {
    const bvid = bvidOf(record as Record<string, unknown>);
    if (bvid) return `bvid:${bvid.toUpperCase()}`;
    const aid = (record as Record<string, unknown>).aid;
    if (typeof aid === 'number' || (typeof aid === 'string' && aid !== '')) return `aid:${String(aid)}`;
  }
  return `pos:${index}`;
}

/** 判定单个搜索条目的展示去向；无法确认时间时严格隐藏。 */
export function decideSearchItem(
  record: VideoRecord | null,
  options: Pick<SearchReflowOptions, 'cutoff' | 'enabled' | 'nowSeconds'>,
): 'keep' | 'hide' {
  if (!options.enabled) return 'keep';
  if (!record) return 'hide';
  const decision = classifyVideo(record, options.cutoff, { enabled: true, nowSeconds: options.nowSeconds });
  return decision.visible ? 'keep' : 'hide';
}

/** 当前页可见结果低于原页容量的一半时才需要继续补齐。 */
export function shouldProbeMorePages(visibleCount: number, capacity: number): boolean {
  if (!Number.isFinite(capacity) || capacity <= 0) return false;
  if (!Number.isFinite(visibleCount)) return false;
  return visibleCount < capacity * SEARCH_HALF_PAGE_RATIO;
}

/** `needsRepagination` 的语义别名。 */
export const needsRepagination = shouldProbeMorePages;

function dedupeSnapshots(snapshots: readonly SearchPageSnapshot[]): SearchPageSnapshot[] {
  return snapshots
    .filter((snapshot) => snapshot && Array.isArray(snapshot.items) && Number.isFinite(snapshot.page))
    .slice()
    .sort((a, b) => a.page - b.page);
}

/**
 * 合并多个原生页快照并按原页容量重新分页。
 *
 * 关键行为：
 * - 可见项按“页序 + 页内顺序”形成全局可见流，从起始页第一个槽位依次分配；
 * - 同 BV 号的重复项只保留第一次出现，后续重复按隐藏处理；
 * - 原页之后的可见项若被分配到更前面的页，计入 `advancedIds`；
 * - 超出已扫描页范围的可见项标记为 `drop`。
 */
export function planSearchReflow(
  snapshots: readonly SearchPageSnapshot[],
  options: SearchReflowOptions,
): SearchReflowPlan {
  const ordered = dedupeSnapshots(snapshots);
  const originalSnapshot = ordered.find((snapshot) => snapshot.page === options.originalPage);
  const capacity = Math.max(
    1,
    Math.trunc(options.capacity ?? originalSnapshot?.items.length ?? SEARCH_PAGE_SIZE_FALLBACK),
  );
  const startPage = Math.max(1, Math.trunc(options.originalPage));
  const endPage = Math.max(startPage, Math.trunc(options.endPage));

  const states = new Map<string, SearchItemDecision>();
  const pages = new Map<number, string[]>();
  const advancedIds = new Set<string>();
  const seenIdentities = new Set<string>();
  const visible: Array<{ id: string; originalPage: number }> = [];
  let originalVisible = 0;

  for (const snapshot of ordered) {
    let pageVisible = 0;
    for (const item of snapshot.items) {
      const decision = item.filterable === false ? 'keep' : decideSearchItem(item.record, options);
      if (decision !== 'keep') {
        states.set(item.id, 'hide');
        continue;
      }
      const identity = /^(?:bvid|aid):/.test(item.id) ? item.id : null;
      if (identity) {
        if (seenIdentities.has(identity)) {
          states.set(item.id, 'hide');
          continue;
        }
        seenIdentities.add(identity);
      }
      pageVisible += 1;
      visible.push({ id: item.id, originalPage: snapshot.page });
    }
    if (snapshot.page === options.originalPage) originalVisible = pageVisible;
  }

  visible.forEach((entry, index) => {
    const targetPage = startPage + Math.floor(index / capacity);
    if (targetPage > endPage) {
      states.set(entry.id, 'drop');
      return;
    }
    const list = pages.get(targetPage) ?? [];
    list.push(entry.id);
    pages.set(targetPage, list);
    states.set(entry.id, targetPage < entry.originalPage ? 'advance' : 'keep');
    if (targetPage < entry.originalPage) advancedIds.add(entry.id);
  });

  // 去重隐藏和越界丢弃不应覆盖已分配的 keep/advance 状态。
  return {
    capacity,
    startPage,
    endPage,
    pages,
    states,
    advancedIds,
    originalVisible,
    total: visible.length,
    pageCount: Math.max(1, Math.ceil(visible.length / capacity)),
  };
}

/**
 * 用给定的条目数组替换搜索响应中的结果数组，并保留页码、总页数等外层元数据。
 * 找不到结果数组时返回原载荷，保证调用方可以安全退回。
 */
export function replaceSearchPayloadItems(payload: unknown, items: readonly unknown[]): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;
  const hasData = root.data && typeof root.data === 'object';
  const data = (hasData ? root.data : root) as Record<string, unknown>;
  if (Array.isArray(data.result)) {
    const videoGroup = data.result.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Record<string, unknown>;
      return candidate.result_type === 'video' && Array.isArray(candidate.data);
    });
    if (videoGroup) {
      const nextResult = data.result.map((entry) => entry === videoGroup
        ? { ...(entry as Record<string, unknown>), data: [...items] }
        : entry);
      const nextData = { ...data, result: nextResult };
      return hasData ? { ...root, data: nextData } : nextData;
    }
  }
  for (const key of ['result', 'list', 'items', 'archives']) {
    if (Array.isArray(data[key])) {
      const nextData = { ...data, [key]: [...items] };
      return hasData ? { ...root, data: nextData } : nextData;
    }
  }
  return payload;
}

/** 更新搜索响应中已有的总数/总页数字段，供页面分页组件重算页脚。 */
export function replaceSearchPayloadSummary(
  payload: unknown,
  summary: { total: number; pages: number },
): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const root = payload as Record<string, unknown>;
  if (!root.data || typeof root.data !== 'object') return payload;
  const data = root.data as Record<string, unknown>;
  const nextData = { ...data };
  const updateSummaryObject = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    const source = value as Record<string, unknown>;
    const next = { ...source };
    if ('numResults' in source) next.numResults = summary.total;
    if ('num_results' in source) next.num_results = summary.total;
    if ('numPages' in source) next.numPages = summary.pages;
    if ('num_pages' in source) next.num_pages = summary.pages;
    if ('total_pages' in source) next.total_pages = summary.pages;
    return next;
  };
  if ('numResults' in data || 'num_results' in data) {
    if ('numResults' in data) nextData.numResults = summary.total;
    if ('num_results' in data) nextData.num_results = summary.total;
  }
  if ('numPages' in data || 'num_pages' in data || 'total_pages' in data) {
    if ('numPages' in data) nextData.numPages = summary.pages;
    if ('num_pages' in data) nextData.num_pages = summary.pages;
    if ('total_pages' in data) nextData.total_pages = summary.pages;
  }
  for (const key of ['pageinfo', 'pageInfo', 'top_tlist']) {
    if (nextData[key] && typeof nextData[key] === 'object') {
      const nested = nextData[key] as Record<string, unknown>;
      nextData[key] = {
        ...nested,
        ...(nested.video && typeof nested.video === 'object' ? { video: updateSummaryObject(nested.video) } : {}),
      };
    }
  }
  return { ...root, data: nextData };
}

/** 按已扫描范围重算页脚总数与页数。 */
export function searchFooterSummary(plan: SearchReflowPlan, pageSize?: number): SearchFooterSummary {
  const size = Math.max(1, Math.trunc(pageSize ?? plan.capacity));
  const total = plan.total;
  const pages = Math.max(1, Math.ceil(total / size));
  return { total, pages, currentPage: plan.startPage, pageSize: size };
}
