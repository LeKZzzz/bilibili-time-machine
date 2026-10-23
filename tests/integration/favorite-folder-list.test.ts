/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFavoriteFolderLoader } from '../../src/runtime/favorite-folder-list';

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data }), { status });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.get(key) ?? null; },
    key(index: number) { return [...values.keys()][index] ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, String(value)); },
  };
}

function folderRequests(request: ReturnType<typeof vi.fn>): number {
  return request.mock.calls.filter(([input]) => String(input).includes('/x/v3/fav/folder/')).length;
}

describe('favorite folder loader', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists the complete folder list per uid and reuses it across loader instances', async () => {
    const folders = [{ id: 1, title: '我的收藏' }, { id: 2, title: '稍后再看' }];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: 7 });
      return response({ count: folders.length, list: folders });
    });
    const first = createFavoriteFolderLoader(request as typeof fetch, () => true);
    await expect(first()).resolves.toEqual([
      { id: '1', title: '我的收藏' },
      { id: '2', title: '稍后再看' },
    ]);
    expect(folderRequests(request)).toBe(1);

    const refreshedPage = createFavoriteFolderLoader(request as typeof fetch, () => true);
    await expect(refreshedPage()).resolves.toHaveLength(2);
    expect(folderRequests(request)).toBe(1);
    expect(request.mock.calls.some(([input]) => String(input).includes('/x/web-interface/nav'))).toBe(true);
  });

  it('keeps caches isolated by uid', async () => {
    let uid = 7;
    const foldersByUid: Record<string, unknown[]> = {
      '7': [{ id: 1, title: '账号七' }],
      '8': [{ id: 9, title: '账号八' }],
    };
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: uid });
      return response({ count: foldersByUid[String(uid)].length, list: foldersByUid[String(uid)] });
    });
    const storage = memoryStorage();
    const first = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(first()).resolves.toEqual([{ id: '1', title: '账号七' }]);

    uid = 8;
    const second = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(second()).resolves.toEqual([{ id: '9', title: '账号八' }]);
    expect(folderRequests(request)).toBe(2);

    uid = 7;
    const cached = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(cached()).resolves.toEqual([{ id: '1', title: '账号七' }]);
    expect(folderRequests(request)).toBe(2);
  });

  it('treats an empty folder list as a valid cache', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: 7 });
      return response({ count: 0, list: [] });
    });
    const storage = memoryStorage();
    const first = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(first()).resolves.toEqual([]);
    const before = folderRequests(request);

    const second = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(second()).resolves.toEqual([]);
    expect(folderRequests(request)).toBe(before);
  });

  it('replaces the cache only after a successful forced refresh', async () => {
    let folders = [{ id: 1, title: '旧收藏夹' }];
    let fail = false;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: 7 });
      if (fail) return new Response('', { status: 500 });
      return response({ count: folders.length, list: folders });
    });
    const storage = memoryStorage();
    const loader = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(loader()).resolves.toEqual([{ id: '1', title: '旧收藏夹' }]);

    folders = [{ id: 2, title: '新收藏夹' }];
    await expect(loader(true)).resolves.toEqual([{ id: '2', title: '新收藏夹' }]);
    const afterRefresh = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(afterRefresh()).resolves.toEqual([{ id: '2', title: '新收藏夹' }]);

    fail = true;
    folders = [{ id: 3, title: '失败结果' }];
    await expect(loader(true)).rejects.toThrow('request failed: 500');

    fail = false;
    const afterFailure = createFavoriteFolderLoader(request as typeof fetch, () => true, storage);
    await expect(afterFailure()).resolves.toEqual([{ id: '2', title: '新收藏夹' }]);
  });

  it('does not send any request while the feature is disabled', async () => {
    const request = vi.fn();
    const loader = createFavoriteFolderLoader(request as typeof fetch, () => false, memoryStorage());
    await expect(loader()).rejects.toThrow('favorite folder loading disabled');
    expect(request).not.toHaveBeenCalled();
  });

  it('allows first-source selection but stops after that selection is cancelled', async () => {
    let selecting = true;
    const request = vi.fn(async () => {
      selecting = false;
      return response({ mid: 7 });
    });
    const loader = createFavoriteFolderLoader(request as typeof fetch, () => true, memoryStorage());
    await expect(loader(false, () => selecting)).rejects.toThrow('favorite folder loading disabled');
    expect(request).toHaveBeenCalledOnce();
    expect(folderRequests(request)).toBe(0);
    await expect(loader(false, () => selecting)).rejects.toThrow('favorite folder loading disabled');
    expect(request).toHaveBeenCalledOnce();
  });

  it('stops pagination when disabled mid-refresh and keeps the previous cache', async () => {
    let enabled = true;
    let mode: 'initial' | 'refresh' = 'initial';
    let requests = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: 7 });
      requests += 1;
      if (mode === 'initial') return response({ count: 1, list: [{ id: 1, title: '旧收藏夹' }] });
      if (url.includes('/x/v3/fav/folder/created/list-all')) return response({ list: [] });
      enabled = false;
      return response({ count: 30, list: Array.from({ length: 10 }, (_, index) => ({ id: index + 2, title: `夹 ${index + 2}` })) });
    });
    const storage = memoryStorage();
    const loader = createFavoriteFolderLoader(request as typeof fetch, () => enabled, storage);
    await expect(loader()).resolves.toEqual([{ id: '1', title: '旧收藏夹' }]);

    mode = 'refresh';
    enabled = true;
    await expect(loader(true)).rejects.toThrow('favorite folder loading disabled');
    expect(requests).toBe(3);

    enabled = true;
    const restored = createFavoriteFolderLoader(request as typeof fetch, () => enabled, storage);
    await expect(restored()).resolves.toEqual([{ id: '1', title: '旧收藏夹' }]);
    expect(requests).toBe(3);
  });

  it('keeps an in-memory cache when storage is unavailable', async () => {
    const broken = {
      get length(): number { throw new Error('storage blocked'); },
      clear(): void { throw new Error('storage blocked'); },
      getItem(): string | null { throw new Error('storage blocked'); },
      key(): string | null { throw new Error('storage blocked'); },
      removeItem(): void { throw new Error('storage blocked'); },
      setItem(): void { throw new Error('storage blocked'); },
    } as Storage;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/x/web-interface/nav')) return response({ mid: 7 });
      return response({ count: 1, list: [{ id: 1, title: '内存收藏夹' }] });
    });
    const loader = createFavoriteFolderLoader(request as typeof fetch, () => true, broken);
    await expect(loader()).resolves.toEqual([{ id: '1', title: '内存收藏夹' }]);
    await expect(loader()).resolves.toEqual([{ id: '1', title: '内存收藏夹' }]);
    expect(folderRequests(request)).toBe(1);
  });
});
