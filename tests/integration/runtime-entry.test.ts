/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { FilterPanelOptions } from '../../src/ui/panel';
import type { FavoriteHomeFillControllerOptions } from '../../src/runtime/favorite-home-fill-controller';

type TestDom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => TestDom;
};

const mocks = vi.hoisted(() => ({
  panelOptions: undefined as FilterPanelOptions | undefined,
  favoriteOptions: undefined as FavoriteHomeFillControllerOptions | undefined,
  updateFavoriteState: vi.fn(),
  updatePanel: vi.fn(),
  updateCutoff: vi.fn(),
  updateVideoConfig: vi.fn(),
  updateFavoriteConfig: vi.fn(),
  continueFinding: vi.fn(async () => undefined),
  showNotice: vi.fn(),
}));
let page: TestDom;

vi.mock('../../src/ui/panel', () => ({
  createFilterPanel: (options: FilterPanelOptions) => {
    mocks.panelOptions = options;
    return { update: mocks.updatePanel, updateFavoriteState: mocks.updateFavoriteState, destroy: vi.fn() };
  },
}));
vi.mock('../../src/runtime/favorite-home-fill-controller', () => ({
  createFavoriteHomeFillController: (options: FavoriteHomeFillControllerOptions) => {
    mocks.favoriteOptions = options;
    return {
      updateConfig: mocks.updateFavoriteConfig, continueFinding: mocks.continueFinding,
      getState: () => ({ phase: 'idle', reason: 'paused' }), getTags: async () => [], disconnect: vi.fn(),
    };
  },
}));
vi.mock('../../src/runtime/video-controller', () => ({
  createPageVideoFetcher: vi.fn(),
  createVideoController: () => ({ scan: vi.fn(), updateConfig: mocks.updateVideoConfig, updateCutoff: mocks.updateCutoff, disconnect: vi.fn() }),
}));
vi.mock('../../src/runtime/favorite-folder-list', () => ({ createFavoriteFolderLoader: () => vi.fn(async () => []) }));
vi.mock('../../src/page/network-hook', () => ({ installNetworkHook: () => ({ uninstall: vi.fn() }) }));
vi.mock('../../src/ui/notice', () => ({
  createNoticeManager: () => ({ show: mocks.showNotice, setSearching: vi.fn(), destroy: vi.fn() }),
}));

beforeEach(() => {
  page = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.bilibili.com/' });
  vi.stubGlobal('window', page.window);
  vi.stubGlobal('document', page.window.document);
  vi.stubGlobal('CustomEvent', page.window.CustomEvent);
  mocks.panelOptions = undefined;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.clearAllMocks();
  vi.useRealTimers();
  page.window.close();
  vi.unstubAllGlobals();
});

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe.each(['userscript', 'extension'] as const)('%s effective time wiring', (runtime) => {
  it('rejects commits before settings load and allows a manual retry after readiness', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    const stored = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
    const pending = deferred<typeof stored>();
    const get = vi.fn((requestedKey: string) => requestedKey === key
      ? (runtime === 'userscript' ? pending.promise : pending.promise.then(value => ({ [key]: value })))
      : Promise.resolve(runtime === 'userscript' ? undefined : {}));
    const set = vi.fn(async () => undefined);
    const post = vi.spyOn(window, 'postMessage');
    vi.stubGlobal('GM', { getValue: get, setValue: set });
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });

    if (runtime === 'userscript') await import('../../userscript/entry');
    else await import('../../src/runtime/mv3-content');
    const options = mocks.panelOptions!;
    expect(options.isConfigReady?.()).toBe(false);
    await expect(options.onChange!({ ...stored, cutoffMinute: '2010-01-01T12:00:00' }))
      .rejects.toThrow('过滤设置尚未读取完成');
    expect(set).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'time-filter/config-update')).toHaveLength(0);

    pending.resolve(stored);
    await flushMicrotasks();
    expect(options.isConfigReady?.()).toBe(true);
    await options.onChange!({ ...stored, cutoffMinute: '2010-01-01T12:00:00' });
    expect(set).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'time-filter/config-update', config: expect.objectContaining({ cutoffMinute: '2010-01-01T12:00:00' }) }),
      window.location.origin,
    );
  });

  it('keeps a failed config read unready and rejects save retries without side effects', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    const get = vi.fn(async (requestedKey: string) => {
      if (requestedKey === key) throw new Error('配置存储不可用');
      return runtime === 'userscript' ? undefined : {};
    });
    const set = vi.fn(async () => undefined);
    const post = vi.spyOn(window, 'postMessage');
    vi.stubGlobal('GM', { getValue: get, setValue: set });
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });

    if (runtime === 'userscript') await import('../../userscript/entry');
    else await import('../../src/runtime/mv3-content');
    await flushMicrotasks();

    const options = mocks.panelOptions!;
    expect(options.isConfigReady?.()).toBe(false);
    expect(mocks.showNotice).toHaveBeenCalledWith('无法读取过滤设置，内容已隐藏。请刷新页面重试。', 'config-read-failed');
    const attempted = { cutoffMinute: '2010-01-01T12:00:00', enabled: true, supplementBudget: 20, debug: false };
    await expect(options.onChange!(attempted)).rejects.toThrow('过滤设置尚未读取完成');
    await expect(options.onChange!(attempted)).rejects.toThrow('过滤设置尚未读取完成');
    expect(get.mock.calls.filter(([requestedKey]) => requestedKey === key)).toHaveLength(1); // 配置读取失败后只要求刷新页面，不重复读取。
    expect(set).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'time-filter/config-update')).toHaveLength(0);
  });

  it('accepts notices only from the same window and origin', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    const stored = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
    vi.stubGlobal('GM', { getValue: async (requestedKey: string) => requestedKey === key ? stored : undefined, setValue: vi.fn() });
    vi.stubGlobal('chrome', { storage: { local: {
      get: async (requestedKey: string) => requestedKey === key ? { [key]: stored } : {},
      set: vi.fn(),
    } } });

    if (runtime === 'userscript') await import('../../userscript/entry');
    else await import('../../src/runtime/mv3-content');
    await flushMicrotasks();
    mocks.showNotice.mockClear();

    const data = { type: 'time-filter/notice', message: '同窗口提示', reason: 'same-window-test' };
    const MessageEventConstructor = page.window.MessageEvent;
    window.dispatchEvent(new MessageEventConstructor('message', { data, origin: 'https://foreign.example', source: page.window }));
    window.dispatchEvent(new MessageEventConstructor('message', { data, origin: window.location.origin, source: null }));
    expect(mocks.showNotice).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEventConstructor('message', { data, origin: window.location.origin, source: page.window }));
    expect(mocks.showNotice).toHaveBeenCalledWith(data.message, data.reason);
  });

  it('does not publish config from a read that finishes after the SPA instance is destroyed', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    const stored = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
    const reads: Array<ReturnType<typeof deferred<typeof stored>>> = [];
    const read = () => {
      const next = deferred<typeof stored>();
      reads.push(next);
      return next.promise;
    };
    vi.stubGlobal('GM', { getValue: (requestedKey: string) => requestedKey === key ? read() : Promise.resolve(undefined), setValue: vi.fn() });
    vi.stubGlobal('chrome', { storage: { local: {
      get: (requestedKey: string) => requestedKey === key ? read().then(value => ({ [key]: value })) : Promise.resolve({}),
      set: vi.fn(),
    } } });
    const post = vi.spyOn(window, 'postMessage');
    const pushState = window.history.pushState;
    const replaceState = window.history.replaceState;
    const previousUrl = window.location.href;
    replaceState.call(window.history, {}, '', '/');

    try {
      if (runtime === 'userscript') await import('../../userscript/entry');
      else await import('../../src/runtime/mv3-content');
      await vi.advanceTimersByTimeAsync(0);
      const oldPanel = mocks.panelOptions!;
      expect(reads).toHaveLength(1);

      window.history.pushState({}, '', '/video/BV1xx411c7mD/');
      await vi.advanceTimersByTimeAsync(0);
      const activePanel = mocks.panelOptions!;
      expect(activePanel).not.toBe(oldPanel);
      expect(reads).toHaveLength(2);

      const latest = { ...stored, cutoffMinute: '2024-01-01T00:00:00' };
      reads[1].resolve(latest);
      await flushMicrotasks();
      expect(activePanel.isConfigReady?.()).toBe(true);
      const updatesAfterLatestRead = mocks.updatePanel.mock.calls.length;
      const controllerUpdatesAfterLatestRead = mocks.updateVideoConfig.mock.calls.length;
      const bridgesAfterLatestRead = post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'time-filter/config-update').length;
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'time-filter/config-update', config: expect.objectContaining({ cutoffMinute: latest.cutoffMinute }) }),
        window.location.origin,
      );

      reads[0].resolve(stored);
      await flushMicrotasks();
      expect(oldPanel.isConfigReady?.()).toBe(false);
      expect(mocks.updatePanel).toHaveBeenCalledTimes(updatesAfterLatestRead);
      expect(mocks.updateVideoConfig).toHaveBeenCalledTimes(controllerUpdatesAfterLatestRead);
      expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'time-filter/config-update')).toHaveLength(bridgesAfterLatestRead);
      expect(post).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'time-filter/config-update', config: expect.objectContaining({ cutoffMinute: stored.cutoffMinute }) }),
        window.location.origin,
      );
      await expect(oldPanel.onChange!({ ...stored, enabled: true })).rejects.toThrow('实例已失效');
    } finally {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      replaceState.call(window.history, {}, '', previousUrl);
    }
  });

  it.each([false, true])('SPA 重建后仍按提交顺序保存最新设置，早期写入失败=%s', async (failFirst) => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    let stored = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const set = vi.fn(async (...args: unknown[]) => {
      const config = (runtime === 'userscript' ? args[1] : (args[0] as Record<string, unknown>)[key]) as typeof stored;
      events.push(`start:${config.supplementBudget}`);
      if (config.supplementBudget === 30) {
        await firstWrite;
        if (failFirst) {
          events.push('failed:30');
          throw new Error('早期写入失败');
        }
      }
      stored = config;
      events.push(`finish:${config.supplementBudget}`);
    });
    const pushState = window.history.pushState;
    const replaceState = window.history.replaceState;
    const previousUrl = window.location.href;
    replaceState.call(window.history, {}, '', '/');
    vi.stubGlobal('GM', { getValue: async () => stored, setValue: set });
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ [key]: stored }), set } } });
    try {
      if (runtime === 'userscript') await import('../../userscript/entry');
      else await import('../../src/runtime/mv3-content');
      await vi.advanceTimersByTimeAsync(0);
      const originalPanel = mocks.panelOptions!;
      const first = Promise.resolve(originalPanel.onChange!({ ...stored, supplementBudget: 30 }))
        .then(() => 'saved', () => 'failed');
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['start:30']);

      window.history.pushState({}, '', '/video/BV1xx411c7mD/');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.panelOptions).not.toBe(originalPanel);
      const second = mocks.panelOptions!.onChange!({ ...stored, supplementBudget: 40 });
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(['start:30']);

      releaseFirst();
      expect(await first).toBe(failFirst ? 'failed' : 'saved');
      await second;
      expect(events).toEqual(['start:30', failFirst ? 'failed:30' : 'finish:30', 'start:40', 'finish:40']);
      expect(stored.supplementBudget).toBe(40);
      window.history.pushState({}, '', '/');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.updatePanel).toHaveBeenLastCalledWith(expect.objectContaining({ supplementBudget: 40 }));
    } finally {
      releaseFirst();
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
      replaceState.call(window.history, {}, '', previousUrl);
    }
  });

  it('applies and bridges settings despite storage failure, then persists a successful retry for reload', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const key = 'bilibili-time-filter.config.v1';
    let stored = { cutoffMinute: '2020-01-01T00:00:00', enabled: false, supplementBudget: 20, debug: false };
    let fail = true;
    const set = vi.fn(async (...args: unknown[]) => {
      if (fail) throw new Error('存储不可用');
      stored = (runtime === 'userscript' ? args[1] : (args[0] as Record<string, unknown>)[key]) as typeof stored;
    });
    const post = vi.spyOn(window, 'postMessage');
    const pushState = window.history.pushState;
    const replaceState = window.history.replaceState;
    vi.stubGlobal('GM', { getValue: async () => stored, setValue: set });
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ [key]: stored }), set } } });
    const load = async () => {
      if (runtime === 'userscript') await import('../../userscript/entry');
      else await import('../../src/runtime/mv3-content');
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await load();
      const next = { ...stored, enabled: true, favoriteFolderIds: ['new-folder'], favoriteFolderUid: 'account-B' };
      await expect(mocks.panelOptions!.onChange!(next)).rejects.toThrow('存储不可用');
      expect(stored.enabled).toBe(false);
      expect(mocks.updateFavoriteConfig).toHaveBeenLastCalledWith(expect.objectContaining(next));
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'time-filter/config-update', config: expect.objectContaining(next) }), window.location.origin);
      fail = false;
      await mocks.panelOptions!.onChange!(next);
      expect(stored).toEqual(expect.objectContaining(next));
      vi.resetModules();
      await load();
      expect(mocks.updatePanel).toHaveBeenLastCalledWith(expect.objectContaining(next));
    } finally {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
    }
  });

  it('sends each advanced cutoff to ordinary filtering, home fill and panel, and wires real task feedback', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const started = new Date(2026, 9, 23, 12, 0, 0).getTime();
    vi.setSystemTime(started);
    const config = {
      cutoffMinute: '2020-01-01T00:00:15', enabled: true, supplementBudget: 20, debug: false,
      autoAdvance: true, autoAdvanceStartedAt: started, autoAdvanceBaseCutoffMinute: '2020-01-01T00:00:15',
      favoriteHomeFillEnabled: true, favoriteFolderIds: ['1'],
    };
    const pushState = window.history.pushState;
    const replaceState = window.history.replaceState;
    vi.stubGlobal('GM', { getValue: async () => config });
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ 'bilibili-time-filter.config.v1': config }) } } });
    try {
      if (runtime === 'userscript') await import('../../userscript/entry');
      else await import('../../src/runtime/mv3-content');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.updateFavoriteState).toHaveBeenCalledWith({ phase: 'idle', reason: 'paused' });
      mocks.favoriteOptions?.onStateChange?.({ phase: 'filled', insertedCount: 2 });
      expect(mocks.updateFavoriteState).toHaveBeenLastCalledWith({ phase: 'filled', insertedCount: 2 });
      await mocks.panelOptions?.onFavoriteContinue?.();
      expect(mocks.continueFinding).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.updateCutoff).toHaveBeenLastCalledWith('2020-01-01T00:01:15');
      expect(mocks.updateFavoriteConfig).toHaveBeenLastCalledWith(expect.objectContaining({ cutoffMinute: '2020-01-01T00:01:15' }));
      expect(mocks.updatePanel).toHaveBeenLastCalledWith(expect.objectContaining({ cutoffMinute: '2020-01-01T00:01:15' }));
    } finally {
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
    }
  });
});
