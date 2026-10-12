import { describe, expect, it, vi } from 'vitest';
import comments from '../fixtures/core-comments.json';
import xml from '../fixtures/core-danmaku.xml?raw';
import { adaptCommentPayload } from '../../src/page/comment-adapter';
import { adaptDanmakuResponse } from '../../src/page/danmaku-adapter';
import { adaptDynamicPayload } from '../../src/page/dynamic-adapter';
import { matchSupportedRoute } from '../../src/routes/match';
import { createConfigStore, createMemoryConfigStorage } from '../../src/runtime/config-store';
import { isBridgeMessage, parseBridgeMessage, serializeBridgeMessage } from '../../src/runtime/bridge-protocol';
import { cutoffEndSeconds, nativeStartSeconds } from '../../src/runtime/native-search-filter';

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
    const message = { type: 'time-filter/config-update' as const, config };
    const encoded = serializeBridgeMessage(message);
    expect(parseBridgeMessage(encoded)).toEqual(message);
    expect(isBridgeMessage({ type: 'time-filter/notice', reason: 'parse-failed', message: 'safe' })).toBe(true);
    expect(isBridgeMessage({ type: 'time-filter/notice', reason: 'parse-failed', message: 'https://x/?token=secret\n' })).toBe(false);
    expect(parseBridgeMessage('{"type":"unknown"}')).toBeNull();
  });

  it('persists normalized configuration through an injected storage adapter', async () => {
    const store = createConfigStore(createMemoryConfigStorage());
    await store.saveConfig({ cutoffMinute: '2026-09-22T12:30', enabled: true, supplementBudget: 999, debug: true });
    expect(await store.loadConfig()).toMatchObject({ cutoffMinute: '2026-09-22T12:30', enabled: true, supplementBudget: 100, debug: true });
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

