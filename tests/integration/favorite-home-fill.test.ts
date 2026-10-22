/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFavoriteHomeFillStore, createFavoriteSnapshot, normalizeSearchCandidates, type FavoriteVideo } from '../../src/core/favorite-home-fill';
import type { FilterConfig } from '../../src/core/types';
import { createFavoriteHomeFillController, type FavoriteHomeFillController } from '../../src/runtime/favorite-home-fill-controller';

const config: FilterConfig = {
  cutoffMinute: '2020-01-01T00:00', enabled: true, supplementBudget: 20, debug: false,
  favoriteHomeFillEnabled: true, favoriteFolderIds: ['1'], favoriteFolderLimit: 1, favoriteVideoLimit: 1,
};

function renderHome(): void {
  document.body.innerHTML = '<div class="col_3"><div class="bili-video-card" data-bvid="BVhidden" data-pubdate="2000000000" hidden data-time-filter-hidden="1"><a href="/video/BVhidden"><span class="bili-video-card__info--tit__text">hidden</span></a></div></div><div class="col_3"><div class="bili-video-card" data-bvid="BVtemplate" data-pubdate="1"><a href="/video/BVtemplate"><span class="bili-video-card__info--tit__text">template</span></a></div></div>';
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
}

function scrollTo(position: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: position });
  window.dispatchEvent(new Event('scroll'));
}

/** 与控制器写入的快照一致，附带每夹视频上限标记。 */
function cachedSnapshot(folders: string[], videos: FavoriteVideo[], videoLimit = 1) {
  return { ...createFavoriteSnapshot('7', folders, videos), videoLimit };
}

describe('favorite home fill search lifecycle', () => {
  const controllers: FavoriteHomeFillController[] = [];
  const store = createFavoriteHomeFillStore({ indexedDB: undefined });

  beforeEach(async () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    await store.clear();
    renderHome();
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['游戏'], favoritedAt: 1 }]));
  });

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.disconnect());
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('continues beyond exhausted legacy results and persists the next page across controller restarts', async () => {
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVseen', pubdate: 1 }] } }, ['游戏']));
    await store.putHistory('7', [{ bvid: 'BVseen', pushedAt: Date.now() }]);
    const pages: number[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response({ page, numPages: 5, result: [{ bvid: `BVpage${page}`, title: `page ${page}`, pubdate: 1 }] });
    });
    const first = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(first);
    await first.run();
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVpage2');
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 3 });
    expect((await store.getHistory('7')).map((item) => item.bvid)).toContain('BVseen');
    first.disconnect();

    renderHome();
    const second = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(second);
    await second.run();
    expect(pages).toEqual([2, 3]);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVpage3');
  });

  it('limits an unchanged home batch to five searches despite unrelated mutations or repeated scans', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c', 'd', 'e', 'f'], favoritedAt: 1 }]));
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      searches.push(url.searchParams.get('keyword')!);
      return response({ numPages: 0, result: [] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    const calls = request.mock.calls.length;
    const banner = document.createElement('div');
    document.body.appendChild(banner);
    banner.textContent = '页面轮播更新';
    await Promise.resolve();
    await controller.run();
    expect(searches).toHaveLength(5);
    expect(new Set(searches).size).toBe(5);
    expect(request).toHaveBeenCalledTimes(calls);

    const newCard = document.querySelector('[data-bvid="BVhidden"]')!.cloneNode(true) as Element;
    newCard.setAttribute('data-bvid', 'BVnextbatch');
    document.body.appendChild(newCard);
    await Promise.resolve();
    await controller.run();
    expect(searches).toHaveLength(10);
  });

  it('uses the remaining search budget to continue pages when one tag has too few eligible results', async () => {
    const pages: number[] = [];
    const states: boolean[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response({ numPages: 10, result: [{ bvid: `BVpage${page}`, pubdate: page < 3 ? 2000000000 : 1 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config, onSearchStateChange: (active) => states.push(active) });
    controllers.push(controller);
    await controller.run();
    expect(pages).toEqual([1, 2, 3]);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVpage3');
    expect(states).toEqual([true, false]);
  });

  it('retries existing empty slots once per downward scroll burst without exceeding five searches', async () => {
    const pages: number[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response({ numPages: 20, result: [{ bvid: `BVlate${page}`, pubdate: 2000000000 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(pages).toEqual([1, 2, 3, 4, 5]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scrollTo(100);
    scrollTo(200);
    await vi.advanceTimersByTimeAsync(199);
    expect(pages).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    await controller.run();
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    scrollTo(200);
    scrollTo(100);
    document.body.append(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(250);
    await controller.run();
    expect(pages).toHaveLength(10);
    controller.disconnect();
    scrollTo(300);
    await vi.advanceTimersByTimeAsync(250);
    expect(pages).toHaveLength(10);
  });

  it('does not lose a scroll retry while a search is already in flight', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    let searches = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      searches += 1;
      if (searches === 1) { started(); return pending; }
      return response({ numPages: 1, result: [{ bvid: 'BVafterScroll', pubdate: 1 }] });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    const first = controller.run();
    await searching;
    scrollTo(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(searches).toBe(1);
    release(response({ numPages: 1, result: [{ bvid: 'BVlate', pubdate: 2000000000 }] }));
    await first;
    await controller.run();
    expect(searches).toBe(2);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVafterScroll');
  });

  it('does not duplicate a new-card search for the same scroll gesture and cancels pending retries on disable', async () => {
    let searches = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      searches += 1;
      return response({ result: [] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    scrollTo(100);
    const newCard = document.querySelector('[data-bvid="BVhidden"]')!.cloneNode(true) as Element;
    newCard.setAttribute('data-bvid', 'BVnewBatch');
    document.body.append(newCard);
    await controller.run();
    await vi.advanceTimersByTimeAsync(200);
    expect(searches).toBe(2);
    scrollTo(200);
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(searches).toBe(2);
  });

  it('searches other tags even when the first search returns enough videos for every slot', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c'], favoritedAt: 1 }]));
    const hiddenCell = document.querySelector('.col_3')!;
    for (const suffix of ['2', '3']) {
      const cell = hiddenCell.cloneNode(true) as Element;
      cell.querySelector('[data-bvid]')!.setAttribute('data-bvid', `BVhidden${suffix}`);
      document.body.appendChild(cell);
    }
    const template = document.querySelector('[data-bvid="BVtemplate"]');
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const tag = url.searchParams.get('keyword')!;
      searches.push(tag);
      return response({ numPages: 5, result: Array.from({ length: 8 }, (_, index) => ({ bvid: `BV${tag}${index}`, pubdate: 1 })) });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(searches).toEqual(['a', 'b', 'c']);
    expect(Array.from(document.querySelectorAll('[data-favorite-home-fill-label]')).map((node) => node.textContent))
      .toEqual(['收藏标签补位：a', '收藏标签补位：b', '收藏标签补位：c']);
    expect(document.querySelector('[data-bvid="BVtemplate"]')).toBe(template);
  });

  it('reuses cached candidates and only searches for the missing tag contribution', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c'], favoritedAt: 1 }]));
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result:
      Array.from({ length: 5 }, (_, index) => ({ bvid: `BVa${index}`, pubdate: 1 })),
    } }, ['a']));
    const secondSlot = document.querySelector('[data-bvid="BVhidden"]')!.cloneNode(true) as Element;
    secondSlot.setAttribute('data-bvid', 'BVhidden2');
    document.body.appendChild(secondSlot);
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const tag = url.searchParams.get('keyword')!;
      searches.push(tag);
      return response({ numPages: 5, result: [{ bvid: `BV${tag}0`, pubdate: 1 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(searches).toEqual(['b']);
    expect(Array.from(document.querySelectorAll('[data-favorite-home-fill-label]')).map((node) => node.textContent))
      .toEqual(['收藏标签补位：a', '收藏标签补位：b']);
  });

  it('rotates the first tag across single-slot batches while keeping each tag search page', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c'], favoritedAt: 1 }]));
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const tag = url.searchParams.get('keyword')!;
      searches.push(tag);
      return response({ numPages: 5, result: Array.from({ length: 3 }, (_, index) => ({ bvid: `BV${tag}${index}`, pubdate: 1 })) });
    });
    for (const tag of ['a', 'b', 'c']) {
      renderHome();
      const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
      controllers.push(controller);
      await controller.run();
      expect(document.querySelector('[data-favorite-home-fill-label]')?.textContent).toBe(`收藏标签补位：${tag}`);
      controller.disconnect();
    }
    expect(searches).toEqual(['a', 'b', 'c']);
    const snapshot = (await store.getSnapshot('7'))!;
    expect(snapshot.nextSourceTag).toBe('a');
    expect(snapshot.nextSearchPages).toEqual({ a: 2, b: 2, c: 2 });
  });

  it('fills available videos within the budget when other tags have no usable result', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c'], favoritedAt: 1 }]));
    const hiddenCell = document.querySelector('.col_3')!;
    for (const suffix of ['2', '3']) {
      const cell = hiddenCell.cloneNode(true) as Element;
      cell.querySelector('[data-bvid]')!.setAttribute('data-bvid', `BVhidden${suffix}`);
      document.body.appendChild(cell);
    }
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const tag = url.searchParams.get('keyword')!;
      searches.push(tag);
      return response({ numPages: 5, result: tag === 'a'
        ? Array.from({ length: 3 }, (_, index) => ({ bvid: `BVa${index}`, pubdate: 1 }))
        : [{ bvid: `BV${tag}late`, pubdate: 2000000000 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(searches).toEqual(['a', 'b', 'c']);
    expect(document.querySelectorAll('[data-favorite-home-fill]')).toHaveLength(3);
    expect(new Set(Array.from(document.querySelectorAll('[data-favorite-home-fill]')).map((card) => card.getAttribute('data-bvid'))).size).toBe(3);
  });

  it('does not fill skeletons or treat identifiers nested inside fill cards as new slots', async () => {
    document.querySelector('[data-bvid="BVhidden"]')!.remove();
    document.body.insertAdjacentHTML('afterbegin', '<div class="bili-video-card" hidden data-time-filter-hidden="1"><div class="bili-video-card__skeleton"></div></div><div class="bili-video-card" data-favorite-home-fill="1"><span data-bvid="BVnested" hidden data-time-filter-hidden="1"></span></div>');
    const request = vi.fn(async () => response({ mid: 7 }));
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(request.mock.calls).toHaveLength(1);
    expect(document.querySelectorAll('[data-favorite-home-fill]')).toHaveLength(1);
    expect(await store.getHistory('7')).toEqual([]);
  });

  it('stops retrying a failed search until the home batch or configuration changes', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      return new Response('', { status: 503 });
    });
    const onNotice = vi.fn();
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config, onNotice });
    controllers.push(controller);
    await controller.run();
    document.body.appendChild(document.createElement('span'));
    await Promise.resolve();
    await controller.run();
    expect(onNotice).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
  });

  it('keeps the cursor on tag refresh and cycles the same tag from its final page through pages one and two', async () => {
    const snapshot = (await store.getSnapshot('7'))!;
    snapshot.nextSearchPages = { 游戏: 5 };
    await store.putSnapshot(snapshot);
    const pages: number[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      if (url.pathname.includes('/fav/resource/list')) return response({ medias: [{ bvid: 'BVfavorite', tags: ['游戏'], fav_time: 1 }] });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response({ page, numPages: 5, result: [{ bvid: `BVcycle${page}`, pubdate: 1 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config: { ...config, favoriteHomeFillEnabled: false } });
    controllers.push(controller);
    controller.updateConfig({ ...config, favoriteRefreshRequestedAt: Date.now() });
    await controller.run();
    expect(pages).toEqual([5]);
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 1 });
    controller.disconnect();

    for (const page of [1, 2]) {
      renderHome();
      const next = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
      controllers.push(next);
      await next.run();
      expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe(`BVcycle${page}`);
      expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: page + 1 });
      next.disconnect();
    }
    expect(pages).toEqual([5, 1, 2]);
    expect((await store.getHistory('7')).map((item) => item.bvid).sort()).toEqual(['BVcycle1', 'BVcycle2', 'BVcycle5']);
  });

  it('returns an empty search page to page one on the next batch without retrying within the current batch', async () => {
    const snapshot = (await store.getSnapshot('7'))!;
    snapshot.nextSearchPages = { 游戏: 3 };
    await store.putSnapshot(snapshot);
    const pages: number[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      return response({ page, result: page === 3 ? [] : [{ bvid: 'BVcycle1', pubdate: 1 }] });
    });
    const first = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(first);
    await first.run();
    await first.run();
    expect(pages).toEqual([3]);
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 1 });
    first.disconnect();

    renderHome();
    const second = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(second);
    await second.run();
    expect(pages).toEqual([3, 1]);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVcycle1');
  });

  it('rebuilds the cached snapshot when the selected folders change', async () => {
    await store.clear();
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfolderOne', tags: ['旧标签'], favoritedAt: 1 }]));
    const folderIds: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      if (url.pathname.includes('/fav/resource/list')) {
        folderIds.push(url.searchParams.get('media_id')!);
        return response({ medias: [{ bvid: 'BVfolderTwo', tags: ['新标签'], fav_time: 2 }] });
      }
      return response({ numPages: 0, result: [] });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteFolderIds: ['2'] },
    });
    controllers.push(controller);
    await controller.run();
    expect(folderIds).toEqual(['2']);
    expect((await store.getSnapshot('7'))?.folders).toEqual(['2']);
    await expect(controller.getTags()).resolves.toEqual([expect.objectContaining({ tag: '新标签' })]);
  });

  it('rebuilds the collected snapshot when updateConfig changes the selection', async () => {
    const folderIds: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      if (url.pathname.includes('/fav/resource/list')) {
        folderIds.push(url.searchParams.get('media_id')!);
        return response({ medias: [{ bvid: 'BVfolderTwo', tags: ['新标签'], fav_time: 2 }] });
      }
      return response({ numPages: 0, result: [] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(folderIds).toEqual([]);

    controller.updateConfig({ ...config, favoriteFolderIds: ['2'] });
    await controller.run();
    expect(folderIds).toEqual(['2']);
    expect((await store.getSnapshot('7'))?.folders).toEqual(['2']);
  });

  it('rebuilds the cached snapshot when the per-folder video limit changes', async () => {
    await store.clear();
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVone', tags: ['旧标签'], favoritedAt: 1 }], 1));
    document.body.replaceChildren();
    const pageSizes: Array<string | null> = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      if (url.pathname.includes('/fav/resource/list')) {
        pageSizes.push(url.searchParams.get('ps'));
        return response({ medias: [
          { bvid: 'BVone', tags: ['旧标签'], fav_time: 1 },
          { bvid: 'BVtwo', tags: ['新标签'], fav_time: 2 },
        ] });
      }
      return response({ numPages: 0, result: [] });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteVideoLimit: 2 },
    });
    controllers.push(controller);
    await controller.run();
    expect(pageSizes).toEqual(['2']);
    expect((await store.getSnapshot('7') as (ReturnType<typeof createFavoriteSnapshot> & { videoLimit?: number }) | null)?.videoLimit).toBe(2);
    await expect(controller.getTags()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ tag: '新标签' })]));
  });

  it('announces one search-active cycle around real search requests', async () => {
    const states: boolean[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      return response({ numPages: 0, result: [{ bvid: 'BVsearch', title: 'search', pubdate: 1 }] });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => states.push(searching),
    });
    controllers.push(controller);
    await controller.run();
    await Promise.resolve();
    expect(states).toEqual([true, false]);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVsearch');
  });

  it('does not announce searching when cached candidates are enough', async () => {
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVcached', title: 'cached', pubdate: 1 }] } }, ['游戏']));
    const states: boolean[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      return new Response('', { status: 500 });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => states.push(searching),
    });
    controllers.push(controller);
    await controller.run();
    expect(states).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVcached');
  });

  it('clears the searching state before reporting a search failure', async () => {
    const events: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      return new Response('', { status: 503 });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => events.push(searching ? 'search:true' : 'search:false'),
      onNotice: () => events.push('notice'),
    });
    controllers.push(controller);
    await controller.run();
    expect(events).toEqual(['search:true', 'search:false', 'notice']);
  });

  it('clears the searching state immediately when filling is disabled', async () => {
    const states: boolean[] = [];
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      return pending;
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => { states.push(searching); if (searching) started(); },
    });
    controllers.push(controller);
    const runPromise = controller.run();
    await searching;
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    expect(states).toEqual([true, false]);
    release(response({ numPages: 0, result: [] }));
    await runPromise;
    expect(states).toEqual([true, false]);
  });

  it('clears the searching state on disconnect', async () => {
    const states: boolean[] = [];
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      return pending;
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => { states.push(searching); if (searching) started(); },
    });
    controllers.push(controller);
    const runPromise = controller.run();
    await searching;
    controller.disconnect();
    expect(states).toEqual([true, false]);
    release(response({ numPages: 0, result: [] }));
    await runPromise;
    expect(states).toEqual([true, false]);
  });

  it('does not start extra searches when the search indicator changes the DOM', async () => {
    const states: boolean[] = [];
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      searches.push(String(input));
      return response({ numPages: 0, result: [{ bvid: 'BVsearch', pubdate: 1 }] });
    });
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch, config,
      onSearchStateChange: (searching) => {
        states.push(searching);
        if (searching) {
          const toast = document.createElement('div');
          toast.id = 'search-state-toast';
          toast.textContent = '正在搜索补位视频…';
          document.body.append(toast);
        } else {
          document.getElementById('search-state-toast')?.remove();
        }
      },
    });
    controllers.push(controller);
    await controller.run();
    await Promise.resolve();
    await controller.run();
    expect(states).toEqual([true, false]);
    expect(searches).toHaveLength(1);
  });

  it('does not silently read only a subset of saved folders that exceed the selection limit', async () => {
    const request = vi.fn();
    const controller = createFavoriteHomeFillController({
      root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteFolderIds: ['1', '2'], favoriteFolderLimit: 1 },
    });
    controllers.push(controller);
    await controller.run();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
  });
});
