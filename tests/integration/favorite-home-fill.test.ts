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
    const first = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
    controllers.push(first);
    await first.run();
    expect(document.querySelector('[data-favorite-home-fill]')?.getAttribute('data-bvid')).toBe('BVpage2');
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 3 });
    expect((await store.getHistory('7')).map((item) => item.bvid)).toContain('BVseen');
    first.disconnect();

    renderHome();
    const second = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config, onSearchStateChange: (active) => states.push(active) });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(searches).toEqual(['b']);
    expect(Array.from(document.querySelectorAll('[data-favorite-home-fill-label]')).map((node) => node.textContent))
      .toEqual(['收藏标签补位：a', '收藏标签补位：b']);
  });

  it('records only the last two used rounds and reuses the selected tag cache', async () => {
    await store.putSnapshot(cachedSnapshot(['1'], [{ bvid: 'BVfavorite', tags: ['a', 'b', 'c'], favoritedAt: 1 }]));
    const searches: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      const tag = url.searchParams.get('keyword')!;
      searches.push(tag);
      return response({ numPages: 5, result: Array.from({ length: 3 }, (_, index) => ({ bvid: `BV${tag}${index}`, pubdate: 1 })) });
    });
    for (let index = 0; index < 3; index += 1) {
      renderHome();
      const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
      controllers.push(controller);
      await controller.run();
      expect(document.querySelector('[data-favorite-home-fill-label]')?.textContent).toBe('收藏标签补位：a');
      controller.disconnect();
    }
    expect(searches).toEqual(['a']);
    const snapshot = (await store.getSnapshot('7'))!;
    expect(snapshot.recentTagRounds).toEqual([['a'], ['a']]);
    expect(snapshot.nextSearchPages).toEqual({ a: 2 });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config, onNotice });
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config: { ...config, favoriteHomeFillEnabled: false } });
    controllers.push(controller);
    controller.updateConfig({ ...config, favoriteRefreshRequestedAt: Date.now() });
    await controller.run();
    expect(pages).toEqual([5]);
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 1 });
    controller.disconnect();

    for (const page of [1, 2]) {
      renderHome();
      const next = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
    const first = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
    controllers.push(first);
    await first.run();
    await first.run();
    expect(pages).toEqual([3]);
    expect((await store.getSnapshot('7'))?.nextSearchPages).toEqual({ 游戏: 1 });
    first.disconnect();

    renderHome();
    const second = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch,
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
    const controller = createFavoriteHomeFillController({ root: document, rng: () => 0, store, fetch: request as typeof fetch, config });
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch, config,
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
      root: document, rng: () => 0, store, fetch: request as typeof fetch,
      config: { ...config, favoriteFolderIds: ['1', '2'], favoriteFolderLimit: 1 },
    });
    controllers.push(controller);
    await controller.run();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
  });
  it('aborts a pending account lookup without starting collection or saving late results', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let signal: AbortSignal | null | undefined;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return pending; });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteRefreshRequestedAt: Date.now() + 100 } });
    controllers.push(controller);
    const work = controller.run();
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    expect(signal?.aborted).toBe(true);
    release(response({ mid: 7 }));
    await work;
    expect(request).toHaveBeenCalledTimes(1);
    expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('游戏');
    expect(controller.getState().reason).toBe('disabled');
  });

  it('updates preferences while paused on a video page and getTags never starts a refresh', async () => {
    window.history.replaceState({}, '', '/video/BVtest');
    let collections = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      collections += 1;
      return response({ medias: [{ bvid: 'BVnewFavorite', tags: ['新偏好'] }] });
    });
    try {
      const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
        config: { ...config, enabled: false, favoriteRefreshRequestedAt: Date.now() + 100 } });
      controllers.push(controller);
      await controller.run();
      expect(collections).toBe(1);
      expect(controller.getState()).toMatchObject({ phase: 'ready', reason: 'paused', sourceCount: 1, tagCount: 1 });
      expect((await controller.getTags())[0].tag).toBe('新偏好');
      expect(collections).toBe(1);
      expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
    } finally { window.history.replaceState({}, '', '/'); }
  });

  it('rechecks native BVs after search and releases candidates that were not displayed', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      started(); return pending;
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    const work = controller.run();
    await searching;
    document.body.insertAdjacentHTML('beforeend', '<div class="bili-video-card" data-bvid="BVnative"><a href="/video/BVnative">native</a></div>');
    release(response({ numPages: 1, result: [{ bvid: 'BVnative', pubdate: 1 }] }));
    await work;
    expect(document.querySelectorAll('[data-bvid="BVnative"]')).toHaveLength(1);
    expect(await store.getHistory('7')).toEqual([]);
  });

  it('releases a claim when its target disappears during the atomic claim', async () => {
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVcached', pubdate: 1 }] } }, ['游戏']));
    const claim = store.claimHistory.bind(store);
    const alteredStore = { ...store, claimHistory: async (...args: Parameters<typeof store.claimHistory>) => {
      const result = await claim(...args);
      document.querySelector('[data-bvid="BVhidden"]')?.remove();
      return result;
    } };
    const controller = createFavoriteHomeFillController({ root: document, store: alteredStore,
      fetch: vi.fn(async () => response({ mid: 7 })) as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
    expect(await store.getHistory('7')).toEqual([]);
  });

  it('rolls back inserted cards and claims when persisting the completed round fails', async () => {
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVcached', pubdate: 1 }] } }, ['游戏']));
    const alteredStore = { ...store, putSnapshot: vi.fn(async () => { throw new Error('storage unavailable'); }) };
    const controller = createFavoriteHomeFillController({ root: document, store: alteredStore,
      fetch: vi.fn(async () => response({ mid: 7 })) as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
    expect(document.querySelector('[data-bvid="BVhidden"]')).not.toBeNull();
    expect(await store.getHistory('7')).toEqual([]);
    expect(controller.getState()).toMatchObject({ phase: 'error', errorStage: 'storage' });
  });

  it('only enriches the remaining ten videos on the second fixed-size favorite page', async () => {
    let details = 0;
    const sizes: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/nav')) return response({ mid: 7 });
      if (url.pathname.includes('/fav/resource/list')) {
        sizes.push(url.searchParams.get('ps')!);
        const page = url.searchParams.get('pn');
        return response({ has_more: true, medias: Array.from({ length: 40 }, (_, i) => ({ bvid: `BVpage${page}item${i}` })) });
      }
      if (url.pathname.includes('/view/detail')) { details += 1; return response({ Tags: [{ tag_name: '游戏' }] }); }
      return response({ result: [] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
      config: { ...config, enabled: false, favoriteVideoLimit: 50, favoriteRefreshRequestedAt: Date.now() + 100 } });
    controllers.push(controller);
    await controller.run();
    expect(sizes).toEqual(['40', '40']);
    expect(details).toBe(50);
    expect((await store.getSnapshot('7'))?.videos).toHaveLength(50);
  });

  it('retains existing preferences and reports malformed collection responses', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/nav') ? response({ mid: 7 }) : response({ unexpected: [] }));
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteRefreshRequestedAt: Date.now() + 100 } });
    controllers.push(controller);
    await controller.run();
    expect(controller.getState()).toMatchObject({ phase: 'error', errorStage: 'preferences', hasCachedPreferences: true });
    expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('游戏');
  });

  it.each(['missing', 'different-folders', 'different-limit', 'empty-tags', 'invalid-score'] as const)(
    'does not report usable cached preferences after refresh failure with %s cache', async (scenario) => {
      if (scenario === 'missing') await store.clear();
      if (scenario === 'empty-tags' || scenario === 'invalid-score') {
        const snapshot = (await store.getSnapshot('7'))!;
        snapshot.tags = scenario === 'empty-tags' ? [] : snapshot.tags.map((tag) => ({ ...tag, score: 0 }));
        await store.putSnapshot(snapshot);
      }
      const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/nav') ? response({ mid: 7 }) : response({ unexpected: [] }));
      const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
        config: { ...config, favoriteRefreshRequestedAt: Date.now() + 100,
          ...(scenario === 'different-folders' ? { favoriteFolderIds: ['2'] } : {}),
          ...(scenario === 'different-limit' ? { favoriteVideoLimit: 2 } : {}),
        } });
      controllers.push(controller);
      await controller.run();
      expect(controller.getState()).toMatchObject({ phase: 'error', errorStage: 'preferences', hasCachedPreferences: false });
      if (scenario === 'different-folders' || scenario === 'different-limit') {
        expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('游戏');
      }
    },
  );

  it('preserves existing fill cards when effective cutoff advances', async () => {
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVcached', pubdate: 1 }] } }, ['游戏']));
    const controller = createFavoriteHomeFillController({ root: document, store,
      fetch: vi.fn(async () => response({ mid: 7 })) as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    const card = document.querySelector('[data-favorite-home-fill]');
    controller.updateConfig({ ...config, cutoffMinute: '2020-01-01T00:01' });
    await controller.run();
    expect(document.querySelector('[data-favorite-home-fill]')).toBe(card);
  });

  it.each([-1, 0])('finishes one preference read across cutoff advances and checks the latest boundary (%s seconds)', async (offset) => {
    const latestCutoff = '2020-01-01T00:03';
    const pubdate = new Date(latestCutoff).getTime() / 1000 + offset;
    await store.putCandidates('7', normalizeSearchCandidates({ data: { result: [{ bvid: 'BVboundary', pubdate }] } }, ['新偏好']));
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | null | undefined;
    let accounts = 0;
    let collections = 0;
    let searches = 0;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/nav')) { accounts += 1; return response({ mid: 7 }); }
      if (String(input).includes('/fav/resource/list')) {
        collections += 1;
        signal = init?.signal;
        started();
        return pending;
      }
      searches += 1;
      return response({ result: [] });
    });
    const refreshConfig = { ...config, favoriteRefreshRequestedAt: Date.now() + 100 };
    const controller = createFavoriteHomeFillController({ root: document, store, rng: () => 0, fetch: request as typeof fetch, config: refreshConfig });
    controllers.push(controller);
    const work = controller.run();
    await reading;
    for (const minute of ['01', '02', '03']) {
      controller.updateConfig({ ...refreshConfig, cutoffMinute: `2020-01-01T00:${minute}` });
      await Promise.resolve();
      expect(signal?.aborted).toBe(false);
    }
    expect(accounts).toBe(1);
    expect(collections).toBe(1);
    release(response({ medias: [{ bvid: 'BVfavorite', tags: ['新偏好'] }] }));
    await work;
    expect(accounts).toBe(1);
    expect(collections).toBe(1);
    expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('新偏好');
    expect(document.querySelectorAll('[data-favorite-home-fill]')).toHaveLength(offset < 0 ? 1 : 0);
    expect((await store.getHistory('7')).map(({ bvid }) => bvid)).toEqual(offset < 0 ? ['BVboundary'] : []);
    expect(searches).toBeLessThanOrEqual(5);
    if (offset < 0) expect(searches).toBe(0);
  });

  it.each(['not-home', 'paused', 'no-cutoff-change', 'no-cutoff-same'] as const)(
    'keeps the pending preference state across cutoff synchronization in %s', async (scenario) => {
      let release!: (value: Response) => void;
      const pending = new Promise<Response>((resolve) => { release = resolve; });
      let started!: () => void;
      const reading = new Promise<void>((resolve) => { started = resolve; });
      let signal: AbortSignal | null | undefined;
      let accounts = 0;
      let collections = 0;
      const phases: string[] = [];
      const putSnapshot = vi.fn(store.putSnapshot.bind(store));
      const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/nav')) { accounts += 1; return response({ mid: 7 }); }
        collections += 1;
        signal = init?.signal;
        started();
        return pending;
      });
      const refreshConfig = { ...config, favoriteRefreshRequestedAt: Date.now() + 100,
        enabled: scenario !== 'paused',
        cutoffMinute: scenario === 'no-cutoff-same' ? null : config.cutoffMinute,
      };
      if (scenario === 'not-home') window.history.replaceState({}, '', '/video/BVtest');
      try {
        const controller = createFavoriteHomeFillController({ root: document, store: { ...store, putSnapshot },
          fetch: request as typeof fetch, config: refreshConfig, onStateChange: ({ phase }) => phases.push(phase) });
        controllers.push(controller);
        const work = controller.run();
        await reading;
        expect(controller.getState().phase).toBe('updating');
        const synchronized = { ...refreshConfig,
          cutoffMinute: scenario.startsWith('no-cutoff') ? null : '2020-01-01T00:01',
        };
        controller.updateConfig(synchronized);
        controller.updateConfig(synchronized);
        await Promise.resolve();
        expect(controller.getState().phase).toBe('updating');
        expect(phases).toEqual(['updating']);
        expect(signal?.aborted).toBe(false);
        expect(accounts).toBe(1);
        expect(collections).toBe(1);
        expect(putSnapshot).not.toHaveBeenCalled();
        release(response({ medias: [{ bvid: 'BVfavorite', tags: ['新偏好'] }] }));
        await work;
        const reason = scenario.startsWith('no-cutoff') ? 'no-cutoff' : scenario;
        expect(controller.getState()).toMatchObject({ phase: 'ready', reason });
        expect(phases).toEqual(['updating', 'ready']);
        expect(putSnapshot).toHaveBeenCalledOnce();
        expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('新偏好');
        expect(accounts).toBe(1);
        expect(collections).toBe(1);
      } finally { window.history.replaceState({}, '', '/'); }
    },
  );

  it.each(['disable', 'source', 'limit', 'disconnect'] as const)('still cancels preference reads on %s after a cutoff-only update', async (action) => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | null | undefined;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      signal = init?.signal;
      started();
      return pending;
    });
    const refreshConfig = { ...config, favoriteRefreshRequestedAt: Date.now() + 100 };
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config: refreshConfig });
    controllers.push(controller);
    const work = controller.run();
    await reading;
    const advanced = { ...refreshConfig, cutoffMinute: '2020-01-01T00:01' };
    controller.updateConfig(advanced);
    expect(signal?.aborted).toBe(false);
    if (action === 'disconnect') controller.disconnect();
    else controller.updateConfig({ ...advanced,
      ...(action === 'disable' ? { favoriteHomeFillEnabled: false } : {}),
      ...(action === 'source' ? { favoriteFolderIds: ['2'] } : {}),
      ...(action === 'limit' ? { favoriteVideoLimit: 2 } : {}),
    });
    expect(signal?.aborted).toBe(true);
    controller.disconnect();
    release(response({ medias: [{ bvid: 'BVcancelled', tags: ['迟到偏好'] }] }));
    await work;
    expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('游戏');
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
  });

  it('merges repeated continue clicks into one bounded round', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/nav') ? response({ mid: 7 }) : response({ result: [] }));
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    const before = request.mock.calls.length;
    await Promise.all([controller.continueFinding(), controller.continueFinding(), controller.continueFinding()]);
    expect(request.mock.calls.length - before).toBe(2);
  });

  it('does not leak partial search pages or recent tags into the cached snapshot after cancellation', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const secondSearch = new Promise<void>((resolve) => { started = resolve; });
    let searches = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      searches += 1;
      if (searches === 2) { started(); return pending; }
      return response({ numPages: 5, result: [{ bvid: 'BVtooLate', pubdate: 2000000000 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    const work = controller.run();
    await secondSearch;
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    release(response({ numPages: 5, result: [{ bvid: 'BVcancelled', pubdate: 1 }] }));
    await work;
    const snapshot = (await store.getSnapshot('7'))!;
    expect(snapshot.nextSearchPages).toBeUndefined();
    expect(snapshot.recentTagRounds).toBeUndefined();
    expect(await store.getHistory('7')).toEqual([]);
  });

  it('stops starting detail requests when disconnected during enrichment', async () => {
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const detailing = new Promise<void>((resolve) => { started = resolve; });
    let details = 0;
    const signals: AbortSignal[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      if (String(input).includes('/fav/resource/list')) return response({ medias: Array.from({ length: 10 }, (_, i) => ({ bvid: `BVdetail${i}` })) });
      details += 1;
      if (init?.signal) signals.push(init.signal);
      if (details === 3) started();
      return pending;
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
      config: { ...config, favoriteVideoLimit: 10, favoriteRefreshRequestedAt: Date.now() + 100 } });
    controllers.push(controller);
    const work = controller.run();
    await detailing;
    controller.disconnect();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    release(response({ Tags: [{ tag_name: '取消详情' }] }));
    await work;
    expect(details).toBe(3);
    expect((await store.getSnapshot('7'))?.tags[0].tag).toBe('游戏');
  });

  it('reports malformed search responses without claiming empty success', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/nav') ? response({ mid: 7 }) : response({ unexpected: [] }));
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    await controller.run();
    expect(controller.getState()).toMatchObject({ phase: 'error', errorStage: 'search', hasCachedPreferences: true });
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
  });

  it('prioritizes setting the missing cutoff over resuming a paused filter', async () => {
    const request = vi.fn();
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch,
      config: { ...config, enabled: false, cutoffMinute: null } });
    controllers.push(controller);
    await controller.run();
    expect(controller.getState()).toMatchObject({ phase: 'idle', reason: 'no-cutoff' });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps a newly saved preference snapshot unchanged when its first search round is cancelled', async () => {
    await store.clear();
    let release!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let started!: () => void;
    const secondSearch = new Promise<void>((resolve) => { started = resolve; });
    let searches = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/nav')) return response({ mid: 7 });
      if (String(input).includes('/fav/resource/list')) return response({ medias: [{ bvid: 'BVfavorite', tags: ['游戏'] }] });
      searches += 1;
      if (searches === 2) { started(); return pending; }
      return response({ numPages: 5, result: [{ bvid: 'BVtooLate', pubdate: 2000000000 }] });
    });
    const controller = createFavoriteHomeFillController({ root: document, store, fetch: request as typeof fetch, config });
    controllers.push(controller);
    const work = controller.run();
    await secondSearch;
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    release(response({ numPages: 5, result: [{ bvid: 'BVcancelled', pubdate: 1 }] }));
    await work;
    const snapshot = (await store.getSnapshot('7'))!;
    expect(snapshot.tags[0].tag).toBe('游戏');
    expect(snapshot.nextSearchPages).toEqual({});
    expect(snapshot.recentTagRounds).toEqual([]);
    expect(await store.getHistory('7')).toEqual([]);
  });

});
