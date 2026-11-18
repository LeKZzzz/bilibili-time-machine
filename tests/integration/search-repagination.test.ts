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

function searchUrl(page: number, keyword = 'test', conditions: Record<string, string> = {}): string {
  const params = new URLSearchParams({ search_type: 'video', keyword, ...conditions, page: String(page) });
  return `https://api.bilibili.com/x/web-interface/wbi/search/type?${params}`;
}

// 来自匿名真实综合搜索第 2 页；签名、令牌和设备数据仅用测试占位值。
const observedApiParams = {
  category_id: '', pubtime_begin_s: '0', pubtime_end_s: '0', ad_resource: '5654',
  from_spmid: '333.337', web_location: '1430654', source_tag: '3', page_size: '42',
  dynamic_offset: '30', web_roll_page: '1', __refresh__: 'true', _extra: '', context: '',
  platform: 'pc', highlight: '1', single_column: '0', qv_id: 'test-query-id',
  gaia_vtoken: 'test-token', 'x-bili-device-req-json': '{"test":true}',
  'x-bili-locale-json': '{"test":true}', w_rid: 'test-signature', wts: '1',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
    handle.transformVideo(searchUrl(page), next, config);
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

  it('includes result filters while ignoring paging, WBI signatures and tracking fields', () => {
    window.history.replaceState({}, '', '/all?keyword=test&order=click&page=1&o=0&w_rid=a&wts=1&spm_id_from=search');
    const first = readSearchLocation(window.location);
    window.history.replaceState({}, '', '/all?keyword=test&order=pubdate&page=1&o=0&w_rid=b&wts=2&spm_id_from=feed');
    const second = readSearchLocation(window.location);
    expect(first.key).not.toBe(second.key);
    window.history.replaceState({}, '', '/all?keyword=test&order=click&page=2&o=36&w_rid=c&wts=3&spm_id_from=video');
    expect(readSearchLocation(window.location).key).toBe(first.key);
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
  });

  it('accepts only request URLs whose effective conditions and page match the response', () => {
    window.history.replaceState({}, '', '/all?keyword=test&order=click&page=1');
    const pages = { 1: page1() };
    const { handle, requestPage } = mount({ pages });

    expect(handle.transformVideo(searchUrl(1, 'other', { order: 'click' }), pages[1], config)).toBeUndefined();
    expect(handle.transformVideo(searchUrl(1, 'test', { order: 'pubdate' }), pages[1], config)).toBeUndefined();
    expect(handle.transformVideo(searchUrl(2, 'test', { order: 'click' }), pages[1], config)).toBeUndefined();
    expect(requestPage).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('matches the current page against known video-search API defaults and ignores request tracking', async () => {
    window.history.replaceState({}, '', '/all?keyword=test&page=1');
    const pages = {
      1: page1(),
      2: payload(2, [
        { bvid: 'BVdefault2a', pubdate: BEFORE },
        { bvid: 'BVdefault2b', pubdate: BEFORE },
        { bvid: 'BVdefault2c', pubdate: BEFORE },
        { bvid: 'BVdefault2d', pubdate: BEFORE },
      ]),
    };
    const { handle, requestPage } = mount({ pages });
    const apiDefaults = {
      order: 'totalrank',
      order_sort: '0',
      duration: '0',
      tids: '0',
      tids_1: '0',
      tids_2: '0',
      user_type: '0',
      copy_right: '0',
      category_id: '0',
      page_size: '42',
      from_source: 'webtop_search',
      spm_id_from: '333.337.0.0',
      __refresh__: 'true',
      _extra: '',
      context: '',
      highlight: '1',
      single_column: '0',
      platform: 'pc',
      w_rid: 'signature',
      wts: '1',
    };

    expect(handle.transformVideo(searchUrl(1, 'test', apiDefaults), pages[1], config)).toBeUndefined();
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));
    handle.destroy();
  });

  it.each([
    ['空分区', { category_id: '' }, ''],
    ['默认发布时间', { pubtime_begin_s: '0', pubtime_end_s: '0' }, ''],
    ['页面访问标识', {}, '&vt=28028695'],
    ['API位置元数据', { web_location: '1430654' }, ''],
    ['真实完整请求结构', observedApiParams, '&vt=28028695'],
    ['页面空值和默认筛选', observedApiParams, '&category_id=0&duration=&order=totalrank&pubtime_begin_s=&pubtime_end_s=0&vt=28028695'],
    ['API发布时间空值', { pubtime_begin_s: '', pubtime_end_s: '' }, ''],
  ])('接受正常第2页请求：%s', (_label, params, pageMetadata) => {
    window.history.replaceState({}, '', `/all?keyword=动画&page=2&o=30${pageMetadata}`);
    const requestPage = vi.fn(async () => false);
    const handle = createSearchRepagination({ document, target: window, requestPage, readPageSize: () => 4, readPageCount: () => 3 });
    handle.transformVideo(searchUrl(2, '动画', params), page1(), config);
    // 载荷页码也要对应原生第2页。
    expect(requestPage).not.toHaveBeenCalled();
    handle.transformVideo(searchUrl(2, '动画', params), { ...page1(), data: { ...page1().data, page: 2 } }, config);
    expect(requestPage).toHaveBeenCalledExactlyOnceWith(3);
    handle.destroy();
  });

  it.each([
    ['keyword', '其他关键词'], ['order', 'pubdate'], ['order_sort', '1'],
    ['pubtime_begin_s', '1559347200'], ['pubtime_end_s', '1577836799'],
    ['category_id', '1'], ['duration', '2'], ['tids_1', '1'], ['tids_2', '24'],
    ['user_type', '1'], ['copy_right', '1'], ['new_filter', 'enabled'], ['new_empty_filter', ''],
  ])('拒绝不同有效条件并接受对应页面条件：%s', (name, value) => {
    window.history.replaceState({}, '', '/all?keyword=动画&page=2&o=30&vt=28028695');
    const requestPage = vi.fn(async () => false);
    const handle = createSearchRepagination({ document, target: window, requestPage, readPageSize: () => 4, readPageCount: () => 3 });
    const request = new URL(searchUrl(2, '动画', { ...observedApiParams, [name]: value }));
    const secondPage = { ...page1(), data: { ...page1().data, page: 2 } };
    handle.transformVideo(request.href, secondPage, config);
    expect(requestPage).not.toHaveBeenCalled();
    const location = new URL(window.location.href);
    location.searchParams.set(name, value);
    window.history.replaceState({}, '', location);
    handle.transformVideo(request.href, secondPage, config);
    expect(requestPage).toHaveBeenCalledExactlyOnceWith(3);
    handle.destroy();
  });

  it('真实请求结构能完成补齐，旧关键词及不同时间条件的迟到载荷不进入新结果', async () => {
    window.history.replaceState({}, '', '/all?vt=28028695&keyword=动画&page=2&o=30');
    const second = payload(2, [{ bvid: 'BVcurrent', pubdate: BEFORE }, { bvid: 'BVlate', pubdate: AFTER }], 3);
    const third = payload(3, [{ bvid: 'BVthird1', pubdate: BEFORE }, { bvid: 'BVthird2', pubdate: BEFORE }], 3);
    let handle: SearchRepaginationHandle;
    const requestPage = vi.fn(async (page: number) => {
      if (page === 3) handle.transformVideo(searchUrl(3, '动画', observedApiParams), third, config);
      return true;
    });
    handle = createSearchRepagination({ document, target: window, requestPage, readPageSize: () => 4, readPageCount: () => 3 });
    handle.transformVideo(searchUrl(2, '动画', observedApiParams), second, config);
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));
    const old = payload(3, [{ bvid: 'BVstale', pubdate: BEFORE }], 3);
    expect(handle.transformVideo(searchUrl(3, '旧关键词', observedApiParams), old, config)).toBeUndefined();
    expect(handle.transformVideo(searchUrl(3, '动画', { ...observedApiParams, pubtime_end_s: '1577836799' }), old, config)).toBeUndefined();
    const result = handle.transformVideo(searchUrl(2, '动画', observedApiParams), second, config) as typeof second;
    expect(result.data.result.map(item => item.bvid)).toEqual(['BVcurrent', 'BVthird1', 'BVthird2']);
    handle.destroy();
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
        handle.transformVideo(searchUrl(page), page2, config);
        return true;
      },
      writeFooter: () => undefined,
    });
    const first = handle.transformVideo(searchUrl(1), page1, config);
    expect(first).toBeUndefined();
    await vi.waitFor(() => expect(handle.transformVideo(searchUrl(1), page1, config)).toBeDefined());
    const result = handle.transformVideo(searchUrl(1), page1, config) as typeof page1;
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

    const first = handle.transformVideo(searchUrl(1), pages[1], config);
    expect(first).toBeUndefined();

    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(3));

    const reflowed = await vi.waitFor(() => {
      const out = handle.transformVideo(searchUrl(1), pages[1], config);
      expect(out).toBeDefined();
      return out as { data: { result: Array<{ bvid: string }>; page: number; numPages: number } };
    });
    expect(reflowed.data.page).toBe(1);
    expect(reflowed.data.numPages).toBe(2);
    expect(reflowed.data.result.map((item) => item.bvid)).toEqual([
      'BVpage1visible', 'BVpage2a', 'BVpage2b', 'BVpage2c',
    ]);

    const secondPage = handle.transformVideo(searchUrl(2), pages[2], config) as { data: { result: Array<{ bvid: string }> } };
    expect(secondPage.data.result.map((item) => item.bvid)).toEqual(['BVpage2d']);
    handle.destroy();
  });

  it('keeps overlapping keyword probes isolated and does not restore a newer search URL', async () => {
    const oldRequestStarted = deferred<void>();
    const releaseOldRequest = deferred<void>();
    const oldRequestReturned = deferred<void>();
    const oldPage2 = payload(2, [
      { bvid: 'BVoldQuery1', pubdate: BEFORE },
      { bvid: 'BVoldQuery2', pubdate: BEFORE },
      { bvid: 'BVoldQuery3', pubdate: BEFORE },
      { bvid: 'BVoldQuery4', pubdate: BEFORE },
    ]);
    const newPage1 = payload(1, [{ bvid: 'BVnewQuery1', pubdate: BEFORE }]);
    const newPage2 = payload(2, [
      { bvid: 'BVnewQuery2', pubdate: BEFORE },
      { bvid: 'BVnewQuery3', pubdate: BEFORE },
      { bvid: 'BVnewQuery4', pubdate: BEFORE },
      { bvid: 'BVnewQuery5', pubdate: BEFORE },
    ]);
    let handle: SearchRepaginationHandle;
    const requestPage = vi.fn(async (page: number) => {
      const keyword = new URL(window.location.href).searchParams.get('keyword');
      if (keyword === 'old') {
        oldRequestStarted.resolve();
        await releaseOldRequest.promise;
        handle.transformVideo(searchUrl(page, 'old', observedApiParams), oldPage2, config);
        oldRequestReturned.resolve();
      } else if (keyword === 'new' && page === 2) {
        handle.transformVideo(searchUrl(page, 'new', { ...observedApiParams, order: 'click' }), newPage2, config);
      }
      return true;
    });
    handle = createSearchRepagination({
      document,
      target: window,
      requestPage,
      readPageSize: () => 4,
      readPageCount: () => 2,
      now: () => NOW_MS,
      writeFooter: () => undefined,
    });
    handle.apply(config);

    window.history.replaceState({}, '', '/all?keyword=old&page=1&vt=28028695');
    handle.transformVideo(searchUrl(1, 'old', observedApiParams), page1(false), config);
    await oldRequestStarted.promise;

    window.history.replaceState({}, '', '/all?keyword=new&order=click&page=1&vt=31482868');
    const newResult = await vi.waitFor(() => {
      const result = handle.transformVideo(searchUrl(1, 'new', { ...observedApiParams, order: 'click' }), newPage1, config) as { data: { result: Array<{ bvid: string }> } } | undefined;
      expect(result).toBeDefined();
      return result as { data: { result: Array<{ bvid: string }> } };
    });
    expect(newResult.data.result.map((item) => item.bvid)).toEqual([
      'BVnewQuery1', 'BVnewQuery2', 'BVnewQuery3', 'BVnewQuery4',
    ]);

    window.history.replaceState({}, '', '/all?keyword=new&order=click&page=3&spm_id_from=video');
    releaseOldRequest.resolve();
    await oldRequestReturned.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.location.search).toBe('?keyword=new&order=click&page=3&spm_id_from=video');
    const stillNew = handle.transformVideo(searchUrl(1, 'new', { ...observedApiParams, order: 'click' }), newPage1, config) as { data: { result: Array<{ bvid: string }> } };
    expect(stillNew.data.result.map((item) => item.bvid)).toEqual([
      'BVnewQuery1', 'BVnewQuery2', 'BVnewQuery3', 'BVnewQuery4',
    ]);
    handle.destroy();
  });

  it('deduplicates repeated BV ids across pages', async () => {
    const pages = {
      1: payload(1, [{ bvid: 'BVdup', pubdate: BEFORE }, { bvid: 'BVh1', pubdate: AFTER }]),
      2: payload(2, [{ bvid: 'BVdup', pubdate: BEFORE }, { bvid: 'BVh2', pubdate: AFTER }]),
    };
    const { handle, requestPage } = mount({ pages, capacity: 4 });
    handle.transformVideo(searchUrl(1), pages[1], config);
    await vi.waitFor(() => expect(requestPage).toHaveBeenCalledWith(2));

    const reflowed = await vi.waitFor(() => {
      const out = handle.transformVideo(searchUrl(1), pages[1], config) as { data: { result: Array<{ bvid: string }> } } | undefined;
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
        handle.transformVideo(searchUrl(page), pages[1], config);
        return true;
      },
      readPageSize: () => 4,
      readPageCount: () => 9,
      now: () => NOW_MS,
      onNotice: (reason) => notices.push(reason),
      writeFooter: () => undefined,
    });
    handle.apply(config);
    const out = handle.transformVideo(searchUrl(1), pages[1], config);
    expect(out).toBeUndefined();
    await vi.waitFor(() => expect(notices).toContain('repagination-failed'));
    // 失败后仍返回 undefined，由现有逐页过滤接管。
    expect(handle.transformVideo(searchUrl(1), pages[1], config)).toBeUndefined();
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
