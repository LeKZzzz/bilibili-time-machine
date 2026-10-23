import { classifyVideo } from '../core/video';
import type { FavoriteFolderOption, FilterConfig } from '../core/types';
import {
  createFavoriteHomeFillStore, createFavoriteSnapshot, normalizeFavoriteVideos, normalizeSearchCandidates,
  normalizeFavoriteFolders, sampleFavoriteTags, selectHomeFillCandidates, cleanSearchTitle, FAVORITE_MAX_FOLDERS, FAVORITE_MAX_VIDEOS_PER_FOLDER,
  type FavoriteHomeFillConfig, type FavoriteStore, type FavoriteTagScore, type FavoriteTagSnapshot, type FavoriteVideo, type SearchCandidate,
} from '../core/favorite-home-fill';

export interface FavoriteHomeFillState {
  phase: 'idle' | 'updating' | 'searching' | 'ready' | 'filled' | 'empty' | 'error';
  reason?: 'no-folders' | 'paused' | 'no-cutoff' | 'not-home' | 'disabled' | 'no-tags' | 'no-results';
  sourceCount?: number;
  tagCount?: number;
  updatedAt?: number;
  insertedCount?: number;
  errorStage?: 'preferences' | 'search' | 'storage';
  hasCachedPreferences?: boolean;
}

export interface FavoriteHomeFillControllerOptions {
  root?: Document;
  config: FilterConfig & FavoriteHomeFillConfig;
  store?: FavoriteStore;
  fetch?: typeof fetch;
  onNotice?: (reason: 'favorite-fill-failed') => void;
  /** 仅在本轮真正请求补位搜索端点期间为 true，供面板显示搜索提示。 */
  onSearchStateChange?: (searching: boolean) => void;
  onStateChange?: (state: FavoriteHomeFillState) => void;
  rng?: () => number;
  now?: () => number;
}

export interface FavoriteHomeFillController {
  run(): Promise<void>;
  continueFinding(): Promise<void>;
  getState(): FavoriteHomeFillState;
  getTags(): Promise<FavoriteTagScore[]>;
  updateConfig(config: FilterConfig & FavoriteHomeFillConfig): void;
  disconnect(): void;
}

interface FillReplacement {
  clone: Element;
  original: Element;
  cell: HTMLElement | null;
}

function homePage(documentRef: Document): boolean {
  const host = documentRef.defaultView?.location.hostname.toLowerCase();
  const path = documentRef.defaultView?.location.pathname || '/';
  return host === 'www.bilibili.com' && (path === '/' || path === '/index.html' || path === '/index.htm');
}

function bvidOf(element: Element): string | null {
  const value = element.getAttribute('data-bvid') || element.querySelector('[data-bvid]')?.getAttribute('data-bvid') || element.querySelector<HTMLAnchorElement>('a[href*="/video/BV"]')?.href.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
  return value?.trim() || null;
}

function cards(documentRef: Document): Element[] {
  return Array.from(documentRef.querySelectorAll('[data-bvid], .bili-video-card, .video-card')).filter((element) =>
    !element.closest('[data-favorite-home-fill]')
    && Boolean(bvidOf(element))
    && !element.parentElement?.closest('[data-bvid], .bili-video-card, .video-card'));
}

function isUsableTemplate(card: Element): boolean {
  return Boolean(card.querySelector('a[href*="/video/"], img, .bili-video-card__info--tit, .bili-video-card__info--tit__text'));
}

function formatCardDate(value: number | string): string | null {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatCardCount(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && !value.trim()) return '';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return String(value).trim();
  if (numeric >= 100000000) return `${(numeric / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.trunc(numeric));
}

function clearImageAttributes(image: HTMLImageElement): void {
  for (const name of ['srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src', 'data-image']) image.removeAttribute(name);
}

function updateCardImages(clone: Element, candidate: SearchCandidate, title: string): void {
  // 删除模板的 source，避免浏览器继续优先选择模板的 AVIF/WebP 封面。
  clone.querySelectorAll('picture > source, picture source').forEach((source) => source.remove());
  const images = Array.from(clone.querySelectorAll<HTMLImageElement>('img'));
  for (const image of images) {
    clearImageAttributes(image);
    if (candidate.pic) {
      image.setAttribute('src', candidate.pic);
      image.alt = title;
    } else {
      image.removeAttribute('src');
      image.removeAttribute('alt');
    }
  }
}

function updateCardOwner(clone: Element, candidate: SearchCandidate): void {
  const owner = cleanSearchTitle(candidate.author);
  const mid = candidate.mid === undefined || candidate.mid === null ? '' : String(candidate.mid).trim();
  const ownerNodes = Array.from(clone.querySelectorAll<HTMLElement>(
    '.bili-video-card__info--author, .bili-video-card__info--owner, .owner',
  ));
  for (const node of ownerNodes) {
    const link = node.tagName.toLowerCase() === 'a'
      ? node as HTMLAnchorElement
      : node.querySelector<HTMLAnchorElement>('a');
    if (link) link.textContent = owner ?? '';
    else node.textContent = owner ?? '';
    const target = link ?? node;
    if (owner && mid) target.setAttribute('href', `//space.bilibili.com/${encodeURIComponent(mid)}`);
    else target.removeAttribute('href');
    target.removeAttribute('title');
    target.removeAttribute('aria-label');
    if (target !== node) node.removeAttribute('href');
    node.removeAttribute('hidden');
  }
}

function updateCardStats(clone: Element, candidate: SearchCandidate): void {
  const stats = Array.from(clone.querySelectorAll<HTMLElement>('.bili-video-card__stats--text'));
  const values = [candidate.play, candidate.videoReview];
  stats.forEach((node, index) => { node.textContent = formatCardCount(values[index]); });
  const duration = candidate.duration?.trim() ?? '';
  clone.querySelectorAll<HTMLElement>('.bili-video-card__stats__duration, .bili-video-card__stats--duration').forEach((node) => {
    node.textContent = duration;
  });
}


/** 使用页面现有卡片模板克隆，避免建立第二套首页布局。 */
export function cloneHomeFillCard(template: Element, candidate: SearchCandidate, documentRef: Document = template.ownerDocument!): Element | null {
  const clone = template.cloneNode(true) as HTMLElement;
  const bvid = candidate.bvid;
  clone.setAttribute('data-bvid', bvid);
  clone.setAttribute('data-favorite-home-fill', '1');
  clone.removeAttribute('data-time-filter-hidden');
  clone.removeAttribute('data-time-filter-unknown');
  clone.hidden = false;
  clone.querySelectorAll<HTMLElement>('[data-time-filter-hidden], [data-time-filter-unknown]').forEach((node) => {
    node.removeAttribute('data-time-filter-hidden');
    node.removeAttribute('data-time-filter-unknown');
  });
  if (candidate.aid !== undefined && candidate.aid !== null) clone.setAttribute('data-aid', String(candidate.aid));
  if (candidate.pubdate !== undefined && candidate.pubdate !== null) {
    const pubdate = String(candidate.pubdate);
    clone.setAttribute('data-pubdate', pubdate);
    clone.querySelectorAll<HTMLElement>('[data-pubdate]').forEach((node) => node.setAttribute('data-pubdate', pubdate));
  } else {
    clone.removeAttribute('data-pubdate');
    clone.querySelectorAll<HTMLElement>('[data-pubdate]').forEach((node) => node.removeAttribute('data-pubdate'));
  }
  const title = cleanSearchTitle(candidate.title) ?? bvid;
  const sourceTag = (candidate.sourceTag ?? candidate.tags[0] ?? '').trim();
  const fillLabel = sourceTag ? `收藏标签补位：${sourceTag}` : '收藏标签补位';
  clone.setAttribute('aria-label', `${fillLabel}：${title}`);
  clone.querySelectorAll<HTMLElement>('[data-bvid]').forEach((node) => node.setAttribute('data-bvid', bvid));
  const videoLinks = Array.from(clone.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]'));
  const links = videoLinks.length ? videoLinks : (clone.querySelector<HTMLAnchorElement>('a') ? [clone.querySelector<HTMLAnchorElement>('a') as HTMLAnchorElement] : []);
  for (const link of links) {
    link.href = `/video/${bvid}`;
    link.setAttribute('aria-label', `${fillLabel}：${title}`);
  }
  updateCardImages(clone, candidate, title);
  const titleNode = clone.querySelector<HTMLElement>('.bili-video-card__info--tit__text, .bili-video-card__info--tit');
  if (titleNode) {
    const textNode = titleNode.querySelector<HTMLElement>('.bili-video-card__info--tit__text, span, a') ?? titleNode;
    textNode.textContent = title;
    titleNode.setAttribute('title', title);
  }
  const dateNode = clone.querySelector<HTMLElement>('.bili-video-card__info--date');
  if (dateNode) {
    const formatted = candidate.pubdate === undefined || candidate.pubdate === null ? null : formatCardDate(candidate.pubdate);
    dateNode.textContent = formatted ? `· ${formatted}` : '';
  }
  updateCardOwner(clone, candidate);
  updateCardStats(clone, candidate);
  let marker = clone.querySelector<HTMLElement>('[data-favorite-home-fill-label]');
  if (!marker) { marker = documentRef.createElement('span'); marker.setAttribute('data-favorite-home-fill-label', '1'); marker.style.cssText = 'font-size:11px;color:#00aeec;'; clone.appendChild(marker); }
  marker.textContent = fillLabel;
  marker.setAttribute('aria-label', sourceTag ? `根据收藏标签“${sourceTag}”添加的补位视频` : '收藏标签补位');
  if (sourceTag) marker.title = `根据收藏标签“${sourceTag}”添加`;
  else marker.removeAttribute('title');
  clone.removeAttribute('hidden');
  return clone;
}

function defaultFetch(target: Document): typeof fetch | undefined { return target.defaultView?.fetch?.bind(target.defaultView); }

async function jsonFetch(request: typeof fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await request(url, { credentials: 'include', signal });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  const payload = await response.json() as unknown;
  if (payload && typeof payload === 'object') {
    const code = (payload as Record<string, unknown>).code;
    if (code !== undefined && code !== 0) throw new Error(`api request failed: ${String(code)}`);
  }
  signal?.throwIfAborted();
  return payload;
}

function readTagName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const name = item.tag_name ?? item.name ?? item.tag;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** 从视频详情响应中提取 B 站返回的内容标签。 */
function readVideoTags(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  const view = data.View && typeof data.View === 'object' ? data.View as Record<string, unknown> : data;
  const sources = [data.Tags, data.tags, view.Tags, view.tags];
  const tags: string[] = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const tag = readTagName(item);
      if (tag && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** 收藏资源通常只返回 bvid；缺少标签时用有界并发读取视频详情标签。 */
async function enrichFavoriteVideos(request: typeof fetch, videos: readonly FavoriteVideo[], signal?: AbortSignal): Promise<FavoriteVideo[]> {
  const output = videos.map((video) => ({ ...video, tags: [...video.tags] }));
  const pending = output.map((video, index) => ({ video, index })).filter(({ video }) => video.tags.length === 0);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      signal?.throwIfAborted();
      const item = pending[cursor++];
      if (!item) return;
      try {
        const payload = await jsonFetch(request, `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(item.video.bvid)}`, signal);
        const tags = readVideoTags(payload);
        if (tags.length) output[item.index] = { ...item.video, tags };
      } catch {
        signal?.throwIfAborted();
        // 单个视频标签不可用时保留其它收藏；若全部不可用由调用方安全停止本轮补位。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()));
  if (pending.length > 0 && !output.some((video) => video.tags.length > 0)) throw new Error('favorite tags unavailable');
  return output;
}

async function readFavoriteFolder(request: typeof fetch, folder: string, limit: number, signal?: AbortSignal): Promise<FavoriteVideo[]> {
  const target = Math.min(200, Math.max(1, Math.floor(limit)));
  const pageSize = Math.min(40, target);
  const pages = Math.ceil(target / pageSize);
  const videos: FavoriteVideo[] = [];
  for (let page = 1; page <= pages && videos.length < target; page += 1) {
    const params = new URLSearchParams({
      media_id: folder,
      pn: String(page),
      ps: String(pageSize),
      keyword: '',
      order: 'mtime',
      type: '0',
      tid: '0',
      platform: 'web',
      web_location: '333.1387',
    });
    const payload = await jsonFetch(request, `https://api.bilibili.com/x/v3/fav/resource/list?${params.toString()}`, signal);
    assertList(payload, ['medias', 'archives', 'list', 'items', 'records']);
    const pageVideos = await enrichFavoriteVideos(request, normalizeFavoriteVideos(payload, folder, target - videos.length), signal);
    signal?.throwIfAborted();
    videos.push(...pageVideos);
    const data = payload && typeof payload === 'object' && (payload as Record<string, unknown>).data;
    const hasMore = Boolean(data && typeof data === 'object' && (data as Record<string, unknown>).has_more);
    if (!hasMore || pageVideos.length === 0) break;
  }
  return videos.slice(0, target);
}

function assertList(payload: unknown, keys: string[]): void {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  if (!Array.isArray(payload) && !Array.isArray(root.data) && !keys.some((key) => Array.isArray(data[key]))) {
    throw new Error('unrecognized list response');
  }
}

function readUid(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>; const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  const value = data.mid ?? data.uid ?? data.userid;
  return value === undefined || value === null || String(value) === '' ? null : String(value);
}

export async function resolveBilibiliUid(request: typeof fetch): Promise<string | null> {
  try { return readUid(await jsonFetch(request, 'https://api.bilibili.com/x/web-interface/nav')); } catch { return null; }
}

const FAVORITE_FOLDER_PAGE_SIZE = 20;

/** 列表接口的 data 容器；分页元数据与列表字段都从这里读取。 */
function folderListData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  return root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;
}

/** 沿用核心规范化器的字段优先级，读取当前页的原始条数。 */
function rawFolderItems(payload: unknown): unknown[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (Array.isArray(root.data)) return root.data;
  const data = folderListData(payload);
  for (const value of [data.list, data.folders, data.items, data.created, payload]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readFolderCount(payload: unknown): number | null {
  const value = folderListData(payload).count;
  const count = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

function readFolderHasMore(payload: unknown): boolean | null {
  const value = folderListData(payload).has_more;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  return null;
}

/** 分页读取 created/list；按 has_more/count/短页结束，任一分页失败或关闭功能都会抛出。 */
async function loadFavoriteFolderPages(
  request: typeof fetch,
  params: URLSearchParams,
  isEnabled: () => boolean,
): Promise<FavoriteFolderOption[]> {
  const folders = new Map<string, FavoriteFolderOption>();
  for (let page = 1; ; page += 1) {
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    const pageParams = new URLSearchParams(params);
    pageParams.set('pn', String(page));
    pageParams.set('ps', String(FAVORITE_FOLDER_PAGE_SIZE));
    const payload = await jsonFetch(request, `https://api.bilibili.com/x/v3/fav/folder/created/list?${pageParams.toString()}`);
    assertList(payload, ['list', 'folders', 'items', 'created']);
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    const items = rawFolderItems(payload);
    const before = folders.size;
    for (const folder of normalizeFavoriteFolders(payload)) {
      if (!folders.has(folder.id)) folders.set(folder.id, folder);
    }
    const hasMore = readFolderHasMore(payload);
    const count = readFolderCount(payload);
    if (hasMore === false || items.length === 0 || folders.size === before) {
      if ((count !== null && folders.size < count) || (hasMore === true && folders.size === before)) {
        throw new Error('incomplete favorite folder list');
      }
      break;
    }
    if (hasMore !== true) {
      // 没有 has_more 时优先用 count 判断是否取全，其次才用短页作为结束信号。
      if (count !== null && count > 0 ? folders.size >= count : items.length < FAVORITE_FOLDER_PAGE_SIZE) break;
    }
  }
  return [...folders.values()];
}

/**
 * 读取当前登录账号创建的全部收藏夹。
 * uid 已知时可直接传入以避免重复请求 nav；enabled 用于在关闭功能后阻止继续分页。
 */
export async function loadFavoriteFolders(
  request: typeof fetch,
  uid?: string | null,
  isEnabled: () => boolean = () => true,
): Promise<FavoriteFolderOption[]> {
  if (!isEnabled()) throw new Error('favorite folder loading disabled');
  const resolvedUid = uid ?? await resolveBilibiliUid(request);
  if (!resolvedUid) throw new Error('uid unavailable');
  if (!isEnabled()) throw new Error('favorite folder loading disabled');
  const params = new URLSearchParams({ up_mid: resolvedUid, type: '0', web_location: '333.1387' });
  try {
    const payload = await jsonFetch(request, `https://api.bilibili.com/x/v3/fav/folder/created/list-all?${params.toString()}`);
    assertList(payload, ['list', 'folders', 'items', 'created']);
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    const folders = normalizeFavoriteFolders(payload);
    const count = readFolderCount(payload);
    // list-all 明确给出的数量少于 count 时不能当作完整列表，改走分页回退。
    if (folders.length > 0 && (count === null || folders.length >= count)) return folders;
  } catch {
    // list-all 不可用时回退到分页接口；分页接口负责提供完整列表或抛出错误。
  }
  if (!isEnabled()) throw new Error('favorite folder loading disabled');
  return loadFavoriteFolderPages(request, params, isEnabled);
}

function selectedFolders(config: FavoriteHomeFillConfig): string[] {
  const folders = (config.favoriteFolderIds ?? []).map(String).filter(Boolean);
  const limit = Math.min(FAVORITE_MAX_FOLDERS, Math.max(1, config.favoriteFolderLimit ?? 3));
  // 旧配置超出上限时等待用户调整，不只读取其中一部分。
  return folders.length <= limit ? folders : [];
}

function selectionKey(config: FavoriteHomeFillConfig): string {
  return `${selectedFolders(config).join(',')}|limit=${config.favoriteFolderLimit ?? 3}|videos=${config.favoriteVideoLimit ?? 50}`;
}

export function createFavoriteHomeFillController(options: FavoriteHomeFillControllerOptions): FavoriteHomeFillController {
  const documentRef = options.root ?? (typeof document !== 'undefined' ? document : undefined);
  if (!documentRef) throw new Error('A document root is required');
  let config = { ...options.config };
  let disposed = false;
  let running: Promise<void> | null = null;
  let active: AbortController | null = null;
  let loadingPreferences = false;
  let revision = 0;
  let lastAttempt: string | null = null;
  let lastRefreshRequest: number | null = null;
  let selectionChanged = false;
  let scrollRound = 0;
  let queuedScroll = false;
  let knownUid: string | null = null;
  let knownSnapshot: FavoriteTagSnapshot | null = null;
  let state: FavoriteHomeFillState = { phase: 'idle' };
  const request = options.fetch ?? defaultFetch(documentRef);
  const store = options.store ?? createFavoriteHomeFillStore();
  const now = options.now ?? (() => Date.now());
  const rng = options.rng ?? Math.random;
  const replacements = new Map<Element, FillReplacement>();
  const cardIds = new WeakMap<Element, number>();
  let nextCardId = 0;
  const stateKey = (): string => `${selectionKey(config)}|${config.enabled}|${config.cutoffMinute}|${config.favoriteHomeFillEnabled}|${config.favoriteRefreshRequestedAt ?? ''}`;
  const attemptKey = (): string => `${stateKey()}|${scrollRound}|${cards(documentRef).map((card) => {
    if (!cardIds.has(card)) cardIds.set(card, ++nextCardId);
    return `${cardIds.get(card)}:${bvidOf(card)}:${card.getAttribute('data-pubdate')}:${isHidden(card)}`;
  }).join('|')}`;
  const publish = (next: FavoriteHomeFillState): void => {
    const folders = selectedFolders(config);
    const videoLimit = Math.min(FAVORITE_MAX_VIDEOS_PER_FOLDER, Math.max(1, Math.floor(config.favoriteVideoLimit ?? 50)));
    const hasCachedPreferences = Boolean(knownSnapshot
      && knownSnapshot.videoLimit === videoLimit
      && knownSnapshot.folders.length === folders.length
      && folders.every((folder) => knownSnapshot!.folders.includes(folder))
      && knownSnapshot.tags.some(({ tag, score }) => tag.trim() && Number.isFinite(score) && score > 0));
    state = { sourceCount: knownSnapshot?.folders.length, tagCount: knownSnapshot?.tags.length,
      updatedAt: knownSnapshot?.updatedAt, hasCachedPreferences, ...next };
    options.onStateChange?.({ ...state });
  };
  const idleReason = (): FavoriteHomeFillState['reason'] => {
    if (config.favoriteHomeFillEnabled !== true) return 'disabled';
    if (!selectedFolders(config).length) return 'no-folders';
    if (!config.cutoffMinute) return 'no-cutoff';
    if (!config.enabled) return 'paused';
    if (!homePage(documentRef)) return 'not-home';
    return undefined;
  };
  let searchActive = false;
  const setSearchActive = (value: boolean): void => {
    if (searchActive === value) return;
    searchActive = value;
    options.onSearchStateChange?.(value);
  };
  const isHidden = (card: Element): boolean => (card as HTMLElement).hidden || card.getAttribute('data-time-filter-hidden') === '1';
  const existingBvids = (): Set<string> => new Set(Array.from(documentRef.querySelectorAll('[data-bvid], .bili-video-card, .video-card'))
    .map(bvidOf).filter((value): value is string => Boolean(value)));
  const restore = (replacement: FillReplacement, showOriginal = false): void => {
    const { clone, original, cell } = replacement;
    if (clone.parentNode) clone.replaceWith(original);
    (original as HTMLElement).hidden = !showOriginal;
    if (showOriginal) original.removeAttribute('data-time-filter-hidden');
    else original.setAttribute('data-time-filter-hidden', '1');
    if (cell) {
      cell.hidden = !showOriginal;
      if (showOriginal) cell.removeAttribute('data-time-filter-hidden');
      else cell.setAttribute('data-time-filter-hidden', '1');
    }
    replacements.delete(clone);
  };
  const restoreAll = (showOriginal = false): void => {
    for (const replacement of replacements.values()) restore(replacement, showOriginal);
  };
  const run = async (): Promise<void> => {
    if (disposed) return;
    if (running) {
      const pending = running;
      await pending;
      if (running && running !== pending) await running;
      return;
    }
    const reason = idleReason();
    const explicitRefresh = config.favoriteRefreshRequestedAt != null && config.favoriteRefreshRequestedAt !== lastRefreshRequest;
    if (reason === 'disabled' || reason === 'no-folders' || !request || (reason && !explicitRefresh && !selectionChanged)) {
      publish({ phase: 'idle', reason });
      return;
    }
    const runAttempt = attemptKey();
    if (lastAttempt === runAttempt) return;
    lastAttempt = runAttempt;
    const controller = new AbortController();
    active = controller;
    loadingPreferences = true;
    const runRevision = revision;
    const runConfig = { ...config };
    const check = (): void => {
      controller.signal.throwIfAborted();
      if (disposed || revision !== runRevision) throw new DOMException('Task cancelled', 'AbortError');
    };
    let errorStage: FavoriteHomeFillState['errorStage'] = 'preferences';
    let claimUid: string | null = null;
    const owner = crypto.randomUUID();
    let claimed: string[] = [];
    const inserted: FillReplacement[] = [];
    running = (async () => {
      try {
        const folders = selectedFolders(runConfig);
        const videoLimit = Math.min(FAVORITE_MAX_VIDEOS_PER_FOLDER, Math.max(1, Math.floor(runConfig.favoriteVideoLimit ?? 50)));
        const uid = readUid(await jsonFetch(request, 'https://api.bilibili.com/x/web-interface/nav', controller.signal));
        check();
        if (!uid) throw new Error('uid unavailable');
        knownUid = uid;
        const cached = await store.getSnapshot(uid);
        check();
        knownSnapshot = cached;
        const matches = cached?.videoLimit === videoLimit && cached.folders.length === folders.length && folders.every((folder) => cached.folders.includes(folder));
        const refreshNeeded = explicitRefresh && (runConfig.favoriteRefreshRequestedAt! > (cached?.updatedAt ?? 0));
        let snapshot: FavoriteTagSnapshot | null = matches && !refreshNeeded ? {
          ...cached!, nextSearchPages: { ...cached!.nextSearchPages },
          recentTagRounds: cached!.recentTagRounds?.map((round) => [...round]),
        } : null;
        if (!snapshot) {
          publish({ phase: 'updating' });
          const videos: FavoriteVideo[] = [];
          for (const folder of folders) {
            check();
            videos.push(...await readFavoriteFolder(request, folder, videoLimit, controller.signal));
            check();
          }
          snapshot = { ...createFavoriteSnapshot(uid, folders, videos, now()), videoLimit };
          const tags = new Set(snapshot.tags.map(({ tag }) => tag));
          snapshot.nextSearchPages = Object.fromEntries(Object.entries(cached?.nextSearchPages ?? {}).filter(([tag]) => tags.has(tag)));
          snapshot.recentTagRounds = (cached?.recentTagRounds ?? []).map((round) => round.filter((tag) => tags.has(tag))).filter((round) => round.length).slice(-2);
          check();
          await store.putSnapshot(snapshot);
          check();
        }
        knownSnapshot = snapshot;
        lastRefreshRequest = runConfig.favoriteRefreshRequestedAt ?? null;
        selectionChanged = false;
        // 收藏读取不依赖截止时间；完成后才固定本轮补位使用的最新时间。
        runConfig.cutoffMinute = config.cutoffMinute;
        loadingPreferences = false;
        publish({ phase: 'ready', reason: idleReason() });
        if (idleReason()) return;
        const currentCards = cards(documentRef);
        const hidden = currentCards.filter(isHidden).map((card) => ({ card, bvid: bvidOf(card) }));
        const need = hidden.length;
        if (!need) return;
        const roundTags = sampleFavoriteTags(snapshot.tags, snapshot.recentTagRounds, rng);
        if (!roundTags.length) { publish({ phase: 'empty', reason: 'no-tags' }); return; }
        let candidates = await store.getCandidates(uid);
        check();
        const history = await store.getHistory(uid);
        check();
        const historyIds = history.map(({ bvid }) => bvid);
        const eligible = (): SearchCandidate[] => {
          const blocked = new Set([...existingBvids(), ...historyIds]);
          const merged = new Map<string, SearchCandidate>();
          for (const candidate of candidates) {
            if (blocked.has(candidate.bvid) || !classifyVideo(candidate, runConfig.cutoffMinute, { enabled: true }).visible
              || !roundTags.some(({ tag }) => candidate.tags.includes(tag))) continue;
            const previous = merged.get(candidate.bvid);
            merged.set(candidate.bvid, previous ? { ...previous, tags: [...new Set([...previous.tags, ...candidate.tags])] } : candidate);
          }
          return [...merged.values()];
        };
        // 二分匹配为每个来源分配不同 BV，避免共享候选被重复计作来源覆盖。
        const coverage = (pool: SearchCandidate[]): Set<string> => {
          const assigned = new Map<string, string>();
          const visit = (tag: string, seen: Set<string>): boolean => {
            for (const candidate of pool) {
              if (!candidate.tags.includes(tag) || seen.has(candidate.bvid)) continue;
              seen.add(candidate.bvid);
              const previous = assigned.get(candidate.bvid);
              if (!previous || visit(previous, seen)) { assigned.set(candidate.bvid, tag); return true; }
            }
            return false;
          };
          for (const { tag } of roundTags.slice(0, need)) visit(tag, new Set());
          return new Set(assigned.values());
        };
        const pending = [...roundTags];
        const searched = new Set<string>();
        const used = new Set<string>();
        errorStage = 'search';
        for (let count = 0; pending.length && count < 5;) {
          const pool = eligible();
          const covered = coverage(pool);
          if (pool.length >= need && covered.size >= Math.min(need, roundTags.length)) break;
          const score = pending.shift()!;
          if (pool.length >= need && (searched.has(score.tag) || covered.has(score.tag))) continue;
          check();
          const page = snapshot.nextSearchPages?.[score.tag] ?? (candidates.some((candidate) => candidate.tags.includes(score.tag)) ? 2 : 1);
          setSearchActive(true);
          publish({ phase: 'searching' });
          const payload = await jsonFetch(request, `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(score.tag)}&page=${page}`, controller.signal);
          check();
          assertList(payload, ['result', 'results', 'list', 'items']);
          const fetched = normalizeSearchCandidates(payload, [score.tag], now());
          await store.putCandidates(uid, fetched);
          check();
          candidates = [...candidates, ...fetched];
          const data = folderListData(payload);
          const totalPages = Number(data.numPages);
          const nextPage = fetched.length === 0 || (Number.isFinite(totalPages) && totalPages > 0 && page >= totalPages) ? 1 : page + 1;
          snapshot.nextSearchPages = { ...snapshot.nextSearchPages, [score.tag]: nextPage };
          searched.add(score.tag);
          used.add(score.tag);
          count += 1;
          if (nextPage !== 1) pending.push(score);
        }
        setSearchActive(false);
        check();
        const selected = selectHomeFillCandidates(eligible(), roundTags, need, runConfig.cutoffMinute, [], [], undefined, rng);
        const template = cards(documentRef).find(isUsableTemplate);
        errorStage = 'storage';
        claimUid = uid;
        if (template && selected.length) {
          claimed = await store.claimHistory(uid, selected.map(({ bvid }) => ({ bvid, pushedAt: now() })), owner);
          check();
          let targetIndex = 0;
          for (const candidate of selected) {
            if (!claimed.includes(candidate.bvid) || existingBvids().has(candidate.bvid)) continue;
            let target = hidden[targetIndex++];
            while (target && (!target.card.isConnected || bvidOf(target.card) !== target.bvid || !isHidden(target.card))) target = hidden[targetIndex++];
            if (!target) break;
            check();
            const clone = cloneHomeFillCard(template, candidate, documentRef);
            if (!clone) continue;
            const cell = target.card.closest('.col_3, .col_xs_1_5, .col_md_2, .col_xl_1_7') as HTMLElement | null;
            const replacement = { clone, original: target.card, cell };
            target.card.replaceWith(clone);
            replacements.set(clone, replacement);
            inserted.push(replacement);
            if (cell) { cell.hidden = false; cell.removeAttribute('data-time-filter-hidden'); }
            if (candidate.sourceTag) used.add(candidate.sourceTag);
          }
          const displayed = new Set(inserted.map(({ clone }) => bvidOf(clone)));
          await store.releaseHistory(uid, claimed.filter((bvid) => !displayed.has(bvid)), owner);
          check();
          claimed = claimed.filter((bvid) => displayed.has(bvid));
        }
        if (used.size) snapshot.recentTagRounds = [...(snapshot.recentTagRounds ?? []), [...used]].slice(-2);
        await store.putSnapshot(snapshot);
        check();
        knownSnapshot = snapshot;
        publish(inserted.length ? { phase: 'filled', insertedCount: inserted.length } : { phase: 'empty', reason: 'no-results', insertedCount: 0 });
        // 自己的插卡不会启动下一轮；外部新增卡片由下一次 DOM 批次处理。
        const initialCards = new Set(currentCards);
        lastAttempt = cards(documentRef).some((card) => !initialCards.has(card) && isHidden(card)) ? null : attemptKey();
      } catch {
        for (const replacement of inserted) restore(replacement, !config.enabled || !config.cutoffMinute);
        if (claimUid && claimed.length) {
          try { await store.releaseHistory(claimUid, claimed, owner); }
          catch { errorStage = 'storage'; }
        }
        setSearchActive(false);
        if (!controller.signal.aborted && !disposed && runRevision === revision) {
          publish({ phase: 'error', errorStage });
          options.onNotice?.('favorite-fill-failed');
        }
      } finally {
        setSearchActive(false);
        loadingPreferences = false;
        running = null;
        if (active === controller) active = null;
        if (!disposed && (runRevision !== revision || queuedScroll || lastAttempt === null)) {
          if (queuedScroll) { scrollRound += 1; queuedScroll = false; }
          void run();
        }
      }
    })();
    return running;
  };
  const continueFinding = async (): Promise<void> => {
    if (running) return running;
    scrollRound += 1;
    return run();
  };
  const view = documentRef.defaultView;
  let lastScrollY = view?.scrollY ?? 0;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollAttempt: string | null = null;
  const clearScrollRetry = (): void => {
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    scrollTimer = null;
    scrollAttempt = null;
  };
  const onScroll = (): void => {
    const position = view?.scrollY ?? 0;
    const downward = position > lastScrollY;
    lastScrollY = position;
    if (!downward || disposed || idleReason()) { clearScrollRetry(); return; }
    if (scrollTimer === null) scrollAttempt = attemptKey();
    else clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const sameBatch = scrollAttempt === attemptKey();
      clearScrollRetry();
      if (!sameBatch || !cards(documentRef).some(isHidden)) return;
      if (running) queuedScroll = true;
      else void continueFinding();
    }, 200);
  };
  view?.addEventListener('scroll', onScroll, { passive: true });
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
    if (!running && attemptKey() !== lastAttempt) void run();
  }) : null;
  observer?.observe(documentRef, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'data-time-filter-hidden', 'data-time-filter-unknown', 'data-bvid', 'data-pubdate', 'href'] });
  void run();
  return {
    run,
    continueFinding,
    getState: () => ({ ...state }),
    async getTags() {
      if (disposed || !request) return [];
      const version = revision;
      if (running) await running;
      if (disposed || version !== revision) return [];
      const uid = knownUid ?? await resolveBilibiliUid(request);
      if (!uid || disposed || version !== revision) return [];
      const snapshot = await store.getSnapshot(uid);
      if (disposed || version !== revision) return [];
      return snapshot?.tags ?? [];
    },
    updateConfig(next) {
      const previous = config;
      const changedSelection = selectionKey(previous) !== selectionKey(next);
      const changed = stateKey() !== `${selectionKey(next)}|${next.enabled}|${next.cutoffMinute}|${next.favoriteHomeFillEnabled}|${next.favoriteRefreshRequestedAt ?? ''}`;
      config = { ...next };
      if (changed) {
        const keepPreferenceRead = loadingPreferences && !changedSelection
          && previous.enabled === next.enabled
          && previous.favoriteHomeFillEnabled === next.favoriteHomeFillEnabled
          && previous.favoriteRefreshRequestedAt === next.favoriteRefreshRequestedAt;
        if (!keepPreferenceRead) {
          revision += 1;
          active?.abort();
        }
        lastAttempt = keepPreferenceRead ? attemptKey() : null;
        selectionChanged ||= changedSelection;
        clearScrollRetry();
        queuedScroll = false;
        setSearchActive(false);
        const advancing = previous.cutoffMinute && next.cutoffMinute && next.cutoffMinute >= previous.cutoffMinute;
        if (!advancing || changedSelection || previous.enabled !== next.enabled || previous.favoriteHomeFillEnabled !== next.favoriteHomeFillEnabled) {
          restoreAll(!next.enabled || !next.cutoffMinute);
        }
      }
      if (idleReason() && !(loadingPreferences && active && !active.signal.aborted)) {
        publish({ phase: 'idle', reason: idleReason() });
      }
      void run();
    },
    disconnect() {
      disposed = true;
      revision += 1;
      active?.abort();
      clearScrollRetry();
      view?.removeEventListener('scroll', onScroll);
      setSearchActive(false);
      observer?.disconnect();
      restoreAll();
    },
  };
}
