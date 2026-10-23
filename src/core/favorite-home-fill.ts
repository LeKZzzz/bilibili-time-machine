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
  /** 最近两轮实际搜索或落卡的标签，仅用于抽样降权。 */
  recentTagRounds?: string[][];
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
interface OwnedHistory extends PushedHistory { owner?: string; }
export interface FavoriteRoundTag extends FavoriteTagScore { weight: number; }

export interface FavoriteStore {
  getSnapshot(uid: string): Promise<FavoriteTagSnapshot | null>;
  putSnapshot(snapshot: FavoriteTagSnapshot): Promise<void>;
  getCandidates(uid: string): Promise<SearchCandidate[]>;
  putCandidates(uid: string, candidates: SearchCandidate[]): Promise<void>;
  getHistory(uid: string): Promise<PushedHistory[]>;
  putHistory(uid: string, history: PushedHistory[]): Promise<void>;
  claimHistory(uid: string, history: PushedHistory[], owner: string): Promise<string[]>;
  releaseHistory(uid: string, bvids: readonly string[], owner: string): Promise<void>;
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

function weightedIndex(items: readonly { weight: number }[], rng: () => number): number {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let remaining = rng() * total;
  for (let index = 0; index < items.length; index += 1) {
    remaining -= items[index].weight;
    if (remaining < 0) return index;
  }
  return items.length - 1;
}

/** 全部有效兴趣参与抽样；近期使用只降权，不排除。 */
export function sampleFavoriteTags(scores: readonly FavoriteTagScore[], recentTagRounds: readonly (readonly string[])[] = [], rng: () => number = Math.random): FavoriteRoundTag[] {
  const recent = new Set(recentTagRounds.slice(-2).flat());
  const seen = new Set<string>();
  const pool = scores.filter((item) => {
    if (!item.tag.trim() || !Number.isFinite(item.score) || item.score <= 0 || seen.has(item.tag)) return false;
    seen.add(item.tag);
    return true;
  }).slice(0, FAVORITE_MAX_TAGS).map((item) => ({ ...item, weight: Math.sqrt(item.score) * (recent.has(item.tag) ? 0.35 : 1) }));
  const result: FavoriteRoundTag[] = [];
  while (pool.length && result.length < 5) result.push(...pool.splice(weightedIndex(pool, rng), 1));
  return result;
}

/** 同 BV 使用较新元数据，并保留所有命中来源。 */
export function mergeSearchCandidates(candidates: readonly SearchCandidate[]): SearchCandidate[] {
  const map = new Map<string, SearchCandidate>();
  for (const candidate of candidates) {
    if (!candidate.bvid) continue;
    const old = map.get(candidate.bvid);
    map.set(candidate.bvid, {
      ...(old && old.collectedAt > candidate.collectedAt ? old : candidate),
      tags: [...new Set([...(old?.tags ?? []), ...candidate.tags])],
    });
  }
  return [...map.values()];
}

/** 本轮标签顺序先各取一条，再按本轮权重随机分配，组内随机选视频。 */
export function selectHomeFillCandidates(candidates: readonly SearchCandidate[], scores: readonly (FavoriteTagScore & { weight?: number })[], count: number, cutoff: string | number | null, existing: Iterable<string> = [], history: Iterable<string> = [], nowSeconds?: number, rng: () => number = Math.random): SearchCandidate[] {
  const blocked = new Set([...existing, ...history]);
  const used = new Set<string>();
  const eligible = mergeSearchCandidates(candidates).filter((candidate) => !blocked.has(candidate.bvid)
    && classifyVideo(candidate, cutoff, { enabled: true, nowSeconds }).visible);
  const ordered = scores.filter((score) => Number.isFinite(score.score) && score.score > 0)
    .map((score) => ({ ...score, weight: score.weight ?? Math.sqrt(score.score), candidates: eligible.filter((item) => item.tags.includes(score.tag)) }));
  const result: SearchCandidate[] = [];
  const limit = Math.max(0, Math.floor(count));
  const firstChoices = ordered.map((group) => {
    const pool = [...group.candidates];
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const other = Math.floor(rng() * (index + 1));
      [pool[index], pool[other]] = [pool[other], pool[index]];
    }
    return pool;
  });
  const assignments = new Map<number, SearchCandidate>();
  const owners = new Map<string, number>();
  // 多标签命中同一 BV 时可让前一来源改选，避免有足够候选却丢失来源覆盖。
  const assign = (index: number, visited: Set<string>): boolean => {
    for (const candidate of firstChoices[index]) {
      if (visited.has(candidate.bvid)) continue;
      visited.add(candidate.bvid);
      const owner = owners.get(candidate.bvid);
      if (owner !== undefined && !assign(owner, visited)) continue;
      owners.set(candidate.bvid, index);
      assignments.set(index, candidate);
      return true;
    }
    return false;
  };
  for (let index = 0; index < ordered.length && assignments.size < limit; index += 1) assign(index, new Set());
  for (const [index, candidate] of assignments) {
    used.add(candidate.bvid);
    result.push({ ...candidate, sourceTag: ordered[index].tag });
  }
  const available = (group: typeof ordered[number]) => group.candidates.filter((item) => !used.has(item.bvid));
  const take = (group: typeof ordered[number]): void => {
    const pool = available(group);
    if (!pool.length) return;
    const next = pool[Math.floor(rng() * pool.length)];
    used.add(next.bvid);
    result.push({ ...next, sourceTag: group.tag });
  };
  while (result.length < limit) {
    const groups = ordered.filter((group) => available(group).length > 0);
    if (!groups.length) break;
    take(groups[weightedIndex(groups, rng)]);
  }
  return result;
}

export function pruneTtl<T extends { collectedAt?: number; pushedAt?: number; updatedAt?: number }>(items: readonly T[], ttl: number, max: number, now = Date.now()): T[] {
  return items.filter((item) => isFresh(item, ttl, now)).sort((a, b) => (Number(b.collectedAt ?? b.pushedAt ?? b.updatedAt) - Number(a.collectedAt ?? a.pushedAt ?? a.updatedAt))).slice(0, max);
}

interface MemoryBucket { snapshots: Map<string, FavoriteTagSnapshot>; candidates: Map<string, SearchCandidate[]>; history: Map<string, OwnedHistory[]>; }
const memoryBucket: MemoryBucket = { snapshots: new Map(), candidates: new Map(), history: new Map() };
// UID 和 BV 号只包含 ASCII 字符，使用 ~ 作为字符串键的稳定上界。
const INDEXED_DB_STRING_MAX = '~';

function mergeHistory(existing: readonly OwnedHistory[], incoming: readonly PushedHistory[]): OwnedHistory[] {
  const map = new Map(existing.map((item) => [item.bvid, item]));
  for (const item of incoming) {
    const old = map.get(item.bvid);
    if (!old || item.pushedAt > old.pushedAt) map.set(item.bvid, { ...item });
  }
  return pruneTtl([...map.values()], FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY);
}

function claimRows(existing: readonly OwnedHistory[], incoming: readonly PushedHistory[], owner: string): { rows: OwnedHistory[]; claimed: string[] } {
  const rows = pruneTtl(existing, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY);
  const used = new Set(rows.map((item) => item.bvid));
  const claimed: string[] = [];
  for (const item of pruneTtl(incoming, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY)) {
    if (used.has(item.bvid)) continue;
    used.add(item.bvid);
    rows.push({ ...item, owner });
    claimed.push(item.bvid);
  }
  const keep = pruneTtl(rows, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY);
  const keptClaims = new Set(keep.filter((item) => item.owner === owner).map((item) => item.bvid));
  return { rows: keep, claimed: claimed.filter((bvid) => keptClaims.has(bvid)) };
}

/** IndexedDB 存储；不可用时使用当前页面内存，且始终按 UID 分区。 */
export function createFavoriteHomeFillStore(options: { indexedDB?: IDBFactory; dbName?: string } = {}): FavoriteStore {
  const indexed = options.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  const dbName = options.dbName ?? 'bilibili-time-filter-favorite-home-fill';
  if (!indexed) return memoryStore();
  let dbPromise: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => dbPromise ?? (dbPromise = new Promise((resolve, reject) => {
    const request = indexed.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'uid' });
      if (!db.objectStoreNames.contains('candidates')) db.createObjectStore('candidates', { keyPath: ['uid', 'bvid'] });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: ['uid', 'bvid'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  }));
  const range = (uid: string) => IDBKeyRange.bound([uid, ''], [uid, INDEXED_DB_STRING_MAX]);
  const tx = async <T>(store: string, mode: IDBTransactionMode, action: (objectStore: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      // 请求成功不等于事务提交成功，尤其不能提前报告历史认领成功。
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB transaction failed'));
    });
  };
  const updateRows = async <T extends { bvid: string }, R>(name: string, uid: string, update: (existing: T[]) => { rows: T[]; result: R }): Promise<R> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, 'readwrite');
      const store = transaction.objectStore(name);
      const read = store.getAll(range(uid));
      let result: R;
      read.onsuccess = () => {
        const existing = read.result as T[];
        const updated = update(existing);
        result = updated.result;
        const keep = new Set(updated.rows.map((item) => item.bvid));
        for (const old of existing) if (!keep.has(old.bvid)) store.delete([uid, old.bvid]);
        for (const item of updated.rows) store.put({ ...item, uid });
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? read.error ?? new Error('IndexedDB transaction failed'));
    });
  };
  return {
    async getSnapshot(uid) { const value = await tx<FavoriteTagSnapshot | undefined>('snapshots', 'readonly', (s) => s.get(uid)); return value && isFresh(value, FAVORITE_SNAPSHOT_TTL) ? value : null; },
    async putSnapshot(snapshot) { await tx('snapshots', 'readwrite', (s) => s.put(snapshot)); },
    async getCandidates(uid) { const values = await tx<SearchCandidate[]>('candidates', 'readonly', (s) => s.getAll(range(uid))); return pruneTtl(values, FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES); },
    async putCandidates(uid, candidates) {
      await updateRows<SearchCandidate, void>('candidates', uid, (existing) => ({ rows: pruneTtl(mergeSearchCandidates([...existing, ...candidates]), FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES), result: undefined }));
    },
    async getHistory(uid) { const values = await tx<OwnedHistory[]>('history', 'readonly', (s) => s.getAll(range(uid))); return pruneTtl(values, FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY); },
    async putHistory(uid, history) { await updateRows<OwnedHistory, void>('history', uid, (existing) => ({ rows: mergeHistory(existing, history), result: undefined })); },
    async claimHistory(uid, history, owner) {
      return updateRows<OwnedHistory, string[]>('history', uid, (existing) => {
        const { rows, claimed } = claimRows(existing, history, owner);
        return { rows, result: claimed };
      });
    },
    async releaseHistory(uid, bvids, owner) {
      const ids = new Set(bvids);
      await updateRows<OwnedHistory, void>('history', uid, (existing) => ({ rows: existing.filter((item) => item.owner !== owner || !ids.has(item.bvid)), result: undefined }));
    },
    async clear(uid) {
      await Promise.all(['snapshots', 'candidates', 'history'].map((name) => tx(name, 'readwrite', (s) => uid ? s.delete(name === 'snapshots' ? uid : range(uid)) : s.clear())));
    },
  };
}

function memoryStore(): FavoriteStore {
  return {
    async getSnapshot(uid) { const item = memoryBucket.snapshots.get(uid); return item && isFresh(item, FAVORITE_SNAPSHOT_TTL) ? structuredClone(item) : null; },
    async putSnapshot(value) { memoryBucket.snapshots.set(value.uid, structuredClone(value)); },
    async getCandidates(uid) { return pruneTtl(memoryBucket.candidates.get(uid) ?? [], FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES); },
    async putCandidates(uid, values) { memoryBucket.candidates.set(uid, pruneTtl(mergeSearchCandidates([...(memoryBucket.candidates.get(uid) ?? []), ...values]), FAVORITE_CANDIDATE_TTL, FAVORITE_MAX_CANDIDATES)); },
    async getHistory(uid) { return pruneTtl(memoryBucket.history.get(uid) ?? [], FAVORITE_HISTORY_TTL, FAVORITE_MAX_HISTORY); },
    async putHistory(uid, values) { memoryBucket.history.set(uid, mergeHistory(memoryBucket.history.get(uid) ?? [], values)); },
    async claimHistory(uid, values, owner) {
      const { rows, claimed } = claimRows(memoryBucket.history.get(uid) ?? [], values, owner);
      memoryBucket.history.set(uid, rows);
      return claimed;
    },
    async releaseHistory(uid, bvids, owner) {
      const ids = new Set(bvids);
      memoryBucket.history.set(uid, (memoryBucket.history.get(uid) ?? []).filter((item) => item.owner !== owner || !ids.has(item.bvid)));
    },
    async clear(uid) {
      if (uid) { memoryBucket.snapshots.delete(uid); memoryBucket.candidates.delete(uid); memoryBucket.history.delete(uid); }
      else { memoryBucket.snapshots.clear(); memoryBucket.candidates.clear(); memoryBucket.history.clear(); }
    },
  };
}

export const rankFavoriteTags = scoreFavoriteTags;
export const chooseHomeFillCandidates = selectHomeFillCandidates;
export const normalizeFavoritePayload = normalizeFavoriteVideos;
export const normalizeSearchPayload = normalizeSearchCandidates;
export const normalizeFavoriteFolderPayload = normalizeFavoriteFolders;
export const computeFavoriteTagScores = scoreFavoriteTags;
export const weightedRoundRobin = selectHomeFillCandidates;
