/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://search.bilibili.com/all?keyword=test&page=1" }
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  collectSearchPayload,
  createSearchRepagination,
  createNativePageDriver,
  readSearchLocation,
  writeSearchFooter,
  type SearchRepaginationHandle,
} from '../../src/runtime/search-repagination';

const CUTOFF = '2020-01-01T00:00';
/** 2019-06-01T00:00:00Z，早于 CUTOFF。 */
const BEFORE = 1559347200;
/** 2025-01-01T00:00:00Z，晚于 CUTOFF。 */
const AFTER = 1735689600;
const NOW_MS = 1609459200000; // 2021-01-01，晚于 BEFORE、早于 AFTER，使 AFTER 成为未来值。

const config = { cutoffMinute: CUTOFF, enabled: true, supplementBudget: 20, debug: false } as const;

function payload(page: number, specs: Array<{ bvid: string; pubdate?: number }>, numPages = 9) {
  return {
    code: 0,
    data: {
      page,
      numPages,
      numResults: 180,
      result: specs.map((spec) => (spec.pubdate === undefined ? { bvid: spec.bvid } : { bvid: spec.bvid, pubdate: spec.pubdate })),
    },
  };
}

function mount(options: { pages: Record<number, ReturnType<typeof payload> | undefined>; capacity?: number; fail?: number }) {
  let handle: SearchRepaginationHandle;
  const target = window;
  const requestPage = vi.fn(async (page: number) => {
    if (options.fail === page) return false;
    const next = options.pages[page];
    if (!next) return false;
    handle.transformVideo(`https://search.bilibili.com/all?keyword=test&page=${page}`, next, config);
    return true;
  });
  handle = createSearchRepagination({
    document,
    target,
    requestPage,
    readPageSize: () => options.capacity ?? 4,
    readPageCount: () => 9,
    now: () => NOW_MS,
    writeFooter: () => undefined,
  });
  handle.apply(config);
  return { handle, requestPage };
}

function page1(sparse = true) {
  return payload(1, sparse
    ? [{ bvid: 'BVpage1visible', pubdate: BEFORE }, { bvid: 'BVlate1', pubdate: AFTER }, { bvid: 'BVlate2', pubdate: AFTER }, { bvid: 'BVlate3', pubdate: AFTER }]
    : [{ bvid: 'BVpage1visible', pubdate: BEFORE }]);
}

describe('search repagination runtime', () => {
  beforeEach(() => {
    delete (window as Window & { __bilibiliTimeFilterSearchRepagination?: unknown }).__bilibiliTimeFilterSearchRepagination;
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
    document.body.innerHTML = '';
  });

  it('parses wrapped payloads and location parameters', () => {
    const parsed = collectSearchPayload({ code: 0, data: { page: 3, numPages: 7, result: [{ bvid: 'BV1' }] } });
    expect(parsed.page).toBe(3);
    expect(parsed.numPages).toBe(7);
    expect(parsed.items).toHaveLength(1);

    window.history.replaceState({}, '', '/all?keyword=hello&page=4');
    const loc = readSearchLocation(window.location);
    expect(loc.page).toBe(4);
    expect(loc.keyword).toBe('hello');
    expect(loc.pageParam).toBe('4');
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
  });

  it('extracts the video group from the all/v2 response without flattening other groups', () => {
    const parsed = collectSearchPayload({ code: 0, data: {
      page: 1,
      numPages: 28,
      result: [
        { result_type: 'activity', data: [{ id: 'activity-1' }] },
        { result_type: 'video', data: [{ bvid: 'BV1', pubdate: BEFORE }, { bvid: 'BV2', pubdate: AFTER }] },
      ],
    } });
    expect(parsed.items.map((item) => (item as { bvid: string }).bvid)).toEqual(['BV1', 'BV2']);
    expect(parsed.page).toBe(1);
    expect(parsed.numPages).toBe(28);
  });

  it('includes stable search filters in the cache key while ignoring paging and WBI fields', () => {
    window.history.replaceState({}, '', '/all?keyword=test&order=click&page=1&o=0&w_rid=a&wts=1');
    const first = readSearchLocation(window.location);
    window.history.replaceState({}, '', '/all?keyword=test&order=pubdate&page=1&o=0&w_rid=b&wts=2');
    const second = readSearchLocation(window.location);
    expect(first.key).not.toBe(second.key);
    window.history.replaceState({}, '', '/all?keyword=test&order=click&page=2&o=36&w_rid=c&wts=3');
    expect(readSearchLocation(window.location).key).toBe(first.key);
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
  });

  it('reflows the all/v2 video group while preserving activity groups', async () => {
    const wrapped = (page: number, entries: Array<{ bvid: string; pubdate: number }>) => ({
      code: 0,
      data: {
        page,
        numPages: 28,
        result: [
          { result_type: 'activity', data: [{ id: 'activity-1' }] },
          { result_type: 'video', data: entries },
        ],
      },
    });
    let handle: SearchRepaginationHandle;
    const page1 = wrapped(1, [{ bvid: 'BVold', pubdate: BEFORE }, { bvid: 'BVlate', pubdate: AFTER }]);
    const page2 = wrapped(2, [{ bvid: 'BVnext', pubdate: BEFORE }, { bvid: 'BVnext2', pubdate: BEFORE }]);
    handle = createSearchRepagination({
      document,
      target: window,
      readPageSize: () => 4,
      readPageCount: () => 28,
      now: () => NOW_MS,
      requestPage: async (page) => {
        handle.transformVideo(`https://search.bilibili.com/all?page=${page}`, page2, config);
        return true;
      },
      writeFooter: () => undefined,
    });
    const first = handle.transformVideo('https://search.bilibili.com/all?page=1', page1, config);
    expect(first).toBeUndefined();
    await vi.waitFor(() => expect(handle.transformVideo('https://search.bilibili.com/all?page=1', page1, config)).toBeDefined());
    const result = handle.transformVideo('https://search.bilibili.com/all?page=1', page1, config) as typeof page1;
    expect(result.data.result[0]).toEqual(page1.data.result[0]);
    expect((result.data.result[1] as { data: Array<{ bvid: string }> }).data.map((item) => item.bvid)).toEqual(['BVold', 'BVnext', 'BVnext2']);
    handle.destroy();
  });

  it('bypasses when filtering is disabled or the route is not search', () => {
    const { handle } = mount({ pages: { 1: page1() } });
    const out = handle.transformVideo('https://search.bilibili.com/all?page=1', page1(), { ...config, enabled: false });
    expect(out).toBeUndefined();
    handle.destroy();
  });

  it('probes at most two later pages, compacts results and exposes reflowed slices', async () => {
    const pages = {
      1: page1(),
      2: payload(2, [
        { bvid: 'BVpage2a', pubdate: BEFORE },
        { bvid: 'BVpage2b', pubdate: BEFORE },
        { bvid: 'BVpage2c', pubdate: BEFORE },
        { bvid: 'BVpage2d', pubdate: BEFORE },
      ]),
      3: payload(3, [{ bvid: 'BVpage3a', pubdate: AFTER }]),
    };
    const { handle, requestPage } = mount({ pages, capacity: 4 });

    const first = handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config);
    expect(first).toBeUndefined();

    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(3));

    const reflowed = await vi.waitFor(() => {
      const out = handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config);
      expect(out).toBeDefined();
      return out as { data: { result: Array<{ bvid: string }>; page: number; numPages: number } };
    });
    expect(reflowed.data.page).toBe(1);
    expect(reflowed.data.numPages).toBe(2);
    expect(reflowed.data.result.map((item) => item.bvid)).toEqual([
      'BVpage1visible', 'BVpage2a', 'BVpage2b', 'BVpage2c',
    ]);

    const secondPage = handle.transformVideo('https://search.bilibili.com/all?page=2', pages[2], config) as { data: { result: Array<{ bvid: string }> } };
    expect(secondPage.data.result.map((item) => item.bvid)).toEqual(['BVpage2d']);
    handle.destroy();
  });

  it('deduplicates repeated BV ids across pages', async () => {
    const pages = {
      1: payload(1, [{ bvid: 'BVdup', pubdate: BEFORE }, { bvid: 'BVh1', pubdate: AFTER }]),
      2: payload(2, [{ bvid: 'BVdup', pubdate: BEFORE }, { bvid: 'BVh2', pubdate: AFTER }]),
    };
    const { handle, requestPage } = mount({ pages, capacity: 4 });
    handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config);
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));

    const reflowed = await vi.waitFor(() => {
      const out = handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config) as { data: { result: Array<{ bvid: string }> } } | undefined;
      expect(out).toBeDefined();
      return out as { data: { result: Array<{ bvid: string }> } };
    });
    expect(reflowed.data.result.map((item) => item.bvid)).toEqual(['BVdup']);
    handle.destroy();
  });

  it('safely falls back to per-page filtering when a native request fails', async () => {
    const notices: string[] = [];
    let handle: SearchRepaginationHandle;
    const pages = { 1: page1() };
    handle = createSearchRepagination({
      document,
      target: window,
      requestPage: async (page) => {
        if (page === 2) return false;
        handle.transformVideo(`https://search.bilibili.com/all?page=${page}`, pages[1], config);
        return true;
      },
      readPageSize: () => 4,
      readPageCount: () => 9,
      now: () => NOW_MS,
      onNotice: (reason) => notices.push(reason),
      writeFooter: () => undefined,
    });
    handle.apply(config);
    const out = handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config);
    expect(out).toBeUndefined();
    await vi.waitFor(() => expect(notices).toContain('repagination-failed'));
    // 失败后仍返回 undefined，由现有逐页过滤接管。
    expect(handle.transformVideo('https://search.bilibili.com/all?page=1', pages[1], config)).toBeUndefined();
    handle.destroy();
  });

  it('refuses to rewrite signed URLs in the default native driver', async () => {
    window.history.replaceState({}, '', '/all?keyword=test&page=1&w_rid=abc&wts=123');
    document.body.innerHTML = '';
    const driver = createNativePageDriver(window, document);
    expect(await driver(2)).toBe(false);
    expect(window.location.search).toContain('w_rid=abc');
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
  });

  it('rewrites the visible footer total and page count without touching page buttons', () => {
    document.body.innerHTML = '<div class="vui_pagenation"><span class="search-page-count">共 180 条</span><button aria-label="第 1 页">1</button><button aria-label="第 2 页">2</button><button aria-label="第 3 页">3</button><button aria-label="下一页">下一页</button></div>';
    writeSearchFooter(document, 6, 2);
    const footer = document.querySelector('.vui_pagenation') as HTMLElement;
    expect(footer.querySelector('.search-page-count')?.textContent).toBe('共 6 条');
    expect(footer.getAttribute('data-search-reflow-pages')).toBe('2');
    expect((footer.querySelector('[aria-label="第 3 页"]') as HTMLElement).hidden).toBe(true);
    expect((footer.querySelector('[aria-label="下一页"]') as HTMLElement).hidden).toBe(false);
    document.body.innerHTML = '';
  });
});
