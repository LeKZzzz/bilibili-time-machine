import { classifyVideo } from './video';
import type { FavoriteFolderOption, VideoRecord } from './types';

/** 收藏标签首页补位的共享纯函数与轻量存储适配。 */
export const FAVORITE_SNAPSHOT_TTL = 24 * 60 * 60 * 1000;
export const FAVORITE_CANDIDATE_TTL = 7 * 24 * 60 * 60 * 1000;
export const FAVORITE_HISTORY_TTL = 30 * 24 * 60 * 60 * 1000;
export const FAVORITE_MAX_FOLDERS = 10;
export const FAVORITE_MAX_VIDEOS_PER_FOLDER = 200;
export const FAVORITE_MAX_TAGS = 100;
export const FAVORITE_MAX_CANDIDATES = 500;
export const FAVORITE_MAX_HISTORY = 1000;
export const SNAPSHOT_TTL_MS = FAVORITE_SNAPSHOT_TTL;
export const CANDIDATE_TTL_MS = FAVORITE_CANDIDATE_TTL;
export const HISTORY_TTL_MS = FAVORITE_HISTORY_TTL;

export interface FavoriteHomeFillConfig {
  favoriteHomeFillEnabled?: boolean;
  favoriteFolderIds?: string[];
  favoriteFolderLimit?: number;
  favoriteVideoLimit?: number;
}

export interface FavoriteVideo {
  bvid: string;
  title?: string;
  pic?: string;
  pubdate?: number | string | null;
  tags: string[];
  favoritedAt?: number | string | null;
  folderId?: string;
}

export interface FavoriteTagScore {
  tag: string;
  score: number;
  frequency: number;
  freshness: number;
  videoCount: number;
  latestFavoritedAt: number | null;
}

export interface FavoriteTagSnapshot {
  uid: string;
  folders: string[];
  videos: FavoriteVideo[];
  tags: FavoriteTagScore[];
  updatedAt: number;
  /** 生成快照时的每夹视频上限；旧快照缺少此值时重新读取。 */
  videoLimit?: number;
  /** 每个标签下一轮搜索的页码，复用快照存储以便跨刷新继续。 */
  nextSearchPages?: Record<string, number>;
  /** 下一批优先参与补位的标签，避免少量空位始终由同一标签占用。 */
  nextSourceTag?: string;
}

export interface SearchCandidate extends VideoRecord {
  bvid: string;
  tags: string[];
  searchOrder: number;
  collectedAt: number;
  sourceTag?: string;
  /** 搜索卡片中的 UP 主显示名。 */
  author?: string;
  /** UP 主 UID；接口可能返回数字或字符串。 */
  mid?: string | number;
  /** 搜索卡片显示的时长，例如 12:34。 */
  duration?: string;
  /** 播放量（部分接口命名为 view）。 */
  play?: number | string | null;
  /** 评论数（部分接口命名为 video_review/review）。 */
  videoReview?: number | string | null;
}
export type FavoriteHomeFillCandidate = SearchCandidate;

export interface PushedHistory { bvid: string; pushedAt: number; }

export interface FavoriteStore {
  getSnapshot(uid: string): Promise<FavoriteTagSnapshot | null>;
  putSnapshot(snapshot: FavoriteTagSnapshot): Promise<void>;
  getCandidates(uid: string): Promise<SearchCandidate[]>;
  putCandidates(uid: string, candidates: SearchCandidate[]): Promise<void>;
  getHistory(uid: string): Promise<PushedHistory[]>;
  putHistory(uid: string, history: PushedHistory[]): Promise<void>;
  clear(uid?: string): Promise<void>;
}

function cleanTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().replace(/\s+/g, ' ');
  return tag ? tag.slice(0, 80) : null;
}

/** 清理搜索接口返回的标题高亮标记，并还原常见 HTML 实体。 */
export function cleanSearchTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  // 先移除真实标签，再解码实体，避免把用户标题中转义的 <em> 当作高亮标签。
  const withoutTags = raw.replace(/<\/?[a-z][^>]*>/gi, '');
  const decoded = withoutTags.replace(/&(#x?[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, token: string) => {
    const lower = token.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'apos') return "'";
    if (lower === 'gt') return '>';
    if (lower === 'lt') return '<';
    if (lower === 'nbsp') return ' ';
    if (lower === 'quot') return '"';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
  return decoded.trim() || undefined;
}

function timestamp(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** 从收藏夹列表接口提取可供面板选择的收藏夹元数据。 */
export function normalizeFavoriteFolders(payload: unknown): FavoriteFolderOption[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (Array.isArray(root.data)) return normalizeFavoriteFolders(root.data);
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const lists = [data.list, data.folders, data.items, data.created, payload];
  let raw: unknown[] = [];
  for (const candidate of lists) if (Array.isArray(candidate)) { raw = candidate; break; }
  const result: FavoriteFolderOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const idValue = value.id ?? value.fid ?? value.media_id ?? value.folder_id;
    const id = typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue).trim() : '';
    if (!id || seen.has(id)) continue;
    const titleValue = value.title ?? value.name ?? value.folder_name;
    const title = typeof titleValue === 'string' && titleValue.trim() ? titleValue.trim() : `收藏夹 ${id}`;
    const countValue = value.media_count ?? value.mediaCount ?? value.count;
    const mediaCount = typeof countValue === 'number' && Number.isFinite(countValue) && countValue >= 0
      ? Math.trunc(countValue)
      : typeof countValue === 'string' && Number.isFinite(Number(countValue)) && Number(countValue) >= 0
        ? Math.trunc(Number(countValue))
        : undefined;
    const isDefault = value.is_default === true || value.isDefault === true;
    result.push({ id, title, ...(mediaCount === undefined ? {} : { mediaCount }), ...(isDefault ? { isDefault: true } : {}) });
    seen.add(id);
  }
  return result;
}

/** 从收藏接口的常见脱敏结构中提取视频和标签；结构不明时安全返回空数组。 */
export function normalizeFavoriteVideos(payload: unknown, folderId?: string, limit = FAVORITE_MAX_VIDEOS_PER_FOLDER): FavoriteVideo[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const lists = [data.medias, data.archives, data.list, data.items, data.records, payload];
  let raw: unknown[] = [];
  for (const candidate of lists) if (Array.isArray(candidate)) { raw = candidate; break; }
  const result: FavoriteVideo[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, Math.min(FAVORITE_MAX_VIDEOS_PER_FOLDER, Math.max(0, Math.floor(limit))))) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    const idValue = value.bvid ?? value.bv_id ?? value.bvId;
    const id = typeof idValue === 'string' ? idValue.trim() : '';
    if (!id || seen.has(id)) continue;
    const tagsValue = value.tags ?? value.tag ?? value.video_tags;
    const tags = readArray(tagsValue).map((tag) => tag && typeof tag === 'object' ? cleanTag((tag as Record<string, unknown>).tag_name ?? (tag as Record<string, unknown>).name ?? (tag as Record<string, unknown>).tag) : cleanTag(tag)).filter((tag): tag is string => Boolean(tag));
    if (typeof tagsValue === 'string') tags.push(...tagsValue.split(/[,，、|]/).map(cleanTag).filter((tag): tag is string => Boolean(tag)));
    const uniqueTags = [...new Set(tags)].slice(0, FAVORITE_MAX_TAGS);
    const pubdateValue = value.pubdate ?? value.pub_time ?? value.pubtime;
    const favoritedValue = value.fav_time ?? value.favTime ?? value.favoritedAt ?? value.mtime ?? value.ctime;
    const picValue = value.pic ?? value.cover;
    result.push({
      bvid: id,
      title: typeof value.title === 'string' ? value.title : undefined,
      pic: typeof picValue === 'string' ? picValue : undefined,
      pubdate: (typeof pubdateValue === 'number' || typeof pubdateValue === 'string' || pubdateValue === null ? pubdateValue : undefined) as FavoriteVideo['pubdate'],
      tags: uniqueTags,
      favoritedAt: (typeof favoritedValue === 'number' || typeof favoritedValue === 'string' || favoritedValue === null ? favoritedValue : null),
      folderId,
    });
    seen.add(id);
  }
  return result;
}

/** 频次 60% 与最近收藏新鲜度 40% 的固定评分。 */
export function scoreFavoriteTags(videos: readonly FavoriteVideo[], now = Date.now()): FavoriteTagScore[] {
  const map = new Map<string, { count: number; latest: number | null; totalFresh: number }>();
  const times = videos.map((video) => timestamp(video.favoritedAt)).filter((value): value is number => value !== null);
  const min = times.length ? Math.min(...times) : now;
  const max = times.length ? Math.max(...times) : now;
  const span = Math.max(1, max - min);
  for (const video of videos) {
    const when = timestamp(video.favoritedAt);
    const freshness = when === null ? 0 : Math.max(0, Math.min(1, (when - min) / span));
    for (const raw of video.tags) {
      const tag = cleanTag(raw); if (!tag) continue;
      const current = map.get(tag) ?? { count: 0, latest: null, totalFresh: 0 };
      current.count += 1;
      current.latest = current.latest === null || (when !== null && when > current.latest) ? when : current.latest;
      current.totalFresh += freshness;
      map.set(tag, current);
    }
  }
  const maxCount = Math.max(1, ...[...map.values()].map((item) => item.count));
  return [...map.entries()].map(([tag, item]) => {
    const frequency = item.count / maxCount;
    const freshness = item.count ? item.totalFresh / item.count : 0;
    return { tag, score: frequency * 0.6 + freshness * 0.4, frequency, freshness, videoCount: item.count, latestFavoritedAt: item.latest };
  }).sort((a, b) => b.score - a.score || b.frequency - a.frequency || a.tag.localeCompare(b.tag)).slice(0, FAVORITE_MAX_TAGS);
}

export function createFavoriteSnapshot(uid: string, folders: readonly string[], videos: readonly FavoriteVideo[], updatedAt = Date.now()): FavoriteTagSnapshot {
  const unique = new Map<string, FavoriteVideo>();
  for (const video of videos) if (video.bvid && !unique.has(video.bvid)) unique.set(video.bvid, { ...video, tags: [...new Set(video.tags.map((tag) => cleanTag(tag)).filter((tag): tag is string => Boolean(tag)))] });
  const bounded = [...unique.values()].slice(0, FAVORITE_MAX_VIDEOS_PER_FOLDER * FAVORITE_MAX_FOLDERS);
  return { uid, folders: [...new Set(folders.map(String))].slice(0, FAVORITE_MAX_FOLDERS), videos: bounded, tags: scoreFavoriteTags(bounded, updatedAt), updatedAt };
}

export function isFresh(value: { updatedAt?: number; collectedAt?: number; pushedAt?: number }, ttl: number, now = Date.now()): boolean {
  const at = value.updatedAt ?? value.collectedAt ?? value.pushedAt;
  return Number.isFinite(at) && now - Number(at) <= ttl;
}

export function normalizeSearchCandidates(payload: unknown, tags: readonly string[], collectedAt = Date.now()): SearchCandidate[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  const list = [data.result, data.results, data.list, data.items, payload].find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  const out: SearchCandidate[] = []; const seen = new Set<string>();
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const value = item as Record<string, unknown>;
    const bvid = typeof value.bvid === 'string' ? value.bvid.trim() : '';
    if (!bvid || seen.has(bvid)) return;
    seen.add(bvid);
    const authorValue = value.author ?? value.uname;
    const author = typeof authorValue === 'string' && authorValue.trim() ? authorValue.trim() : undefined;
    const midValue = value.mid ?? value.up_mid;
    const mid = typeof midValue === 'string' || typeof midValue === 'number' ? midValue : undefined;
    const duration = typeof value.duration === 'string' && value.duration.trim() ? value.duration.trim() : undefined;
    const playValue = value.play ?? value.view;
    const play = typeof playValue === 'number' || typeof playValue === 'string' || playValue === null ? playValue : undefined;
    const reviewValue = value.video_review ?? value.videoReview ?? value.review;
    const videoReview = typeof reviewValue === 'number' || typeof reviewValue === 'string' || reviewValue === null ? reviewValue : undefined;
    out.push({
      bvid,
      aid: value.aid as VideoRecord['aid'],
      title: cleanSearchTitle(value.title),
      pic: typeof value.pic === 'string' ? value.pic : typeof value.pic_url === 'string' ? value.pic_url : undefined,
      pubdate: (typeof value.pubdate === 'number' || typeof value.pubdate === 'string' || value.pubdate === null ? value.pubdate : typeof value.pub_time === 'number' || typeof value.pub_time === 'string' || value.pub_time === null ? value.pub_time : null),
      tags: [...new Set(tags.map((tag) => cleanTag(tag)).filter((tag): tag is string => Boolean(tag)))],
      searchOrder: index,
      collectedAt,
      ...(author === undefined ? {} : { author }),
      ...(mid === undefined ? {} : { mid }),
      ...(duration === undefined ? {} : { duration }),
      ...(play === undefined ? {} : { play }),
      ...(videoReview === undefined ? {} : { videoReview }),
    });
  });
  return out.slice(0, FAVORITE_MAX_CANDIDATES);
}

/** 先轮询不同标签，再按分数分配剩余名额；标签内保持搜索顺序。 */
export function selectHomeFillCandidates(candidates: readonly SearchCandidate[], scores: readonly FavoriteTagScore[], count: number, cutoff: string | number | null, existing: Iterable<string> = [], history: Iterable<string> = [], nowSeconds?: number, firstSourceTag?: string): SearchCandidate[] {
  const blocked = new Set([...existing, ...history]); const used = new Set<string>();
  const groups = new Map<string, SearchCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.bvid || blocked.has(candidate.bvid) || used.has(candidate.bvid)) continue;
    if (!classifyVideo(candidate, cutoff, { enabled: true, nowSeconds }).visible) continue;
    for (const tag of candidate.tags) { const list = groups.get(tag) ?? []; list.push(candidate); groups.set(tag, list); }
  }
  const ordered = scores.filter((score) => groups.has(score.tag)).slice(0, 5);
  const result: SearchCandidate[] = [];
  const start = Math.max(0, ordered.findIndex((score) => score.tag === firstSourceTag));
  for (const score of [...ordered.slice(start), ...ordered.slice(0, start)]) {
    if (result.length >= Math.max(0, count)) break;
    const next = groups.get(score.tag)?.find((candidate) => !used.has(candidate.bvid));
    if (!next) continue;
    used.add(next.bvid);
    result.push({ ...next, sourceTag: score.tag });
  }
  const highest = Math.max(0.0001, ...ordered.map((score) => score.score));
  while (result.length < Math.max(0, count) && ordered.length) {
    let advanced = false;
    for (const score of ordered) {
      const list = groups.get(score.tag) ?? [];
      const quota = Math.max(1, Math.round((score.score / highest) * 3));
      for (let turn = 0; turn < quota && result.length < count; turn += 1) {
        const next = list.find((candidate) => !used.has(candidate.bvid));
        if (!next) break;
        used.add(next.bvid);
        // 记录本轮真正命中的标签，供首页补位标记展示来源。
        result.push({ ...next, sourceTag: score.tag });
        advanced = true;
      }
      if (result.length >= count) break;
    }
    if (!advanced) break;
  }
  return result;
}

export function pruneTtl<T extends { collectedAt?: number; pushedAt?: number; updatedAt?: number }>(items: readonly T[], ttl: number, max: number, now = Date.now()): T[] {
  return items.filter((item) => isFresh(item, ttl, now)).sort((a, b) => (Number(b.collectedAt ?? b.pushedAt ?? b.updatedAt) - Number(a.collectedAt ?? a.pushedAt ?? a.updatedAt))).slice(0, max);
}

interface MemoryBucket { snapshots: Map<string, FavoriteTagSnapshot>; candidates: Map<string, SearchCandidate[]>; history: Map<string, PushedHistory[]>; }
const memoryBucket: MemoryBucket = { snapshots: new Map(), candidates: new Map(), history: new Map() };
// UID 和 BV 号只包含 ASCII 字符，使用 ~ 作为字符串键的稳定上界，避免产物包含 U+FFFF 非字符。
const INDEXED_DB_STRING_MAX = '~';

/** IndexedDB 存储；不可用时使用当前页面内存，且始终按 UID 分区。 */
export function createFavoriteHomeFillStore(options: { indexedDB?: IDBFactory; dbName?: string } = {}): FavoriteStore {
  const indexed = options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  const dbName = options.dbName ?? 'bilibili-time-filter-favorite-home-fill';
  if (!indexed) return memoryStore();
  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => dbPromise ?? (dbPromise = new Promise((resolve, reject) => {
    const request = indexed.open(dbName, 1);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'uid' }); if (!db.objectStoreNames.contains('candidates')) db.createObjectStore('candidates', { keyPath: ['uid', 'bvid'] }); if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: ['uid', 'bvid'] }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  }));
  const tx = async <T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => { const request = action(db.transaction(store, mode).objectStore(store)); request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error); });
  };
  return {
    async getSnapshot(uid) { const value = await tx<FavoriteTagSnapshot | undefined>('snapshots', 'readonly', (s) => s.get(uid)); return value && isFresh(value, FAVORITE_SNAPSHOT_TTL) ? value : null; },
    async putSnapshot(snapshot) { await tx('snapshots', 'readwrite', (s) => s.put(snapshot)); },
    async getCandidates(uid) { const values = await tx<SearchCandidate[]>('candidates', 'readonly', (s) => s.getAll(IDBKeyRange.bound([uid, ''], [uid, INDEXED_DB_STRING_MAX]))); return pruneTtl(values ?? [], FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES); },
    async putCandidates(uid, candidates) { const db = await open(); await new Promise<void>((resolve, reject) => { const t = db.transaction('candidates', 'readwrite'); const s = t.objectStore('candidates'); const read = s.getAll(IDBKeyRange.bound([uid, ''], [uid, INDEXED_DB_STRING_MAX])); read.onsuccess = () => { const existing = read.result as Array<SearchCandidate & { uid: string }>; const map = new Map(existing.map((item) => [item.bvid, item])); for (const candidate of candidates) map.set(candidate.bvid, { ...candidate, uid }); const keep = pruneTtl([...map.values()], FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES); const keepIds = new Set(keep.map((item) => item.bvid)); for (const old of existing) if (!keepIds.has(old.bvid)) s.delete([uid, old.bvid]); for (const candidate of keep) s.put({ ...candidate, uid }); }; read.onerror = () => reject(read.error); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); }); },
    async getHistory(uid) { const values = await tx<PushedHistory[]>('history', 'readonly', (s) => s.getAll(IDBKeyRange.bound([uid, ''], [uid, INDEXED_DB_STRING_MAX]))); return pruneTtl(values ?? [], FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY); },
    async putHistory(uid, history) { const db = await open(); const keep = pruneTtl(history, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY); await new Promise<void>((resolve, reject) => { const t = db.transaction('history', 'readwrite'); const s = t.objectStore('history'); const read = s.getAll(IDBKeyRange.bound([uid, ''], [uid, INDEXED_DB_STRING_MAX])); read.onsuccess = () => { for (const old of (read.result as Array<PushedHistory & { uid: string }>)) if (!keep.some((item) => item.bvid === old.bvid)) s.delete([uid, old.bvid]); for (const item of keep) s.put({ ...item, uid }); }; read.onerror = () => reject(read.error); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); }); },
    async clear(uid) { if (uid) { await tx('snapshots', 'readwrite', (s) => s.delete(uid)); } else { const db = await open(); await Promise.all(['snapshots', 'candidates', 'history'].map((name) => new Promise<void>((resolve, reject) => { const t = db.transaction(name, 'readwrite'); t.objectStore(name).clear(); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); }))); } },
  };
}

function memoryStore(): FavoriteStore {
  return { async getSnapshot(uid) { const item = memoryBucket.snapshots.get(uid); return item && isFresh(item, FAVORITE_SNAPSHOT_TTL) ? item : null; }, async putSnapshot(value) { memoryBucket.snapshots.set(value.uid, value); }, async getCandidates(uid) { return pruneTtl(memoryBucket.candidates.get(uid) ?? [], FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES); }, async putCandidates(uid, values) { memoryBucket.candidates.set(uid, pruneTtl([...(memoryBucket.candidates.get(uid) ?? []), ...values], FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES)); }, async getHistory(uid) { return pruneTtl(memoryBucket.history.get(uid) ?? [], FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY); }, async putHistory(uid, values) { memoryBucket.history.set(uid, pruneTtl(values, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY)); }, async clear(uid) { if (uid) { memoryBucket.snapshots.delete(uid); memoryBucket.candidates.delete(uid); memoryBucket.history.delete(uid); } else { memoryBucket.snapshots.clear(); memoryBucket.candidates.clear(); memoryBucket.history.clear(); } } };
}

export const rankFavoriteTags = scoreFavoriteTags;
export const chooseHomeFillCandidates = selectHomeFillCandidates;
export const normalizeFavoritePayload = normalizeFavoriteVideos;
export const normalizeSearchPayload = normalizeSearchCandidates;
export const normalizeFavoriteFolderPayload = normalizeFavoriteFolders;
export const computeFavoriteTagScores = scoreFavoriteTags;
export const weightedRoundRobin = selectHomeFillCandidates;
