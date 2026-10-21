/**
 * MV3 MAIN world 入口只负责页面上下文桥接。
 * 网络 Hook 可以监听下列两个 CustomEvent，不依赖 chrome.* API。
 */

import { installNetworkHook } from '../page/network-hook';
import { scanRenderedMainVideo } from '../page/initial-state';
import { matchSupportedRoute } from '../routes/match';
import { getSearchRepagination } from './search-repagination';
import type { FilterConfig } from '../core/types';
import { resolveAutoAdvanceConfig } from '../core/auto-advance';
import { configLog, devLog } from '../core/dev-log';

export const CONFIG_EVENT = 'bilibili-time-filter:config';

export interface MainWorldConfig {
  cutoffMinute: string | null;
  enabled: boolean;
  supplementBudget: number;
  debug: boolean;
  autoAdvance?: boolean;
  autoAdvanceStartedAt?: number | null;
  autoAdvanceBaseCutoffMinute?: string | null;
}

declare global {
  interface Window {
    __BILIBILI_TIME_FILTER_CONFIG__?: MainWorldConfig;
  }
}

function isConfig(value: unknown): value is MainWorldConfig {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<MainWorldConfig>;
  return (input.cutoffMinute === null || typeof input.cutoffMinute === 'string')
    && typeof input.enabled === 'boolean'
    && typeof input.supplementBudget === 'number'
    && typeof input.debug === 'boolean';
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { source?: unknown; type?: unknown; config?: unknown } | null;
  if (!data) return;
  if (data.type === 'time-filter/config-update' && isConfig(data.config)) {
    window.__BILIBILI_TIME_FILTER_CONFIG__ = data.config;
    window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: data.config }));
  }
});

let currentConfig: FilterConfig | undefined;
let configResolved = false;
let hook: ReturnType<typeof installNetworkHook> | null = null;
let repagination: ReturnType<typeof getSearchRepagination> | null = null;
const pendingConfig: FilterConfig = { cutoffMinute: null, enabled: true, supplementBudget: 20, debug: false };
const configReady = new Promise<FilterConfig>((resolve) => {
  window.addEventListener(CONFIG_EVENT, (event: Event) => {
    const config = (event as CustomEvent<unknown>).detail;
    if (!isConfig(config)) return;
    const effective = resolveAutoAdvanceConfig(config);
    currentConfig = effective;
    repagination?.apply(effective);
    if (__TIME_FILTER_DEV__) devLog.log(configLog('config-bridged', effective, 'mv3-main-world'));
    scanRenderedMainVideo(document, effective.cutoffMinute, { enabled: effective.enabled }, window);
    if (!configResolved) {
      configResolved = true;
      resolve(effective);
    }
  });
});

function scanMainVideo(): void {
  const config = resolveAutoAdvanceConfig(configResolved && currentConfig ? currentConfig : pendingConfig);
  scanRenderedMainVideo(document, config.cutoffMinute, { enabled: config.enabled }, window);
}


function mountRoute(): void {
  const route = matchSupportedRoute(window.location);
  if (!route.installHook) return;
  scanMainVideo();
  repagination = route.kind === 'search'
    ? getSearchRepagination({
      document,
      target: window,
      onNotice: () => emitMainWorldNotice('跨页补齐失败，已退回逐页过滤。', 'repagination-failed'),
    })
    : null;
  hook = installNetworkHook({
    target: window,
    getConfig: () => (configResolved && currentConfig ? resolveAutoAdvanceConfig(currentConfig) : configReady),
    onNotice: (reason) => emitMainWorldNotice('过滤器无法验证当前内容，相关内容已隐藏。', reason),
    filterVideoResponse: repagination
      ? (url, payload, config) => repagination?.transformVideo(url, payload, config)
      : undefined,
  });
}

function unmountRoute(): void {
  hook?.uninstall();
  hook = null;
  repagination?.destroy();
  repagination = null;
}

mountRoute();
const routeKey = (): string => `${window.location.host}${window.location.pathname}`;
let lastRoute = routeKey();
const remount = (): void => {
  const route = routeKey();
  if (route === lastRoute) return;
  lastRoute = route;
  unmountRoute();
  mountRoute();
  window.postMessage({ type: 'time-filter/route-change' }, window.location.origin);
};
for (const method of ['pushState', 'replaceState'] as const) {
  const original = window.history[method];
  window.history[method] = function(this: History, ...args: Parameters<History[typeof method]>) {
    const result = original.apply(this, args);
    queueMicrotask(remount);
    return result;
  } as History[typeof method];
}
window.addEventListener('popstate', remount);
window.addEventListener('hashchange', remount);

/** 供页面上下文适配器上报一次性提示，内容只含提示文本和脱敏原因。 */
export function emitMainWorldNotice(message: string, reason: string): void {
  window.postMessage({ type: 'time-filter/notice', message, reason }, window.location.origin);
}
