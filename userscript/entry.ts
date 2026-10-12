import { createFilterPanel, type FilterPanelConfig, type FilterPanelController } from '../src/ui/panel';
import { createNoticeManager, type NoticeManager } from '../src/ui/notice';
import { DEFAULT_FILTER_CONFIG } from '../src/core/types';
import { installNetworkHook, type NetworkHookHandle } from '../src/page/network-hook';
import { matchSupportedRoute } from '../src/routes/match';
import { createPageVideoFetcher, createVideoController } from '../src/runtime/video-controller';
import { createNativeSearchFilter } from '../src/runtime/native-search-filter';
import { resolveAutoAdvanceConfig } from '../src/core/auto-advance';
import { configLog, devLog } from '../src/core/dev-log';

const STORAGE_KEY = 'bilibili-time-filter.config.v1';
const BRIDGE_SOURCE = 'bilibili-time-filter';
const DEFAULT_CONFIG: FilterPanelConfig = { ...DEFAULT_FILTER_CONFIG };

interface GreasemonkeyApi {
  getValue?: <T>(key: string, fallback: T) => Promise<T> | T;
  setValue?: (key: string, value: unknown) => Promise<void> | void;
  deleteValue?: (key: string) => Promise<void> | void;
}

function gmApi(): GreasemonkeyApi {
  const global = globalThis as typeof globalThis & {
    GM?: GreasemonkeyApi;
    GM_getValue?: <T>(key: string, fallback: T) => T;
    GM_setValue?: (key: string, value: unknown) => void;
    GM_deleteValue?: (key: string) => void;
  };
  return {
    getValue: global.GM?.getValue ?? global.GM_getValue,
    setValue: global.GM?.setValue ?? global.GM_setValue,
    deleteValue: global.GM?.deleteValue ?? global.GM_deleteValue,
  };
}

function pageWindow(): Window {
  const global = globalThis as typeof globalThis & { unsafeWindow?: Window };
  return global.unsafeWindow ?? window;
}

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
  };
}

async function readConfig(): Promise<FilterPanelConfig> {
  const getValue = gmApi().getValue;
  if (!getValue) return { ...DEFAULT_CONFIG };
  return normaliseConfig(await getValue(STORAGE_KEY, DEFAULT_CONFIG));
}

async function writeConfig(config: FilterPanelConfig): Promise<void> {
  const setValue = gmApi().setValue;
  if (!setValue) return;
  try {
    await setValue(STORAGE_KEY, config);
  } catch {
    // 存储不可用时页面仍可继续使用当前标签页配置。
  }
}

function sendBridgeMessage(config: FilterPanelConfig): void {
  const message = { type: 'time-filter/config-update' as const, config };
  const target = pageWindow();
  target.postMessage(message, target.location.origin);
}

function start(documentRef: Document = document, deferScan = false): { destroy: () => void } {
  const target = pageWindow();
  const route = matchSupportedRoute(target.location);
  if (!route.installHook) return { destroy: () => undefined };
  // 配置未读取前严格隐藏首屏，避免默认 disabled 造成闪现。
  const pendingConfig: FilterPanelConfig = { ...DEFAULT_CONFIG, enabled: true, cutoffMinute: null };
  let current = pendingConfig;
  let configReady = false;
  const notices = createNoticeManager({ document: documentRef });
  const nativeSearchFilter = route.kind === 'search' ? createNativeSearchFilter(documentRef) : null;
  const controller = createVideoController({
    root: documentRef,
    config: current,
    fetchVideo: createPageVideoFetcher(target),
    observe: true,
    onNotice: (reason) => { if (configReady) notices.show('过滤器无法验证当前内容，相关内容已隐藏。', reason); },
  });
  let autoAdvanceTimer: number | undefined;
  const refreshAutoAdvance = (): void => {
    if (!configReady || !current.autoAdvance) return;
    const next = resolveAutoAdvanceConfig(current);
    if (next.cutoffMinute === current.cutoffMinute) return;
    current = next;
    controller.updateCutoff(next.cutoffMinute);
    nativeSearchFilter?.apply(next);
    panel?.update(next);
    sendBridgeMessage(next);
  };
  let initialScanTimer: number | undefined;
  const scanInitial = (): void => { controller.scan(); };
  if (deferScan) initialScanTimer = target.setTimeout(scanInitial, 500);
  else scanInitial();
  const initialConfig = readConfig().then((config) => {
    current = resolveAutoAdvanceConfig(config);
    configReady = true;
    if (__TIME_FILTER_DEV__) devLog.log(configLog('config-loaded', current, 'userscript'));
    return current;
  });
  const hook: NetworkHookHandle = installNetworkHook({
    target,
    getConfig: () => (configReady ? resolveAutoAdvanceConfig(current) : initialConfig),
    onNotice: (reason) => notices.show('过滤器无法验证当前内容，相关内容已隐藏。', reason),
  });
  let panel: FilterPanelController;
  panel = createFilterPanel({
    document: documentRef,
    config: current,
    onChange: async (config) => {
      if (!configReady) return;
      current = resolveAutoAdvanceConfig(normaliseConfig(config));
      if (__TIME_FILTER_DEV__) devLog.log(configLog('config-changed', current, 'userscript'));
      controller.updateConfig(current);
      nativeSearchFilter?.apply(current);
      await writeConfig(current);
      sendBridgeMessage(current);
    },
  });
  autoAdvanceTimer = target.setInterval(refreshAutoAdvance, 1_000);
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { source?: unknown; type?: unknown; message?: unknown; reason?: unknown } | null;
    if (!data || data.type !== 'time-filter/notice') return;
    if (typeof data.message === 'string' && typeof data.reason === 'string') notices.show(data.message, data.reason);
  };
  target.addEventListener('message', onMessage);
  void initialConfig.then((config) => {
    current = resolveAutoAdvanceConfig(config);
    controller.updateConfig(current);
    nativeSearchFilter?.apply(current);
    panel.update(current);
    sendBridgeMessage(current);
  }).catch(() => {
    // 配置读取失败时保持严格隐藏，并向用户提示原因。
    if (__TIME_FILTER_DEV__) {
      devLog.log({ reason: 'config-read-failed', message: '配置读取失败', details: { source: 'userscript' } });
    }
    notices.show('配置读取失败，内容已暂时隐藏。', 'config-read-failed');
    panel.update(pendingConfig);
  });
  return {
    destroy: () => {
      hook.uninstall();
      if (initialScanTimer !== undefined) target.clearTimeout(initialScanTimer);
      if (autoAdvanceTimer !== undefined) target.clearInterval(autoAdvanceTimer);
      nativeSearchFilter?.destroy();
      controller.disconnect();
      panel.destroy();
      notices.destroy();
      target.removeEventListener('message', onMessage);
    },
  };
}

function mount(): void {
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
    return;
  }
  let active = start(document);
  const routeKey = (): string => `${pageWindow().location.host}${pageWindow().location.pathname}`;
  let lastRoute = routeKey();
  const remount = (): void => {
    const route = routeKey();
    if (route === lastRoute) return;
    lastRoute = route;
    active.destroy();
    active = start(document, true);
  };
  const history = pageWindow().history;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function(this: History, ...args: Parameters<History[typeof method]>) {
      const result = original.apply(this, args);
      queueMicrotask(remount);
      return result;
    } as History[typeof method];
  }
  pageWindow().addEventListener('popstate', remount);
  pageWindow().addEventListener('hashchange', remount);
}

mount();
