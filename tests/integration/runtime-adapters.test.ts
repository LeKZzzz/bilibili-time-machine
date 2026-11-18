import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import comments from '../fixtures/core-comments.json';
import xml from '../fixtures/core-danmaku.xml?raw';
import { adaptCommentPayload, adaptCommentResponse } from '../../src/page/comment-adapter';
import { adaptDanmakuResponse } from '../../src/page/danmaku-adapter';
import { adaptDynamicPayload } from '../../src/page/dynamic-adapter';
import { matchSupportedRoute } from '../../src/routes/match';
import { createConfigStore, createMemoryConfigStorage } from '../../src/runtime/config-store';
import { isBridgeMessage, parseBridgeMessage, serializeBridgeMessage } from '../../src/runtime/bridge-protocol';
import { cutoffEndSeconds, nativeStartSeconds } from '../../src/runtime/native-search-filter';

type TestDom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => TestDom;
};

const config = { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false } as const;

describe('runtime adapters', () => {
  it('limits hooks to the documented B 站 hosts and routes', () => {
    expect(matchSupportedRoute({ hostname: 'www.bilibili.com', pathname: '/video/BV1abc' }).kind).toBe('video');
    expect(matchSupportedRoute({ hostname: 'search.bilibili.com', pathname: '/all' }).kind).toBe('search');
    expect(matchSupportedRoute({ hostname: 'space.bilibili.com', pathname: '/123/video' }).kind).toBe('space-videos');
    expect(matchSupportedRoute({ hostname: 't.bilibili.com', pathname: '/' }).kind).toBe('dynamic');
    expect(matchSupportedRoute({ hostname: 'space.bilibili.com', pathname: '/123/dynamic' }).kind).toBe('dynamic');
    expect(matchSupportedRoute({ hostname: 'evil.example', pathname: '/video/BV1abc' }).installHook).toBe(false);
    expect(matchSupportedRoute({ hostname: 'www.bilibili.com', pathname: '/dynamic' }).supported).toBe(false);
  });

  it('validates the small bridge protocol without carrying arbitrary fields', () => {
    const message = { type: 'time-filter/config-update' as const, config: { ...config, favoriteFolderUid: '7' } };
    const encoded = serializeBridgeMessage(message);
    expect(parseBridgeMessage(encoded)).toEqual(message);
    expect(isBridgeMessage({ type: 'time-filter/notice', reason: 'parse-failed', message: 'safe' })).toBe(true);
    expect(isBridgeMessage({ type: 'time-filter/notice', reason: 'parse-failed', message: 'https://x/?token=secret\n' })).toBe(false);
    expect(parseBridgeMessage('{"type":"unknown"}')).toBeNull();
  });

  it('accepts MV3 config updates only from the same window and origin', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.bilibili.com/unmatched-route' });
    const target = dom.window;
    vi.stubGlobal('window', target);
    vi.stubGlobal('document', target.document);
    vi.stubGlobal('CustomEvent', target.CustomEvent);
    vi.doMock('../../src/playback/bridge', () => ({ installPlaybackBridgeHost: vi.fn() }));
    vi.doMock('../../src/page/initial-state', () => ({ scanRenderedMainVideo: vi.fn() }));

    try {
      vi.resetModules();
      await import('../../src/runtime/mv3-main-world');
      const config = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
      const data = { type: 'time-filter/config-update', config };
      const pageWindow = target as unknown as Window;

      target.dispatchEvent(new target.MessageEvent('message', {
        data, origin: 'https://foreign.example', source: target,
      }));
      target.dispatchEvent(new target.MessageEvent('message', {
        data, origin: target.location.origin, source: null,
      }));
      expect(pageWindow.__BILIBILI_TIME_FILTER_CONFIG__).toBeUndefined();

      target.dispatchEvent(new target.MessageEvent('message', {
        data, origin: target.location.origin, source: target,
      }));
      expect(pageWindow.__BILIBILI_TIME_FILTER_CONFIG__).toEqual(config);
    } finally {
      vi.doUnmock('../../src/playback/bridge');
      vi.doUnmock('../../src/page/initial-state');
      vi.unstubAllGlobals();
      vi.resetModules();
      target.close();
    }
  });

  it('persists normalized configuration through an injected storage adapter', async () => {
    const store = createConfigStore(createMemoryConfigStorage());
    await store.saveConfig({ cutoffMinute: '2026-09-22T12:30', enabled: true, supplementBudget: 999, debug: true, favoriteFolderUid: '7' });
    expect(await store.loadConfig()).toMatchObject({ cutoffMinute: '2026-09-22T12:30', enabled: true, supplementBudget: 100, debug: true, favoriteFolderUid: '7' });
    await store.clearConfig();
    expect(await store.loadConfig()).toMatchObject(config);
  });

  it('filters current comment and XML payloads while preserving outer metadata', () => {
    const filtered = adaptCommentPayload(comments, { cutoff: 1760000060, enabled: true, nowSeconds: 1760000200 });
    expect(filtered.handled).toBe(true);
    expect((filtered.payload as typeof comments).data.all_count).toBe(4);
    expect((filtered.payload as typeof comments).data.replies).toHaveLength(1);

    const danmaku = adaptDanmakuResponse('https://api.bilibili.com/x/v1/dm/list.xml', xml, {
      cutoff: 1760000060,
      enabled: true,
      nowSeconds: 1760000200,
    });
    expect(danmaku.handled).toBe(true);
    expect(danmaku.result.ok).toBe(true);
    expect(danmaku.result.xml).toContain('before');
    expect(danmaku.result.xml).not.toContain('exact');
  });

  it('filters flat root/parent comment responses while preserving pagination metadata', () => {
    const response = {
      code: 0,
      data: {
        replies: [
          { rpid: 1, ctime: 1760000100, root: 0, parent: 0 },
          { rpid: 11, ctime: 1759999000, root: 1, parent: 1 },
          { rpid: 2, ctime: 1759999000, root: 0, parent: 0 },
          { rpid: 21, ctime: 1760000100, root: 2, parent: 2 },
        ],
        all_count: 4,
        cursor: { next: 2 },
      },
    };

    const result = adaptCommentPayload(response, { cutoff: 1760000060, enabled: true, nowSeconds: 1760000200 });
    expect(result.handled).toBe(true);
    expect(result.hiddenCount).toBe(3);
    expect(result.payload.data.all_count).toBe(4);
    expect(result.payload.data.cursor).toEqual({ next: 2 });
    expect(result.payload.data.replies.map((comment: { rpid: number }) => comment.rpid)).toEqual([2]);
  });

  it.each([adaptCommentPayload, adaptCommentResponse])('过滤所有并存评论列表及子回复，保留分页信息与输入', (adapt) => {
    const list = [
      { rpid: 1, ctime: 1759999000, replies: [{ rpid: 11, ctime: 1759999000 }, { rpid: 12, ctime: 1760000060 }] },
      { rpid: 2, ctime: 1760000060 },
      { rpid: 3, ctime: 1760000100, replies: [{ rpid: 31, ctime: 1759999000 }] },
      { rpid: 4 },
    ];
    const response = { code: 0, data: { replies: list, top_replies: list, comments: list, repliesList: list, all_count: 99, cursor: { next: 2 } } };
    const result = adapt(response, { cutoff: 1760000060, enabled: true, nowSeconds: 1760000200 });
    expect(result).toMatchObject({ handled: true, totalCount: 28, visibleCount: 8, hiddenCount: 20 });
    for (const key of ['replies', 'top_replies', 'comments', 'repliesList'] as const) {
      expect(result.payload.data[key]).toEqual([{ rpid: 1, ctime: 1759999000, replies: [{ rpid: 11, ctime: 1759999000 }] }]);
      expect(response.data[key]).toHaveLength(4);
    }
    expect(result.payload.data.all_count).toBe(99);
    expect(result.payload.data.cursor).toEqual({ next: 2 });
    const disabled = adapt(response, { cutoff: 1760000060, enabled: false });
    expect(disabled.payload).toEqual(response);
    expect(disabled.hiddenCount).toBe(0);
  });

  it('reports before/after counts for comment, dynamic and native-date helpers', () => {
    const comments = adaptCommentPayload({ data: { replies: [
      { rpid: 1, ctime: 1546300800, root: 0, parent: 0 },
      { rpid: 2, ctime: 1609459200, root: 0, parent: 0 },
    ] } }, { cutoff: '2020-01-01T00:00', enabled: true });
    expect(comments.handled).toBe(true);
    expect(comments.totalCount).toBe(2);
    expect(comments.visibleCount).toBe(1);
    expect(comments.hiddenCount).toBe(1);

    const dynamics = adaptDynamicPayload({ data: { items: [
      { id_str: 'before', modules: { module_author: { pub_ts: 1546300800 } } },
      { id_str: 'after', modules: { module_author: { pub_ts: 1609459200 } } },
      { id_str: 'unknown' },
    ] } }, { cutoff: '2020-01-01T00:00', enabled: true });
    expect(dynamics.totalCount).toBe(3);
    expect(dynamics.visibleCount).toBe(1);
    expect(dynamics.hiddenCount).toBe(2);

    const end = cutoffEndSeconds('2020-01-01T12:34');
    const expected = Math.trunc(new Date(2020, 0, 1, 23, 59, 59, 0).getTime() / 1000);
    expect(end).toBe(expected);
    expect(nativeStartSeconds()).toBe(Math.trunc(new Date(2009, 5, 26, 0, 0, 0, 0).getTime() / 1000));
    expect(cutoffEndSeconds('not-a-date')).toBeNull();
  });
});

