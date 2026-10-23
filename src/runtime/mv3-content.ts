import { createFilterPanel, type FilterPanelConfig, type FilterPanelController } from '../ui/panel';
import { createNoticeManager } from '../ui/notice';
import { DEFAULT_FILTER_CONFIG } from '../core/types';
import { createPageVideoFetcher, createVideoController } from './video-controller';
import { matchSupportedRoute } from '../routes/match';
import { createNativeSearchFilter } from './native-search-filter';
import { resolveAutoAdvanceConfig } from '../core/auto-advance';
import { configLog, devLog } from '../core/dev-log';
import { createFavoriteHomeFillController, type FavoriteHomeFillController } from './favorite-home-fill-controller';
import { createFavoriteFolderLoader } from './favorite-folder-list';

const STORAGE_KEY = 'bilibili-time-filter.config.v1';
const BRIDGE_SOURCE = 'bilibili-time-filter';
const DEFAULT_CONFIG: FilterPanelConfig = { ...DEFAULT_FILTER_CONFIG };

function normaliseConfig(value: unknown): FilterPanelConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_CONFIG };
  const input = value as Partial<FilterPanelConfig>;
  const budget = Number(input.supplementBudget);
  const cutoffMinute = typeof input.cutoffMinute === 'string' && input.cutoffMinute ? input.cutoffMinute : null;
  return {
    cutoffMinute,
    enabled: input.enabled === true && Boolean(cutoffMinute),
    supplementBudget: Number.isFinite(budget) ? Math.min(100, Math.max(0, Math.round(budget))) : 20,
    debug: input.debug === true,
    autoAdvance: input.autoAdvance === true,
    autoAdvanceStartedAt: Number.isFinite(input.autoAdvanceStartedAt) ? input.autoAdvanceStartedAt : null,
    autoAdvanceBaseCutoffMinute: typeof input.autoAdvanceBaseCutoffMinute === 'string' && input.autoAdvanceBaseCutoffMinute
      ? input.autoAdvanceBaseCutoffMinute : null,
    favoriteHomeFillEnabled: input.favoriteHomeFillEnabled === true,
    favoriteFolderIds: Array.isArray(input.favoriteFolderIds) ? input.favoriteFolderIds.filter((id): id is string => typeof id === 'string').slice(0, 10) : [],
    favoriteFolderLimit: Number.isFinite(input.favoriteFolderLimit) ? Math.min(10, Math.max(1, Math.round(Number(input.favoriteFolderLimit)))) : 3,
    favoriteVideoLimit: Number.isFinite(input.favoriteVideoLimit) ? Math.min(200, Math.max(1, Math.round(Number(input.favoriteVideoLimit)))) : 50,
    favoriteRefreshRequestedAt: Number.isFinite(input.favoriteRefreshRequestedAt) ? input.favoriteRefreshRequestedAt : null,
  };
}

async function loadConfig(): Promise<FilterPanelConfig> {
  const value = await chrome.storage.local.get(STORAGE_KEY);
  return normaliseConfig(value[STORAGE_KEY]);
}

async function saveConfig(config: FilterPanelConfig): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: config });
  } catch {
    // 浏览器存储不可用时保留当前标签页的内存状态。
  }
}

function send(config: FilterPanelConfig): void {
  const message = { type: 'time-filter/config-update' as const, config };
  window.postMessage(message, window.location.origin);
}

function start(documentRef: Document = document, deferScan = false): { destroy: () => void } {
  if (!matchSupportedRoute(window.location).installHook) return { destroy: () => undefined };
  const pendingConfig: FilterPanelConfig = { ...DEFAULT_CONFIG, enabled: true, cutoffMinute: null };
  let current = pendingConfig;
  let configReady = false;
  let mounted = true;
  const notices = createNoticeManager({ document: documentRef });
  const nativeSearchFilter = matchSupportedRoute(window.location).kind === 'search'
    ? createNativeSearchFilter(documentRef)
    : null;
  const controller = createVideoController({
    root: documentRef,
    config: current,
    fetchVideo: createPageVideoFetcher(window),
    observe: true,
    onNotice: (reason) => { if (configReady) notices.show('过滤器无法验证当前内容，相关内容已隐藏。', reason); },
  });
  const pageFetch = window.fetch ? window.fetch.bind(window) : undefined;
  let panel: FilterPanelController | undefined;
  const favoriteFill: FavoriteHomeFillController = createFavoriteHomeFillController({
    root: documentRef, config: current, fetch: pageFetch,
    onNotice: () => { if (configReady) notices.show('收藏标签补位失败，本轮已停止。', 'favorite-fill-failed'); },
    onSearchStateChange: (searching) => notices.setSearching(searching),
    onStateChange: (state) => panel?.updateFavoriteState(state),
  });
  const loadFolders = pageFetch ? createFavoriteFolderLoader(pageFetch, () => mounted && configReady) : undefined;
  let autoAdvanceTimer: number | undefined;
  const refreshAutoAdvance = (): void => {
    if (!configReady || !current.autoAdvance) return;
    const next = resolveAutoAdvanceConfig(current);
    if (next.cutoffMinute === current.cutoffMinute) return;
    current = next;
    controller.updateCutoff(next.cutoffMinute);
    favoriteFill.updateConfig(next);
    nativeSearchFilter?.apply(next);
    panel?.update(next);
    send(next);
  };
  let initialScanTimer: number | undefined;
  const scanInitial = (): void => { controller.scan(); };
  if (deferScan) initialScanTimer = window.setTimeout(scanInitial, 500);
  else scanInitial();
  panel = createFilterPanel({
    document: documentRef,
    config: current,
    onFavoriteFoldersRefresh: loadFolders,
    onFavoriteTagsLoad: () => favoriteFill.getTags(),
    onFavoriteContinue: () => favoriteFill.continueFinding(),
    onChange: async (config) => {
      if (!configReady) return;
      current = resolveAutoAdvanceConfig(normaliseConfig(config));
      if (__TIME_FILTER_DEV__) devLog.log(configLog('config-changed', current, 'mv3-content'));
      controller.updateConfig(current);
      favoriteFill?.updateConfig(current);
      nativeSearchFilter?.apply(current);
      await saveConfig(current);
      send(current);
    },
  });
  panel.updateFavoriteState(favoriteFill.getState());
  autoAdvanceTimer = window.setInterval(refreshAutoAdvance, 1_000);

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { source?: unknown; type?: unknown; message?: unknown; reason?: unknown } | null;
    if (!data || data.type !== 'time-filter/notice') return;
    if (typeof data.message === 'string' && typeof data.reason === 'string') notices.show(data.message, data.reason);
  };
  window.addEventListener('message', onMessage);

  void loadConfig().then((config) => {
    current = resolveAutoAdvanceConfig(config);
    configReady = true;
    if (__TIME_FILTER_DEV__) devLog.log(configLog('config-loaded', current, 'mv3-content'));
    controller.updateConfig(current);
    favoriteFill?.updateConfig(current);
    nativeSearchFilter?.apply(current);
    panel?.update(current);
    send(current);
  }).catch(() => {
    if (__TIME_FILTER_DEV__) {
      devLog.log({ reason: 'config-read-failed', message: '配置读取失败', details: { source: 'mv3-content' } });
    }
    notices.show('配置读取失败，内容已暂时隐藏。', 'config-read-failed');
    panel?.update(pendingConfig);
  });
  return {
    destroy: () => {
      mounted = false;
      controller.disconnect();
      favoriteFill?.disconnect();
      if (initialScanTimer !== undefined) window.clearTimeout(initialScanTimer);
      if (autoAdvanceTimer !== undefined) window.clearInterval(autoAdvanceTimer);
      nativeSearchFilter?.destroy();
      panel?.destroy();
      notices.destroy();
      window.removeEventListener('message', onMessage);
    },
  };
}

function mount(): void {
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
    return;
  }
  let active = start(document);
  const routeKey = (): string => `${window.location.host}${window.location.pathname}`;
  let lastRoute = routeKey();
  const remount = (): void => {
    const route = routeKey();
    if (route === lastRoute) return;
    lastRoute = route;
    active.destroy();
    active = start(document, true);
  };
  const history = window.history;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function(this: History, ...args: Parameters<History[typeof method]>) {
      const result = original.apply(this, args);
      queueMicrotask(remount);
      return result;
    } as History[typeof method];
  }
  window.addEventListener('popstate', remount);
  window.addEventListener('hashchange', remount);
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source === window && event.data?.type === 'time-filter/route-change') remount();
  });
}

mount();
