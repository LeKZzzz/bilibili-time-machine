/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterPanelOptions } from '../../src/ui/panel';
import type { FavoriteHomeFillControllerOptions } from '../../src/runtime/favorite-home-fill-controller';

const mocks = vi.hoisted(() => ({
  panelOptions: undefined as FilterPanelOptions | undefined,
  favoriteOptions: undefined as FavoriteHomeFillControllerOptions | undefined,
  updateFavoriteState: vi.fn(),
  updatePanel: vi.fn(),
  updateCutoff: vi.fn(),
  updateFavoriteConfig: vi.fn(),
  continueFinding: vi.fn(async () => undefined),
}));

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
  createVideoController: () => ({ scan: vi.fn(), updateConfig: vi.fn(), updateCutoff: mocks.updateCutoff, disconnect: vi.fn() }),
}));
vi.mock('../../src/runtime/favorite-folder-list', () => ({ createFavoriteFolderLoader: () => vi.fn(async () => []) }));
vi.mock('../../src/page/network-hook', () => ({ installNetworkHook: () => ({ uninstall: vi.fn() }) }));
vi.mock('../../src/ui/notice', () => ({
  createNoticeManager: () => ({ show: vi.fn(), setSearching: vi.fn(), destroy: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(['userscript', 'extension'] as const)('%s effective time wiring', (runtime) => {
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
