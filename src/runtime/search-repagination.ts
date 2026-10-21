/**
 * 搜索结果跨页补齐的运行时控制器。
 *
 * 搜索页在响应进入页面前就被过滤，导致某些页可见结果稀疏。控制器会：
 * 1. 缓存页面原生搜索响应（按页，只保留条目 id 与载荷引用）；
 * 2. 当前页可见数低于原页容量一半时，通过页面原生分页控件/请求继续扫描后两页；
 * 3. 用纯核心 `planSearchReflow` 合并、按 BV 号去重并按原页容量重新分配；
 * 4. 对扫描范围内的每一页返回重排后的结果切片，并恢复用户原始页码与 URL；
 * 5. 后续页自然排除已经前移到前面页的视频。
 *
 * 任何原生请求或数据结构异常都安全退回现有的逐页过滤：不抛错、不改写 WBI 签名 URL。
 */
import { classifyVideo } from '../core/video';
import {
  SEARCH_PAGE_PROBE_LIMIT,
  SEARCH_PAGE_SIZE_FALLBACK,
  needsRepagination,
  normalizeSearchResultRecord,
  planSearchReflow,
  replaceSearchPayloadItems,
  replaceSearchPayloadSummary,
  searchFooterSummary,
  searchItemId,
  type SearchItemInput,
  type SearchPageSnapshot,
  type SearchReflowPlan,
} from '../core/search-repagination';
import type { FilterConfig } from '../core/types';
import { devLog } from '../core/dev-log';

export interface SearchRepaginationOptions {
  document?: Document;
  target?: Window;
  /** 读取原页容量；返回 null 时使用原生载荷条目数，再回退 30。 */
  readPageSize?: (documentRef: Document) => number | null;
  /** 读取已知总页数；null 表示未知。 */
  readPageCount?: (documentRef: Document) => number | null;
  /**
   * 触发一次原生分页并等待该页数字响应被捕获。缺省实现优先点击页面原生分页
   * 控件，其次改写 URL 并派发 popstate，由 B 站自身发起带签名的分页请求。
   * 返回 false 表示未取得该页数据。测试可注入。
   */
  requestPage?: (page: number) => Promise<boolean>;
  /** 在当前页重排后写入页脚总数与页数。 */
  writeFooter?: (documentRef: Document, total: number, pages: number) => void;
  onNotice?: (reason: 'repagination-failed') => void;
  now?: () => number;
}

export interface SearchRepaginationHandle {
  /** 配置变更后更新内部配置；关闭或未设置截止时间时完全旁路。 */
  apply(config: FilterConfig): void;
  /**
   * 网络 Hook 的统一委托入口：缓存原生载荷，并在需要时返回当前页重排后的结果；
   * 返回 `undefined` 表示沿用现有逐页过滤。
   */
  transformVideo(url: string, payload: unknown, config: FilterConfig): unknown | undefined;
  destroy(): void;
}

interface RepaginationRegion {
  /** 稀疏页，也是重新分配的起始页。 */
  anchorPage: number;
  /** 已扫描到的最后一页。 */
  endPage: number;
  planned: boolean;
}

interface RepaginationState {
  key: string;
  regions: RepaginationRegion[];
}

const CONTROLLER_KEY = '__bilibiliTimeFilterSearchRepaginationController';
const MAX_REGIONS = 4;

function toPositiveInt(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

/** 从搜索响应中提取条目数组、页码和总页数；兼容常见包装。 */
export function collectSearchPayload(payload: unknown): { items: unknown[]; page: number | null; numPages: number | null } {
  if (!payload || typeof payload !== 'object') return { items: [], page: null, numPages: null };
  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  if (Array.isArray(data.result)) {
    const videoGroup = data.result.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Record<string, unknown>;
      return candidate.result_type === 'video' && Array.isArray(candidate.data);
    }) as Record<string, unknown> | undefined;
    if (videoGroup) {
      return {
        items: videoGroup.data as unknown[],
        page: toPositiveInt(data.page ?? data.pn),
        numPages: toPositiveInt(data.numPages ?? data.num_pages ?? data.total_pages),
      };
    }
  }
  for (const key of ['result', 'list', 'items', 'archives']) {
    if (Array.isArray(data[key])) {
      return {
        items: data[key] as unknown[],
        page: toPositiveInt(data.page ?? data.pn),
        numPages: toPositiveInt(data.numPages ?? data.num_pages ?? data.total_pages),
      };
    }
  }
  return { items: [], page: null, numPages: null };
}

/** 从当前搜索页 URL 读取页码、关键字、稳定键和原始 page 参数。 */
export function readSearchLocation(location: Location): { page: number; keyword: string; key: string; pageParam: string } {
  const params = new URLSearchParams(location.search);
  const page = toPositiveInt(params.get('page')) ?? 1;
  const keyword = params.get('keyword') ?? '';
  const transient = new Set(['page', 'o', 'w_rid', 'wts', 'dynamic_offset', 'web_roll_page']);
  const stableQuery = Array.from(params.entries())
    .filter(([name]) => !transient.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return {
    page,
    keyword,
    key: `${location.host}${location.pathname}|${stableQuery}`,
    pageParam: params.get('page') ?? '',
  };
}

function extractItems(payload: unknown, page: number): { items: SearchItemInput[]; raw: unknown[] } {
  const { items } = collectSearchPayload(payload);
  const mapped = items.map((item, index) => {
    const record = normalizeSearchResultRecord(item);
    return {
      item,
      entry: { id: searchItemId(record, page * 100000 + index), record, filterable: record !== null } satisfies SearchItemInput,
    };
  });
  return { items: mapped.map(({ entry }) => entry), raw: mapped.map(({ item }) => item) };
}

function stateStore(_target: Window | undefined): Map<string, RepaginationState> {
  // 补齐状态按控制器实例保存；SPA 路由重挂载会重建控制器，避免旧计划串到新关键字。
  return new Map();
}

const PAGE_SIZE_ATTR = 'data-search-reflow-page-size';
const PAGE_COUNT_ATTR = 'data-search-reflow-page-count';

function readPageSize(documentRef: Document): number | null {
  return toPositiveInt(documentRef.documentElement?.getAttribute(PAGE_SIZE_ATTR));
}

function readPageCount(documentRef: Document): number | null {
  return toPositiveInt(documentRef.documentElement?.getAttribute(PAGE_COUNT_ATTR));
}

/**
 * 默认原生分页驱动：优先点击页面原生分页控件；不可用时改写 URL 并派发 popstate，
 * 由 B 站自身发起带签名的分页请求。永不直接改写含 WBI 签名的请求 URL。
 */
export function createNativePageDriver(target: Window, documentRef: Document): (page: number) => Promise<boolean> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => {
    target.setTimeout(resolve, ms);
  });
  const findControl = (page: number): HTMLElement | null => {
    const containers = documentRef.querySelectorAll<HTMLElement>('.vui_pagenation, .page-wrap, .search-pagination');
    const scopes = containers.length > 0 ? Array.from(containers) : [documentRef.documentElement];
    for (const scope of scopes) {
      if (!scope) continue;
      const controls = Array.from(scope.querySelectorAll<HTMLElement>('a, button, li'));
      const match = controls.find((element) => {
        const text = element.textContent?.trim();
        if (text === String(page)) return true;
        const href = element.getAttribute('href') ?? '';
        if (!href) return false;
        try {
          return new URL(href, target.location.href).searchParams.get('page') === String(page);
        } catch {
          return false;
        }
      });
      if (match) return match;
    }
    return null;
  };
  return async (page: number): Promise<boolean> => {
    const control = findControl(page);
    if (control) {
      control.click();
      await wait(500);
      return true;
    }
    try {
      const url = new URL(target.location.href);
      if (url.searchParams.has('w_rid') || url.searchParams.has('wts') || url.searchParams.has('token')) return false;
      url.searchParams.set('page', String(page));
      target.history.pushState({}, '', url.toString());
      target.dispatchEvent(new PopStateEvent('popstate'));
      await wait(500);
      return true;
    } catch {
      return false;
    }
  };
}

const FOOTER_TOTAL_SELECTOR = '[data-search-reflow-total]';
const FOOTER_TOTAL_TEXT = /(共|找到|约)\s*\d+\s*(条|个)?/;

/** 在节点文本中定位“共 N 条”式的总数文本并只替换数字，保留分页按钮等其它内容。 */
function replaceTotalText(node: Element, total: number): boolean {
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const text = current.textContent ?? '';
    if (FOOTER_TOTAL_TEXT.test(text)) {
      current.textContent = text.replace(/\d+/, String(total));
      return true;
    }
    current = walker.nextNode();
  }
  return false;
}

/**
 * 按已扫描范围重写页脚总数与页数。只替换明确的“共 N 条”总数文本，
 * 不重写页码按钮；找不到稳定目标时只在容器上写入页数属性，保持 B 站原分页交互。
 */
export function writeSearchFooter(documentRef: Document, total: number, pages: number): void {
  const explicit = documentRef.querySelector<HTMLElement>(FOOTER_TOTAL_SELECTOR);
  if (explicit) {
    explicit.textContent = String(total);
    explicit.setAttribute('data-search-reflow-pages', String(pages));
    return;
  }
  const container = documentRef.querySelector<HTMLElement>('.vui_pagenation, .page-wrap, .search-pagination');
  if (!container) return;
  container.setAttribute('data-search-reflow-total', '1');
  container.setAttribute('data-search-reflow-pages', String(pages));
  const current = toPositiveInt(new URL(documentRef.defaultView?.location.href ?? '/', documentRef.baseURI).searchParams.get('page')) ?? 1;
  for (const control of Array.from(container.querySelectorAll<HTMLElement>('[aria-label^="第 "]'))) {
    const match = /^第\s*(\d+)\s*页/.exec(control.getAttribute('aria-label') ?? '');
    if (!match) continue;
    const page = Number(match[1]);
    control.hidden = page > pages;
  }
  const next = container.querySelector<HTMLElement>('[aria-label="下一页"]');
  if (next) {
    next.hidden = current >= pages;
    next.setAttribute('aria-disabled', String(current >= pages));
  }
  const totalNode = documentRef.querySelector<HTMLElement>('.search-page-count, .num, .vui_pagenation__total, .page-total')
    ?? container;
  replaceTotalText(totalNode, total);
}

export function createSearchRepagination(options: SearchRepaginationOptions = {}): SearchRepaginationHandle {
  const documentRef = options.document ?? (typeof document !== 'undefined' ? document : undefined);
  const target = options.target ?? documentRef?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  const notify = options.onNotice ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const readPageSizeFn = options.readPageSize ?? readPageSize;
  const readPageCountFn = options.readPageCount ?? readPageCount;
  const footerWriter = options.writeFooter ?? writeSearchFooter;

  const itemsByPage = new Map<number, SearchItemInput[]>();
  const rawById = new Map<string, unknown>();
  const stateMap = stateStore(target);
  let observedPages: number | null = null;
  let config: FilterConfig = { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false };
  let probing = false;
  let destroyed = false;

  const location = (): Location | null => target?.location ?? null;

  const isSearchRoute = (): boolean => {
    const loc = location();
    if (!loc) return false;
    return loc.hostname === 'search.bilibili.com' || loc.pathname === '/all' || loc.pathname.startsWith('/search');
  };

  const capacity = (): number => {
    const fromDom = readPageSizeFn(documentRef as Document);
    if (fromDom) return fromDom;
    let observed = 0;
    for (const items of itemsByPage.values()) observed = Math.max(observed, items.length);
    return observed > 0 ? observed : SEARCH_PAGE_SIZE_FALLBACK;
  };

  const countVisible = (items: readonly SearchItemInput[]): number => {
    let count = 0;
    for (const item of items) {
      if (item.filterable === false || (item.record && classifyVideo(item.record, config.cutoffMinute, { enabled: true, nowSeconds: now() / 1000 }).visible)) {
        count += 1;
      }
    }
    return count;
  };

  const storePayload = (page: number, payload: unknown): void => {
    const meta = collectSearchPayload(payload);
    const { items, raw } = extractItems(payload, page);
    if (meta.numPages !== null) observedPages = observedPages === null ? meta.numPages : Math.max(observedPages, meta.numPages);
    if (items.length === 0) return;
    itemsByPage.set(page, items);
    items.forEach((entry, index) => {
      // 去重时保留首次出现的原始条目，避免后续页覆盖前页的载荷引用。
      if (!rawById.has(entry.id)) rawById.set(entry.id, raw[index]);
    });
  };

  const buildSnapshots = (startPage: number, endPage: number): SearchPageSnapshot[] => {
    const snapshots: SearchPageSnapshot[] = [];
    for (let page = startPage; page <= endPage; page += 1) {
      const items = itemsByPage.get(page);
      if (items) snapshots.push({ page, items });
    }
    return snapshots;
  };

  const buildPlan = (anchorPage: number, endPage: number, cap: number): SearchReflowPlan => planSearchReflow(
    buildSnapshots(anchorPage, endPage),
    {
      cutoff: config.cutoffMinute,
      enabled: true,
      nowSeconds: now() / 1000,
      originalPage: anchorPage,
      endPage,
      capacity: cap,
    },
  );

  const slicePayload = (payload: unknown, ids: readonly string[], summary: { total: number; pages: number }): unknown => {
    const selected = ids.map((id) => rawById.get(id)).filter((item): item is unknown => item !== undefined);
    return replaceSearchPayloadSummary(replaceSearchPayloadItems(payload, selected), summary);
  };

  /** 重排后最后一页的可见数，用于判断是否还需继续探测。 */
  const lastAllocatedCount = (plan: SearchReflowPlan): number => {
    const lastKey = Array.from(plan.pages.keys()).sort((a, b) => b - a)[0];
    return lastKey === undefined ? 0 : (plan.pages.get(lastKey)?.length ?? 0);
  };

  const requestPage = options.requestPage ?? ((page: number): Promise<boolean> => {
    if (!target || !documentRef) return Promise.resolve(false);
    return createNativePageDriver(target, documentRef)(page);
  });

  /** 恢复用户原始 URL 的 page 参数，避免探测留下的页码。 */
  const restoreUrl = (pageParam: string): void => {
    if (!target) return;
    try {
      const url = new URL(target.location.href);
      const current = url.searchParams.get('page') ?? '';
      if (current === pageParam) return;
      if (pageParam) url.searchParams.set('page', pageParam);
      else url.searchParams.delete('page');
      target.history.replaceState(target.history.state, '', url.toString());
    } catch {
      // 无法恢复时保持当前 URL。
    }
  };

  const waitForPage = async (page: number, timeoutMs = 2000): Promise<boolean> => {
    const start = now();
    const maxAttempts = 40;
    for (let attempt = 0; attempt < maxAttempts && !destroyed; attempt += 1) {
      if (itemsByPage.has(page)) return true;
      if (now() - start >= timeoutMs) break;
      await new Promise((resolve) => target?.setTimeout(resolve, 100));
    }
    return itemsByPage.has(page);
  };

  const regionFor = (state: RepaginationState, page: number): RepaginationRegion | undefined =>
    state.regions.find((region) => page >= region.anchorPage && page <= region.endPage);

  const runProbe = async (anchorPage: number, key: string, pageParam: string): Promise<void> => {
    if (probing || destroyed) return;
    probing = true;
    try {
      const totalKnown = readPageCountFn(documentRef as Document) ?? observedPages;
      const cap = capacity();
      const state = stateMap.get(key) ?? { key, regions: [] };
      let lastPage = anchorPage;
      let probed = 0;
      let confirmedEnd = false;
      const half = Math.ceil(cap / 2);
      while (probed < SEARCH_PAGE_PROBE_LIMIT && !confirmedEnd && !destroyed) {
        // 判断是否还需要继续：首个稀疏页看原页可见数；后续页看重排后最后一页
        // 是否低于半页（“中间页尽量至少半页，确认无更多结果时末页可不足半页”）。
        const needsMore = lastPage === anchorPage
          ? needsRepagination(countVisible(itemsByPage.get(anchorPage) ?? []), cap)
          : lastAllocatedCount(buildPlan(anchorPage, lastPage, cap)) < half;
        if (!needsMore) break;
        const nextPage = lastPage + 1;
        if (totalKnown !== null && nextPage > totalKnown) { confirmedEnd = true; break; }
        const ok = await requestPage(nextPage);
        if (destroyed) return;
        if (!ok || !(await waitForPage(nextPage))) { notify('repagination-failed'); break; }
        const items = itemsByPage.get(nextPage);
        if (!items || items.length === 0) { confirmedEnd = true; break; }
        lastPage = nextPage;
        probed += 1;
      }

      const existing = regionFor(state, anchorPage);
      if (existing) {
        existing.endPage = Math.max(existing.endPage, lastPage);
        existing.planned = true;
      } else if (lastPage > anchorPage) {
        // 只有确实取到了后续页才登记补齐范围；完全失败时保持逐页过滤。
        state.regions.push({ anchorPage, endPage: lastPage, planned: true });
        if (state.regions.length > MAX_REGIONS) state.regions.splice(0, state.regions.length - MAX_REGIONS);
      } else {
        // 无更多结果或探测失败：不登记，退回现有逐页过滤。
        return;
      }
      stateMap.set(key, state);

      const plan = buildPlan(anchorPage, lastPage, cap);
      if (__TIME_FILTER_DEV__) {
        devLog.log({
          reason: 'repagination',
          message: '搜索跨页补齐',
          key: `repagination:search:${anchorPage}:${lastPage}:${plan.total}:${plan.pageCount}:${plan.advancedIds.size}`,
          details: {
            source: 'search',
            page: anchorPage,
            scanned: lastPage,
            visible: plan.total,
            pages: plan.pageCount,
            advanced: plan.advancedIds.size,
          },
        });
      }
      // 扫描后回到用户原始页并恢复 URL；B 站重新请求该页时返回补齐后的切片。
      if (lastPage !== anchorPage) await requestPage(anchorPage);
      restoreUrl(pageParam);
    } catch {
      notify('repagination-failed');
    } finally {
      probing = false;
    }
  };

  return {
    apply(next: FilterConfig) {
      config = { ...next };
    },
    transformVideo(url: string, payload: unknown, next: FilterConfig): unknown | undefined {
      if (destroyed || !isSearchRoute()) return undefined;
      config = { ...next };
      if (!config.enabled || !config.cutoffMinute) return undefined;

      const loc = location();
      if (!loc) return undefined;
      const { page: urlPage, key, pageParam } = readSearchLocation(loc);
      const meta = collectSearchPayload(payload);
      // 只处理可识别的搜索响应；其它视频响应（相关推荐、详情等）直接放行。
      if (meta.items.length === 0) return undefined;
      const page = meta.page ?? urlPage;
      storePayload(page, payload);

      const state = stateMap.get(key);
      const region = state ? regionFor(state, page) : undefined;
      if (region?.planned) {
        const cap = capacity();
        const plan = buildPlan(region.anchorPage, region.endPage, cap);
        const slice = plan.pages.get(page) ?? [];
        const footer = searchFooterSummary(plan);
        footerWriter(documentRef as Document, footer.total, footer.pages);
        // 已生成计划时始终返回该页切片（即使为空），确保已前移的视频不再在后续页重复出现。
        return slicePayload(payload, slice, footer);
      }

      const cap = capacity();
      const currentItems = itemsByPage.get(page) ?? [];
      if (!probing && !region && needsRepagination(countVisible(currentItems), cap)) {
        void runProbe(page, key, pageParam);
      }
      return undefined;
    },
    destroy() {
      destroyed = true;
      if (target) {
        const host = target as Window & { [CONTROLLER_KEY]?: SearchRepaginationHandle };
        if (host[CONTROLLER_KEY] === this) delete host[CONTROLLER_KEY];
      }
    },
  };
}

/** 单例控制器；同页重复创建时复用，避免重复扫描。 */
export function getSearchRepagination(options: SearchRepaginationOptions = {}): SearchRepaginationHandle {
  const target = options.target ?? options.document?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
  if (target) {
    const host = target as Window & { [CONTROLLER_KEY]?: SearchRepaginationHandle };
    if (host[CONTROLLER_KEY]) return host[CONTROLLER_KEY] as SearchRepaginationHandle;
  }
  const handle = createSearchRepagination(options);
  if (target) (target as Window & { [CONTROLLER_KEY]?: SearchRepaginationHandle })[CONTROLLER_KEY] = handle;
  return handle;
}
