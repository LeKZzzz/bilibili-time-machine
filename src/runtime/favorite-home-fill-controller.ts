import type { FavoriteFolderOption, FilterConfig } from '../core/types';
import {
  createFavoriteHomeFillStore, createFavoriteSnapshot, normalizeFavoriteVideos, normalizeSearchCandidates,
  normalizeFavoriteFolders, selectHomeFillCandidates, cleanSearchTitle, FAVORITE_MAX_FOLDERS, FAVORITE_MAX_VIDEOS_PER_FOLDER,
  type FavoriteHomeFillConfig, type FavoriteStore, type FavoriteTagScore, type FavoriteTagSnapshot, type FavoriteVideo, type SearchCandidate,
} from '../core/favorite-home-fill';

export interface FavoriteHomeFillControllerOptions {
  root?: Document;
  config: FilterConfig & FavoriteHomeFillConfig;
  store?: FavoriteStore;
  fetch?: typeof fetch;
  onNotice?: (reason: 'favorite-fill-failed') => void;
  /** 仅在本轮真正请求补位搜索端点期间为 true，供面板显示搜索提示。 */
  onSearchStateChange?: (searching: boolean) => void;
  now?: () => number;
}

export interface FavoriteHomeFillController {
  run(): Promise<void>;
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

async function jsonFetch(request: typeof fetch, url: string): Promise<unknown> {
  const response = await request(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  const payload = await response.json() as unknown;
  if (payload && typeof payload === 'object') {
    const code = (payload as Record<string, unknown>).code;
    if (code !== undefined && code !== 0) throw new Error(`api request failed: ${String(code)}`);
  }
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
async function enrichFavoriteVideos(request: typeof fetch, videos: readonly FavoriteVideo[]): Promise<FavoriteVideo[]> {
  const output = videos.map((video) => ({ ...video, tags: [...video.tags] }));
  const pending = output.map((video, index) => ({ video, index })).filter(({ video }) => video.tags.length === 0);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      if (!item) return;
      try {
        const payload = await jsonFetch(request, `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(item.video.bvid)}`);
        const tags = readVideoTags(payload);
        if (tags.length) output[item.index] = { ...item.video, tags };
      } catch {
        // 单个视频标签不可用时保留其它收藏；若全部不可用由调用方安全停止本轮补位。
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, () => worker()));
  if (pending.length > 0 && !output.some((video) => video.tags.length > 0)) throw new Error('favorite tags unavailable');
  return output;
}

async function readFavoriteFolder(request: typeof fetch, folder: string, limit: number): Promise<FavoriteVideo[]> {
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
    const payload = await jsonFetch(request, `https://api.bilibili.com/x/v3/fav/resource/list?${params.toString()}`);
    const pageVideos = await enrichFavoriteVideos(request, normalizeFavoriteVideos(payload, folder, pageSize));
    videos.push(...pageVideos);
    const data = payload && typeof payload === 'object' && (payload as Record<string, unknown>).data;
    const hasMore = Boolean(data && typeof data === 'object' && (data as Record<string, unknown>).has_more);
    if (!hasMore || pageVideos.length === 0) break;
  }
  return videos.slice(0, target);
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
  let config = { ...options.config }; let disposed = false; let running: Promise<void> | null = null;
  let lastRefreshRequest = config.favoriteRefreshRequestedAt ?? null;
  let lastAttempt: string | null = null;
  let scrollRound = 0;
  const cardIds = new WeakMap<Element, number>();
  let nextCardId = 0;
  const stateKey = (): string => `${selectionKey(config)}|enabled=${config.enabled}|cutoff=${config.cutoffMinute}|fill=${config.favoriteHomeFillEnabled}|refresh=${config.favoriteRefreshRequestedAt ?? ''}`;
  const attemptKey = (): string => `${stateKey()}|scroll=${scrollRound}|${cards(documentRef).map((card) => {
    if (!cardIds.has(card)) cardIds.set(card, ++nextCardId);
    return `${cardIds.get(card)}:${bvidOf(card)}:${card.getAttribute('data-pubdate')}:${(card as HTMLElement).hidden || card.getAttribute('data-time-filter-hidden') === '1'}`;
  }).join('|')}`;
  const replacements = new Map<Element, FillReplacement>();
  const request = options.fetch ?? defaultFetch(documentRef); const store = options.store ?? createFavoriteHomeFillStore(); const now = options.now ?? (() => Date.now());
  const notify = () => options.onNotice?.('favorite-fill-failed');
  let searchActive = false;
  /** 搜索提示只随实际搜索端点请求切换，重复设置同一状态不通知。 */
  const setSearchActive = (value: boolean): void => {
    if (searchActive === value) return;
    searchActive = value;
    options.onSearchStateChange?.(value);
  };
  const currentVideoLimit = (): number => {
    const value = config.favoriteVideoLimit ?? 50;
    const limit = typeof value === 'number' && Number.isFinite(value) ? value : 50;
    return Math.min(FAVORITE_MAX_VIDEOS_PER_FOLDER, Math.max(1, Math.floor(limit)));
  };
  /** 选择或每夹视频上限变化后，旧快照不能继续沿用。 */
  const snapshotMatches = (cached: FavoriteTagSnapshot | null, folders: string[], videoLimit: number): boolean => {
    if (!cached || cached.videoLimit !== videoLimit) return false;
    if (cached.folders.length !== folders.length) return false;
    const cachedFolders = new Set(cached.folders);
    return folders.every((folder) => cachedFolders.has(folder));
  };
  const loadSnapshot = async (): Promise<{ uid: string; snapshot: FavoriteTagSnapshot }> => {
    const folders = selectedFolders(config);
    const videoLimit = currentVideoLimit();
    if (!folders.length || !request) throw new Error('favorite folders unavailable');
    const uid = await resolveBilibiliUid(request); if (!uid) throw new Error('uid unavailable');
    const refreshRequested = (config.favoriteRefreshRequestedAt ?? null) !== lastRefreshRequest;
    const cached = await store.getSnapshot(uid);
    let snapshot = refreshRequested || !snapshotMatches(cached, folders, videoLimit) ? null : cached;
    if (refreshRequested) lastRefreshRequest = config.favoriteRefreshRequestedAt ?? null;
    if (!snapshot) {
      const videos: FavoriteVideo[] = [];
      for (const folder of folders) videos.push(...await readFavoriteFolder(request, folder, videoLimit));
      snapshot = { ...createFavoriteSnapshot(uid, folders, videos, now()), videoLimit };
      if (cached?.nextSearchPages) snapshot.nextSearchPages = Object.fromEntries(snapshot.tags
        .filter(({ tag }) => cached.nextSearchPages?.[tag] !== undefined)
        .map(({ tag }) => [tag, cached.nextSearchPages![tag]]));
      if (snapshot.tags.slice(0, 5).some(({ tag }) => tag === cached?.nextSourceTag)) snapshot.nextSourceTag = cached!.nextSourceTag;
      await store.putSnapshot(snapshot);
    }
    return { uid, snapshot };
  };
  const restoreFillCards = (showOriginal = false): void => {
    for (const { clone, original, cell } of replacements.values()) {
      if (clone.parentNode) {
        if (cell && clone.parentNode === cell) cell.replaceChild(original, clone);
        else clone.replaceWith(original);
      }
      (original as HTMLElement).hidden = !showOriginal;
      if (showOriginal) original.removeAttribute('data-time-filter-hidden');
      else original.setAttribute('data-time-filter-hidden', '1');
      if (cell) {
        cell.hidden = !showOriginal;
        if (showOriginal) cell.removeAttribute('data-time-filter-hidden');
        else cell.setAttribute('data-time-filter-hidden', '1');
      }
    }
    replacements.clear();
  };
  const run = async (): Promise<void> => {
    if (disposed || !homePage(documentRef) || !config.enabled || !config.cutoffMinute || config.favoriteHomeFillEnabled !== true) return;
    const folders = selectedFolders(config); if (!folders.length || !request) return;
    if (running) return running;
    const runAttempt = attemptKey();
    if (runAttempt === lastAttempt) return;
    lastAttempt = runAttempt;
    const runState = stateKey();
    running = (async () => {
      try {
        const loaded = await loadSnapshot();
        const { uid, snapshot } = loaded;
        if (disposed || stateKey() !== runState || !config.enabled || !config.cutoffMinute || config.favoriteHomeFillEnabled !== true) return;
        let candidates = await store.getCandidates(uid); const history = await store.getHistory(uid);
        const currentCards = cards(documentRef); const existing = new Set(currentCards.map(bvidOf).filter((value): value is string => Boolean(value)));
        const hidden = currentCards.filter((card) => (card as HTMLElement).hidden || card.getAttribute('data-time-filter-hidden') === '1');
        const hiddenBvids = hidden.map(bvidOf);
        const need = hidden.length; if (!need) return;
        const topTags = snapshot.tags.slice(0, 5);
        const start = Math.max(0, topTags.findIndex(({ tag }) => tag === snapshot.nextSourceTag));
        const searchTags = [...topTags.slice(start), ...topTags.slice(0, start)];
        const preferredTags = searchTags.slice(0, Math.min(need, searchTags.length));
        const historyIds = history.map((item) => item.bvid);
        const choose = (): SearchCandidate[] => selectHomeFillCandidates(candidates, topTags, need, config.cutoffMinute, existing, historyIds, undefined, searchTags[0]?.tag);
        const enough = (selected: SearchCandidate[]): boolean => selected.length >= need
          && preferredTags.every(({ tag }) => selected.some((candidate) => candidate.sourceTag === tag));
        if (!enough(choose())) {
          let order = 0;
          const pendingTags = [...searchTags];
          const searchedTags = new Set<string>();
          while (pendingTags.length && order < 5) {
            const score = pendingTags.shift()!;
            const available = choose();
            if (enough(available)) break;
            // 数量足够时只补缺席标签的候选，不因第一个标签已填满而跳过其它来源。
            if (available.length >= need && (searchedTags.has(score.tag) || available.some((candidate) => candidate.sourceTag === score.tag))) continue;
            if (disposed || stateKey() !== runState) return;
            // 旧缓存已包含该标签时从第二页继续，避免反复拉取已推送完的第一页。
            const page = snapshot.nextSearchPages?.[score.tag] ?? (candidates.some((candidate) => candidate.tags.includes(score.tag)) ? 2 : 1);
            // 仅在实际发出搜索请求前通知一次；整轮搜索结束后统一关闭。
            setSearchActive(true);
            const payload = await jsonFetch(request, `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(score.tag)}&page=${page}`);
            const fetched = normalizeSearchCandidates(payload, [score.tag], now());
            candidates = [...candidates, ...fetched]; await store.putCandidates(uid, fetched);
            const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).data : undefined;
            const totalPages = data && typeof data === 'object' ? Number((data as Record<string, unknown>).numPages) : NaN;
            const nextPage = fetched.length === 0 || (Number.isFinite(totalPages) && totalPages > 0 && page >= totalPages) ? 1 : page + 1;
            snapshot.nextSearchPages = { ...snapshot.nextSearchPages, [score.tag]: nextPage };
            await store.putSnapshot(snapshot);
            searchedTags.add(score.tag);
            // 空位仍不足时继续轮询后续页；已到末页的标签留到下一轮再循环。
            if (nextPage !== 1) pendingTags.push(score);
            order += 1;
          }
          setSearchActive(false);
        }
        if (disposed || stateKey() !== runState || !config.enabled || !config.cutoffMinute || config.favoriteHomeFillEnabled !== true) return;
        const selected = choose();
        if (!selected.length) return;
        const template = currentCards.find(isUsableTemplate);
        if (!template) return;
        const changedWhileLoading = attemptKey() !== runAttempt;
        const pushed = [...history];
        let lastSourceTag: string | undefined;
        for (let index = 0; index < Math.min(hidden.length, selected.length); index += 1) {
          const original = hidden[index];
          if (!original.isConnected || bvidOf(original) !== hiddenBvids[index]
            || (!(original as HTMLElement).hidden && original.getAttribute('data-time-filter-hidden') !== '1')) continue;
          const replacement = cloneHomeFillCard(template, selected[index], documentRef); if (!replacement) continue;
          const cell = hidden[index].closest('.col_3, .col_xs_1_5, .col_md_2, .col_xl_1_7') as HTMLElement | null;
          original.replaceWith(replacement);
          replacements.set(replacement, { clone: replacement, original, cell });
          if (cell) { cell.hidden = false; cell.removeAttribute('data-time-filter-hidden'); }
          pushed.push({ bvid: selected[index].bvid, pushedAt: now() });
          lastSourceTag = selected[index].sourceTag;
        }
        // 自己插入的补位卡片不启动新一轮；请求期间新出现的原生卡片仍需要处理。
        lastAttempt = changedWhileLoading ? null : attemptKey();
        await store.putHistory(uid, pushed);
        if (lastSourceTag) {
          const lastIndex = topTags.findIndex(({ tag }) => tag === lastSourceTag);
          snapshot.nextSourceTag = topTags[(lastIndex + 1) % topTags.length].tag;
          await store.putSnapshot(snapshot);
        }
      } catch {
        // 搜索失败时先结束搜索提示，再交给现有失败提示。
        setSearchActive(false);
        notify();
      }
      finally {
        setSearchActive(false);
        running = null;
        if (!disposed && attemptKey() !== lastAttempt) void run();
      }
    })(); return running;
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
    if (!downward || disposed || !config.enabled || !config.cutoffMinute || config.favoriteHomeFillEnabled !== true || !homePage(documentRef)) {
      clearScrollRetry();
      return;
    }
    if (scrollTimer === null) scrollAttempt = attemptKey();
    else clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const sameBatch = scrollAttempt === attemptKey();
      clearScrollRetry();
      // 新卡片或本轮补位已推进时交给原有链路，避免一次下滑重复触发两轮。
      if (!sameBatch || !cards(documentRef).some((card) => (card as HTMLElement).hidden || card.getAttribute('data-time-filter-hidden') === '1')) return;
      scrollRound += 1;
      void run();
    }, 200);
  };
  view?.addEventListener('scroll', onScroll, { passive: true });
  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
    if (attemptKey() !== lastAttempt) void run();
  }) : null;
  observer?.observe(documentRef, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'data-time-filter-hidden', 'data-time-filter-unknown', 'data-bvid', 'data-pubdate', 'href'],
  });
  void run();
  const getTags = async (): Promise<FavoriteTagScore[]> => {
    if (disposed || config.favoriteHomeFillEnabled !== true || !selectedFolders(config).length || !request) return [];
    if (running) await running;
    return (await loadSnapshot()).snapshot.tags;
  };
  return {
    run,
    getTags,
    updateConfig(next) {
      const stateChanged = config.cutoffMinute !== next.cutoffMinute
        || config.enabled !== next.enabled
        || selectionKey(config) !== selectionKey(next)
        || config.favoriteHomeFillEnabled !== next.favoriteHomeFillEnabled
        || config.favoriteRefreshRequestedAt !== next.favoriteRefreshRequestedAt;
      if (stateChanged) lastAttempt = null;
      if (stateChanged) restoreFillCards(!next.enabled || !next.cutoffMinute);
      config = { ...next };
      if (config.favoriteHomeFillEnabled !== true || !config.enabled) {
        clearScrollRetry();
        setSearchActive(false);
        restoreFillCards(!config.enabled || !config.cutoffMinute);
      } else void run();
    },
    disconnect() {
      disposed = true;
      clearScrollRetry();
      view?.removeEventListener('scroll', onScroll);
      setSearchActive(false);
      observer?.disconnect();
      restoreFillCards();
    },
  };
}
