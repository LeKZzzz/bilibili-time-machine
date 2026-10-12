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
  responseText = '';
  response: unknown = '';
  url = '';

  constructor() {
    super();
    FakeXhr.instances.push(this);
  }

  open(_method: string, url: string | URL): void {
    this.url = String(url);
  }

  send(): void {
    // 测试显式调用 complete 模拟网络响应。
  }

  complete(body: string | unknown): void {
    if (this.responseType === 'json') {
      this.response = body;
      this.responseText = JSON.stringify(body);
    } else {
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.response = this.responseText;
    }
    this.dispatchEvent(new Event('load'));
  }
}

const originalXhr = window.XMLHttpRequest;
afterEach(() => {
  window.XMLHttpRequest = originalXhr;
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
    expect(JSON.parse(xhr.responseText).data.result).toHaveLength(1);
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
    expect(xhr.responseText).toBe('');
    resolveConfig(config);

    await vi.waitFor(() => expect(JSON.parse(xhr.responseText)).toHaveLength(1));
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
