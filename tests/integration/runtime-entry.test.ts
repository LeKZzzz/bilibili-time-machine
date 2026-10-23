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
