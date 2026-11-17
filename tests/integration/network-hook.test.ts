/** @vitest-environment jsdom */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { filterVideoPayloadDetailed, installNetworkHook } from '../../src/page/network-hook';

const config = {
  cutoffMinute: '2020-01-01T00:00',
  enabled: true,
  supplementBudget: 20,
  debug: false,
} as const;

class FakeXhr extends EventTarget {
  static instances: FakeXhr[] = [];
  responseType = '';
  readyState = 0;
  private rawText = '';
  private rawResponse: unknown = '';
  url = '';

  get responseText(): string {
    if (this.responseType && this.responseType !== 'text') throw new DOMException('Invalid response type', 'InvalidStateError');
    return this.rawText;
  }

  get response(): unknown {
    return this.responseType === 'json' && this.readyState !== 4 ? null : this.rawResponse;
  }

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(_method: string, url: string | URL): void {
    this.url = String(url);
    this.readyState = 1;
    this.rawText = '';
    this.rawResponse = this.responseType === 'json' ? null : '';
    this.dispatchEvent(new Event('readystatechange'));
  }

  send(): void {
    // 测试显式调用 complete 模拟网络响应。
  }

  progress(body: string): void {
    this.rawText = body;
    this.rawResponse = body;
    this.readyState = 3;
    this.dispatchEvent(new Event('readystatechange'));
  }

  complete(body: string | unknown): void {
    this.rawText = typeof body === 'string' ? body : JSON.stringify(body);
    if (this.responseType === 'json') {
      this.rawResponse = typeof body === 'string' ? JSON.parse(body) as unknown : body;
    } else this.rawResponse = this.rawText;
    this.readyState = 4;
    this.dispatchEvent(new Event('readystatechange'));
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
}

const originalXhr = window.XMLHttpRequest;
const originalFakeOpen = FakeXhr.prototype.open;
afterEach(() => {
  window.XMLHttpRequest = originalXhr;
  FakeXhr.prototype.open = originalFakeOpen;
  FakeXhr.instances.length = 0;
});

function install() {
  window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  return installNetworkHook({
    target: window,
    config,
    fetch: (async () => new Response('{}')) as typeof fetch,
  });
}

describe('page network hook XHR JSON responses', () => {
  it('restores the original XHR open when its wrapper is still current', () => {
    const originalOpen = FakeXhr.prototype.open;
    const handle = install();

    expect(FakeXhr.prototype.open).not.toBe(originalOpen);
    handle.uninstall();
    expect(FakeXhr.prototype.open).toBe(originalOpen);
  });

  it('uninstall preserves an XHR open wrapper installed afterward', () => {
    const handle = install();
    const hookOpen = FakeXhr.prototype.open;
    const laterOpenCalled = vi.fn();
    const laterOpen = function(this: FakeXhr, method: string, url: string | URL): void {
      laterOpenCalled();
      hookOpen.call(this, method, url);
    };
    FakeXhr.prototype.open = laterOpen;

    handle.uninstall();

    expect(FakeXhr.prototype.open).toBe(laterOpen);
    const xhr = new FakeXhr();
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    expect(laterOpenCalled).toHaveBeenCalledOnce();
    expect(xhr.url).toBe('https://api.bilibili.com/x/v2/reply?oid=1');
  });

  it('同步过滤评论 JSON XHR 响应', () => {
    const handle = install();
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.send();
    xhr.complete([
      { rpid: 1, ctime: 1546300800, content: { message: 'before' } },
      { rpid: 2, ctime: 1609459200, content: { message: 'after' } },
    ]);

    expect(xhr.constructor.name).toBe('FakeXhr');
    expect(xhr.responseText).not.toBe('[object Object]');
    expect(JSON.parse(xhr.responseText)).toHaveLength(1);
    expect(JSON.parse(xhr.responseText)[0].rpid).toBe(1);
    handle.uninstall();
  });

  it('同步过滤视频 JSON XHR 响应并支持 responseType=json', () => {
    const handle = install();
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.responseType = 'json';
    xhr.open('GET', 'https://api.bilibili.com/x/web-interface/search?keyword=test');
    xhr.send();
    xhr.complete({ data: { result: [
      { bvid: 'BVbefore', pubdate: 1546300800 },
      { bvid: 'BVafter', pubdate: 1609459200 },
    ] } });

    expect((xhr.response as { data: { result: Array<{ bvid: string }> } }).data.result.map((item) => item.bvid))
      .toEqual(['BVbefore']);
    expect(() => xhr.responseText).toThrowError(expect.objectContaining({ name: 'InvalidStateError' }));
    handle.uninstall();
  });

  it('同步过滤动态 JSON XHR 响应并保留分页元数据', () => {
    const handle = install();
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=all');
    xhr.send();
    xhr.complete({ data: { offset: 'next', has_more: true, items: [
      { id_str: 'old', modules: { module_author: { pub_ts: 1546300800 } } },
      { id_str: 'new', modules: { module_author: { pub_ts: 1609459200 } } },
    ] } });

    const payload = JSON.parse(xhr.responseText) as { data: { offset: string; items: Array<{ id_str: string }> } };
    expect(payload.data.offset).toBe('next');
    expect(payload.data.items.map((item) => item.id_str)).toEqual(['old']);
    handle.uninstall();
  });

  it('JSON 解析失败时严格返回空响应', () => {
    const notices: string[] = [];
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const handle = installNetworkHook({
      target: window,
      config,
      fetch: (async () => new Response('{}')) as typeof fetch,
      onNotice: (reason) => notices.push(reason),
    });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.send();
    xhr.complete('{invalid-json');

    expect(xhr.responseText).toBe('');
    expect(xhr.response).toBe('');
    expect(notices).toContain('parse-failed');
    handle.uninstall();
  });

  it('异步配置就绪后仍替换 JSON XHR 响应', async () => {
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    let resolveConfig!: (value: typeof config) => void;
    const configReady = new Promise<typeof config>((resolve) => { resolveConfig = resolve; });
    const handle = installNetworkHook({
      target: window,
      getConfig: () => configReady,
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.send();
    xhr.complete([
      { rpid: 1, ctime: 1546300800 },
      { rpid: 2, ctime: 1609459200 },
    ]);
    expect(JSON.parse(xhr.responseText)).toEqual([]);
    resolveConfig(config);

    await vi.waitFor(() => expect(JSON.parse(xhr.responseText)).toHaveLength(1));
    handle.uninstall();
  });

  it.each(['text', 'json'] as const)('在所有消费事件前同步处理 %s，关闭过滤立即恢复原响应', (responseType) => {
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    let current = { ...config, enabled: true };
    const handle = installNetworkHook({
      target: window,
      getConfig: () => current,
      fetch: (async () => new Response('{}')) as typeof fetch,
    });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    const seen: Array<{ event: string; ids: number[] }> = [];
    const consume = (event: string): void => {
      const payload = (responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText)) as Array<{ rpid: number }>;
      seen.push({ event, ids: payload.map((comment) => comment.rpid) });
    };
    xhr.addEventListener('readystatechange', () => { if (xhr.readyState === 4) consume('readyState4'); });
    xhr.addEventListener('load', () => consume('load-before-send'));
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.responseType = responseType;
    xhr.send();
    xhr.addEventListener('load', () => consume('load-after-send'));
    xhr.addEventListener('loadend', () => consume('loadend'));
    const body = [{ rpid: 1, ctime: 1546300800 }, { rpid: 2, ctime: 1609459200 }];
    xhr.complete(body);
    expect(seen).toEqual(['readyState4', 'load-before-send', 'load-after-send', 'loadend'].map((event) => ({ event, ids: [1] })));
    current = { ...current, enabled: false };
    consume('disabled');
    expect(seen.at(-1)?.ids).toEqual([1, 2]);

    seen.length = 0;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=2');
    xhr.send();
    xhr.complete(body);
    expect(seen).toHaveLength(4);
    expect(seen.every((item) => item.ids.join(',') === '1,2')).toBe(true);
    handle.uninstall();
  });

  it.each(['text', 'json'] as const)('异步配置未就绪时 %s 消费者收到可解析空列表及原分页信息', async (responseType) => {
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    let resolveConfig!: (value: { enabled: boolean } & Omit<typeof config, 'enabled'>) => void;
    const ready = new Promise<{ enabled: boolean } & Omit<typeof config, 'enabled'>>((resolve) => { resolveConfig = resolve; });
    const handle = installNetworkHook({ target: window, getConfig: () => ready, fetch: (async () => new Response('{}')) as typeof fetch });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    let consumed: unknown;
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState === 4) consumed = responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText);
    });
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.responseType = responseType;
    xhr.send();
    const body = { code: 0, data: { cursor: { next: 2 }, replies: [{ rpid: 2, ctime: 1609459200 }], top_replies: [{ rpid: 3, ctime: 1609459200 }] } };
    xhr.complete(body);
    expect(consumed).toEqual({ code: 0, data: { cursor: { next: 2 }, replies: [], top_replies: [] } });
    resolveConfig({ ...config, enabled: false });
    await vi.waitFor(() => expect(responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText)).toEqual(body));
    handle.uninstall();
  });

  it.each([
    ['config', 'text', true], ['config', 'text', false], ['config', 'json', true], ['config', 'json', false],
    ['getConfig', 'text', true], ['getConfig', 'text', false], ['getConfig', 'json', true], ['getConfig', 'json', false],
  ] as const)('%s Promise 在响应前就绪时，%s 首次消费者直接得到 enabled=%s 的结果', async (source, responseType, enabled) => {
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const ready = Promise.resolve({ ...config, enabled });
    const notices: string[] = [];
    const handle = installNetworkHook({
      target: window,
      ...(source === 'config' ? { config: ready } : { getConfig: () => ready }),
      fetch: (async () => new Response('{}')) as typeof fetch,
      onNotice: (reason) => notices.push(reason),
    });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    const seen: number[][] = [];
    const consume = (): void => {
      const payload = (responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText)) as Array<{ rpid: number }>;
      seen.push(payload.map((comment) => comment.rpid));
    };
    xhr.addEventListener('readystatechange', () => { if (xhr.readyState === 4) consume(); });
    xhr.addEventListener('load', () => consume());
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.responseType = responseType;
    xhr.send();
    xhr.addEventListener('load', () => consume());
    xhr.addEventListener('loadend', consume);
    await Promise.resolve();
    xhr.complete([{ rpid: 1, ctime: 1546300800 }, { rpid: 2, ctime: 1609459200 }]);
    expect(seen).toEqual(Array.from({ length: 4 }, () => enabled ? [1] : [1, 2]));
    expect(notices).not.toContain('config-pending');
    handle.uninstall();
  });

  it.each(['throw', 'reject'] as const)('配置读取 %s 时隐藏已识别列表并提示失败', async (failure) => {
    window.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const notices: string[] = [];
    const failed = Promise.reject(new Error('unavailable'));
    void failed.catch(() => undefined);
    const handle = installNetworkHook({
      target: window,
      getConfig: () => { if (failure === 'throw') throw new Error('unavailable'); return failed; },
      fetch: (async () => new Response('{}')) as typeof fetch,
      onNotice: (reason) => notices.push(reason),
    });
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.send();
    xhr.complete({ data: { replies: [{ rpid: 1, ctime: 1546300800 }], cursor: { next: 2 } } });
    expect(JSON.parse(xhr.responseText)).toEqual({ data: { replies: [], cursor: { next: 2 } } });
    await vi.waitFor(() => expect(notices).toContain('config-read-failed'));
    expect(JSON.parse(xhr.responseText).data.replies).toEqual([]);
    handle.uninstall();
  });

  it('隐藏加载中的受控文本，复用为未识别请求后保留原始正文', () => {
    const handle = install();
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr;
    xhr.open('GET', 'https://api.bilibili.com/x/v2/reply?oid=1');
    xhr.send();
    xhr.progress('[{"rpid":2,"ctime":1609459200}');
    expect(xhr.responseText).toBe('');
    expect(xhr.response).toBe('');
    xhr.complete([{ rpid: 2, ctime: 1609459200 }]);
    expect(JSON.parse(xhr.responseText)).toEqual([]);
    xhr.open('GET', 'https://api.bilibili.com/unrelated');
    xhr.send();
    xhr.complete('unchanged');
    expect(xhr.responseText).toBe('unchanged');
    expect(xhr.response).toBe('unchanged');
    handle.uninstall();
  });
});

describe('filterVideoPayloadDetailed', () => {
  it('reports total and kept record counts without changing the payload', () => {
    const outcome = filterVideoPayloadDetailed({ data: { result: [
      { bvid: 'BVbefore', pubdate: 1546300800 },
      { bvid: 'BVafter', pubdate: 1609459200 },
    ] } }, config);
    expect(outcome.total).toBe(2);
    expect(outcome.kept).toBe(1);
    expect((outcome.payload as { data: { result: Array<{ bvid: string }> } }).data.result.map((item) => item.bvid))
      .toEqual(['BVbefore']);
  });

  it('bypasses and reports zero when filtering is disabled', () => {
    const value = [{ bvid: 'BV1', pubdate: 1609459200 }];
    const outcome = filterVideoPayloadDetailed(value, { ...config, enabled: false });
    expect(outcome).toEqual({ payload: value, total: 0, kept: 0 });
  });
});

describe('video response delegation', () => {
  it('lets a filterVideoResponse delegate replace the payload without per-page filtering', async () => {
    const seen: Array<{ url: string; enabled: boolean }> = [];
    const handle = installNetworkHook({
      target: window,
      config,
      fetch: (async () => new Response('{}')) as typeof fetch,
      filterVideoResponse: (url, payload, cfg) => {
        seen.push({ url, enabled: cfg.enabled });
        expect(String(url)).toContain('/x/web-interface/wbi/search/type');
        return { data: { result: [{ bvid: 'BVdelegated' }] } };
      },
    });
    const response = await window.fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?keyword=test&page=1');
    const body = await response.json() as { data: { result: Array<{ bvid: string }> } };
    expect(seen).toHaveLength(1);
    expect(body.data.result).toEqual([{ bvid: 'BVdelegated' }]);
    handle.uninstall();
  });

  it('falls back to per-page filtering when the delegate returns undefined', async () => {
    const handle = installNetworkHook({
      target: window,
      config,
      fetch: (async () => new Response(JSON.stringify({ data: { result: [
        { bvid: 'BVbefore', pubdate: 1546300800 },
        { bvid: 'BVafter', pubdate: 1609459200 },
      ] } }))) as typeof fetch,
      filterVideoResponse: () => undefined,
    });
    const response = await window.fetch('https://api.bilibili.com/x/web-interface/wbi/search/type?keyword=test');
    const body = await response.json() as { data: { result: Array<{ bvid: string }> } };
    expect(body.data.result.map((item) => item.bvid)).toEqual(['BVbefore']);
    handle.uninstall();
  });
});
