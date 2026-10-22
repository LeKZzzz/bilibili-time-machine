import type { FavoriteFolderOption } from '../core/types';
import { loadFavoriteFolders, resolveBilibiliUid } from './favorite-home-fill-controller';

const FAVORITE_FOLDER_CACHE_PREFIX = 'bilibili-time-filter:favorite-folders:v1:';

function cacheKey(uid: string): string {
  return `${FAVORITE_FOLDER_CACHE_PREFIX}${encodeURIComponent(uid)}`;
}

function copyFolders(folders: readonly FavoriteFolderOption[]): FavoriteFolderOption[] {
  return folders.map((folder) => ({ ...folder }));
}

/** 只接受本模块写入的结构；空数组是有效缓存，损坏内容按无缓存处理。 */
function parseFolders(raw: string | null): FavoriteFolderOption[] | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    const folders: FavoriteFolderOption[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const folder = item as Record<string, unknown>;
      const id = typeof folder.id === 'string' ? folder.id.trim() : '';
      const title = typeof folder.title === 'string' ? folder.title.trim() : '';
      if (!id || !title || seen.has(id)) continue;
      const mediaCount = typeof folder.mediaCount === 'number' && Number.isFinite(folder.mediaCount) && folder.mediaCount >= 0
        ? Math.trunc(folder.mediaCount)
        : undefined;
      folders.push({ id, title, ...(mediaCount === undefined ? {} : { mediaCount }), ...(folder.isDefault === true ? { isDefault: true } : {}) });
      seen.add(id);
    }
    return folders;
  } catch {
    return null;
  }
}

/**
 * 创建收藏夹名称列表加载器：按账号持久缓存完整列表，手动 force 刷新成功后才替换。
 * 关闭补位后不发起任何请求（包括 UID 查询），分页中途关闭也会停止后续请求。
 */
export function createFavoriteFolderLoader(
  request: typeof fetch,
  isEnabled: () => boolean,
  storage?: Storage,
): (force?: boolean) => Promise<FavoriteFolderOption[]> {
  const memory = new Map<string, FavoriteFolderOption[]>();
  const resolveStorage = (): Storage | null => {
    if (storage) return storage;
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  };
  const readCache = (uid: string): FavoriteFolderOption[] | null => {
    const cached = memory.get(uid);
    // 空数组也是有效缓存，只有未命中才回源。
    if (cached !== undefined) return cached;
    const target = resolveStorage();
    if (!target) return null;
    let raw: string | null;
    try {
      raw = target.getItem(cacheKey(uid));
    } catch {
      return null;
    }
    const folders = parseFolders(raw);
    if (folders) memory.set(uid, folders);
    return folders;
  };
  const writeCache = (uid: string, folders: readonly FavoriteFolderOption[]): void => {
    const value = copyFolders(folders);
    memory.set(uid, value);
    const target = resolveStorage();
    if (!target) return;
    try {
      target.setItem(cacheKey(uid), JSON.stringify(value));
    } catch {
      // 配额或隐私模式导致写入失败时保留当前页面内存缓存。
    }
  };
  return async (force = false): Promise<FavoriteFolderOption[]> => {
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    const uid = await resolveBilibiliUid(request);
    if (!uid) throw new Error('uid unavailable');
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    const cached = readCache(uid);
    if (cached && !force) return copyFolders(cached);
    const folders = await loadFavoriteFolders(request, uid, isEnabled);
    if (!isEnabled()) throw new Error('favorite folder loading disabled');
    writeCache(uid, folders);
    return copyFolders(folders);
  };
}
