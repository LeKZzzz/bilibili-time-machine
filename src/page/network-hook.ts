import { classifyVideo } from '../core/video';
import { isAnimationDetailRequest } from '../playback/filter-context';
import type { FilterConfig, VideoRecord } from '../core/types';
import { devLog } from '../core/dev-log';
import { adaptCommentPayload, isCommentUrl } from './comment-adapter';
import { adaptDanmakuResponse, isDanmakuUrl } from './danmaku-adapter';
import { adaptDynamicPayload, isDynamicUrl } from './dynamic-adapter';

export interface NetworkHookOptions {
  target?: Window;
  /** 配置可异步读取；在 pending 期间受控响应不会直接放行。 */
  config?: FilterConfig | Promise<FilterConfig>;
  getConfig?: () => FilterConfig | Promise<FilterConfig>;
  onNotice?: (reason: 'config-pending' | 'config-read-failed' | 'parse-failed' | 'hook-failed') => void;
  onResponse?: (url: string, payload: unknown, config: FilterConfig) => unknown | Promise<unknown>;
  /**
   * 视频响应统一委托：可实现搜索结果跨页补齐并返回重排后的载荷；返回
   * `undefined` 时沿用现有的逐页严格过滤。回调在过滤前收到页面原始载荷，
   * 不得改写 WBI 签名 URL，也不得把响应正文写入日志。
   */
  filterVideoResponse?: (url: string, payload: unknown, config: FilterConfig) => unknown | undefined;
  /** 可用于测试，或页面上下文中显式指定原始实现。 */
  fetch?: typeof fetch;
}

export interface NetworkHookHandle {
  uninstall(): void;
  installed: boolean;
}

const VIDEO_RESPONSE_PATH = /\/(?:x\/web-interface\/view|x\/web-interface\/(?:wbi\/)?search|x\/v2\/feed|x\/web-interface\/archive|x\/player\/pagelist)(?:\/|$)/i;

function isVideoResponseUrl(url: string): boolean {
  try {
    return VIDEO_RESPONSE_PATH.test(new URL(url, window.location.href).pathname);
  } catch {
    return VIDEO_RESPONSE_PATH.test(url.split('?')[0]);
  }
}


function responseRecord(value: unknown): value is VideoRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return 'pubdate' in item && ('bvid' in item || 'aid' in item || 'pic' in item);
}

export interface VideoFilterOutcome {
  payload: unknown;
  /** 遍历到的可判定视频记录数（过滤前）。 */
  total: number;
  /** 保留的记录数（过滤后）。 */
  kept: number;
}

/** 与 filterVideoPayload 行为一致，额外返回过滤前后的记录数量，供开发日志使用。 */
export function filterVideoPayloadDetailed(value: unknown, config: FilterConfig): VideoFilterOutcome {
  if (!config.enabled) return { payload: value, total: 0, kept: 0 };
  let total = 0;
  let kept = 0;
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(visit).filter((child) => {
        if (!responseRecord(child)) return true;
        total += 1;
        const visible = classifyVideo(child, config.cutoffMinute, { enabled: true }).visible;
        if (visible) kept += 1;
        return visible;
      });
    }
    if (!item || typeof item !== 'object') return item;
    const object = item as Record<string, unknown>;
    const next: Record<string, unknown> = { ...object };
    for (const [key, child] of Object.entries(object)) {
      if (Array.isArray(child) || (child && typeof child === 'object')) next[key] = visit(child);
    }
    return next;
  };
  const payload = visit(value);
  return { payload, total, kept };
}

type NetworkNoticeReason = 'config-pending' | 'config-read-failed' | 'parse-failed' | 'hook-failed';
type LogDetails = Record<string, string | number | boolean | null>;
type NetworkAdapter = 'comment' | 'danmaku' | 'dynamic' | 'video' | 'custom';

const NOTICE_MESSAGES: Record<NetworkNoticeReason, string> = {
  'config-pending': '配置尚未就绪',
  'config-read-failed': '配置读取失败',
  'parse-failed': '响应解析失败',
  'hook-failed': '网络 Hook 安装失败',
};

/** 网络响应过滤日志：只记录脱敏主机/路径与过滤前后数量，不含查询参数和响应正文。 */
function logNetwork(
  url: string,
  adapter: NetworkAdapter,
  counts?: { total?: number; visible?: number; hidden?: number },
  ok = true,
): void {
  if (!__TIME_FILTER_DEV__) return;
  devLog.log({
    reason: 'network-filtered',
    message: '网络响应已过滤',
    url,
    count: counts?.visible,
    details: {
      adapter,
      before: counts?.total ?? null,
      after: counts?.visible ?? null,
      hidden: counts?.hidden ?? null,
      ok,
    },
  });
}

function logBypassed(url: string): void {
  if (!__TIME_FILTER_DEV__) return;
  devLog.log({ reason: 'network-bypassed', message: '过滤未启用，响应旁路', url, details: { source: 'network-hook' } });
}

function asUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  return (input as Request).url;
}

async function resolveConfig(options: NetworkHookOptions): Promise<FilterConfig> {
  if (options.getConfig) return options.getConfig();
  if (options.config && typeof (options.config as Promise<FilterConfig>).then === 'function') return options.config;
  if (options.config) return options.config;
  throw new Error('filter configuration is unavailable');
}

/**
 * 内置适配器都是同步的，因此保持同步返回值可以让 XHR 的 load 监听器
 * 在同一事件循环内替换 responseText。只有调用方提供 onResponse 且返回
 * Promise 时才会走异步分支。
 */
function processPayload(
  url: string,
  payload: unknown,
  config: FilterConfig,
  options: NetworkHookOptions,
  notify: (reason: NetworkNoticeReason, details?: LogDetails, url?: string) => void,
): unknown | Promise<unknown> {
  if (!config.enabled) return payload;
  if (isCommentUrl(url)) {
    const result = adaptCommentPayload(payload, { cutoff: config.cutoffMinute, enabled: true });
    if (__TIME_FILTER_DEV__) {
      logNetwork(url, 'comment', { total: result.totalCount, visible: result.visibleCount, hidden: result.hiddenCount }, result.handled);
    }
    if (!result.handled) notify('parse-failed', { adapter: 'comment' }, url);
    return result.payload;
  }
  if (isDynamicUrl(url)) {
    const result = adaptDynamicPayload(payload, { cutoff: config.cutoffMinute, enabled: true });
    if (__TIME_FILTER_DEV__) {
      logNetwork(url, 'dynamic', { total: result.totalCount, visible: result.visibleCount, hidden: result.hiddenCount }, result.handled);
    }
    if (!result.handled) notify('parse-failed', { adapter: 'dynamic' }, url);
    return result.payload;
  }
  if (isVideoResponseUrl(url)) {
    if (isAnimationDetailRequest(url, options.target)) return payload;
    const delegated = options.filterVideoResponse?.(url, payload, config);
    if (delegated !== undefined) {
      if (__TIME_FILTER_DEV__) logNetwork(url, 'video', undefined, true);
      return delegated;
    }
    const outcome = filterVideoPayloadDetailed(payload, config);
    if (__TIME_FILTER_DEV__) {
      logNetwork(url, 'video', { total: outcome.total, visible: outcome.kept, hidden: Math.max(0, outcome.total - outcome.kept) });
    }
    return outcome.payload;
  }
  if (options.onResponse) {
    if (__TIME_FILTER_DEV__) logNetwork(url, 'custom');
    return options.onResponse(url, payload, config);
  }
  return payload;
}

export function installNetworkHook(options: NetworkHookOptions = {}): NetworkHookHandle {
  const target = options.target ?? (typeof window !== 'undefined' ? window : undefined);
  if (!target) {
    if (__TIME_FILTER_DEV__) devLog.log({ reason: 'hook-failed', message: NOTICE_MESSAGES['hook-failed'], details: { cause: 'no-target' } });
    return { installed: false, uninstall: () => undefined };
  }
  /** 统一入口：开发构建记录脱敏原因，发布构建只保留原有点击提示回调。 */
  const notify = (reason: NetworkNoticeReason, details?: LogDetails, url?: string): void => {
    if (__TIME_FILTER_DEV__) {
      devLog.log({ reason, message: NOTICE_MESSAGES[reason], url, details: { source: 'network-hook', ...details } });
    }
    options.onNotice?.(reason);
  };
  const originalFetch = options.fetch ?? target.fetch?.bind(target);
  if (!originalFetch) {
    notify('hook-failed', { cause: 'fetch-unavailable' });
    return { installed: false, uninstall: () => undefined };
  }
  let active = true;
  const wrappedFetch: typeof fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!active) return response;
    const url = asUrl(input);
    if (!isCommentUrl(url) && !isDanmakuUrl(url) && !isDynamicUrl(url) && !isVideoResponseUrl(url)) return response;
    let config: FilterConfig;
    try {
      config = await resolveConfig(options);
    } catch {
      notify('config-read-failed');
      return new Response('', { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!config.enabled) {
      if (__TIME_FILTER_DEV__) logBypassed(url);
      return response;
    }
    try {
      if (isDanmakuUrl(url)) {
        const text = await response.clone().text();
        const result = adaptDanmakuResponse(url, text, { cutoff: config.cutoffMinute, enabled: true });
        if (__TIME_FILTER_DEV__) {
          logNetwork(url, 'danmaku', {
            total: result.result.records.length + result.result.hiddenCount,
            visible: result.result.records.length,
            hidden: result.result.hiddenCount,
          }, result.result.ok);
        }
        if (!result.result.ok) notify('parse-failed', { adapter: 'danmaku' }, url);
        return new Response(result.result.ok ? result.result.xml : '', {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const payload = await response.clone().json();
      const transformed = await processPayload(url, payload, config, options, notify);
      return new Response(JSON.stringify(transformed), {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    } catch {
      notify('parse-failed', undefined, url);
      return new Response('', { status: response.status, statusText: response.statusText, headers: response.headers });
    }
  };
  try {
    target.fetch = wrappedFetch;
  } catch {
    notify('hook-failed', { cause: 'fetch-readonly' });
    return { installed: false, uninstall: () => undefined };
  }

  const Xhr = (target as Window & typeof globalThis).XMLHttpRequest;
  const originalOpen = Xhr?.prototype.open;
  const originalSend = Xhr?.prototype.send;
  const xhrHooked = typeof originalOpen === 'function' && typeof originalSend === 'function';
  if (xhrHooked) {
    const open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const requestUrl = String(url);
      Object.defineProperty(this, '__timeFilterUrl', { configurable: true, value: requestUrl });
      return originalOpen.call(
        this,
        method,
        requestUrl,
        (rest[0] as boolean | undefined) ?? true,
        (rest[1] as string | undefined) ?? '',
        (rest[2] as string | undefined) ?? '',
      );
    };
    const send = function(this: XMLHttpRequest, ...args: unknown[]) {
      const url = String((this as XMLHttpRequest & { __timeFilterUrl?: string }).__timeFilterUrl || '');
      this.addEventListener('load', () => {
        if (!active || (!isCommentUrl(url) && !isDanmakuUrl(url) && !isDynamicUrl(url) && !isVideoResponseUrl(url))) return;
        const responseType = this.responseType || 'text';
        // 播放器的 arraybuffer/blob 等二进制响应不可读取 responseText，直接旁路。
        if (isDanmakuUrl(url) ? responseType !== 'text' : responseType !== 'text' && responseType !== 'json') return;
        const rawText = responseType === 'text' ? this.responseText : '';
        const rawResponse = this.response;
        const replace = (value: unknown, asJsonResponse: boolean, serializeJson = false): void => {
          const replacement = serializeJson ? JSON.stringify(value) : String(value);
          try {
            Object.defineProperty(this, 'responseText', { configurable: true, get: () => replacement });
          } catch {
            // 保持原生属性，下面仍会尝试覆盖 response。
          }
          try {
            Object.defineProperty(this, 'response', {
              configurable: true,
              get: () => (asJsonResponse ? value : replacement),
            });
          } catch {
            // 浏览器禁止实例覆盖时，保持原生 XHR。
          }
        };
        const restoreRaw = (): void => {
          try { Object.defineProperty(this, 'responseText', { configurable: true, get: () => rawText }); } catch { /* 保持原生属性 */ }
          try { Object.defineProperty(this, 'response', { configurable: true, get: () => rawResponse }); } catch { /* 保持原生属性 */ }
        };
        // 配置尚未读取时先清空受控响应，避免页面在 Promise 完成前读到原始内容。
        const pendingConfig = options.config && typeof (options.config as Promise<FilterConfig>).then !== 'function'
          ? options.config as FilterConfig
          : undefined;
        if (!pendingConfig) replace('', false);
        const applyConfigured = (configured: FilterConfig): void => {
          if (!active) return;
          if (!configured.enabled) {
            if (__TIME_FILTER_DEV__) logBypassed(url);
            restoreRaw();
            return;
          }
          const empty = (): void => {
            notify('parse-failed', undefined, url);
            replace('', false);
          };
          try {
            if (isDanmakuUrl(url)) {
              if (this.responseType && this.responseType !== 'text') return;
              const adapted = adaptDanmakuResponse(url, rawText, { cutoff: configured.cutoffMinute, enabled: true });
              if (__TIME_FILTER_DEV__) {
                logNetwork(url, 'danmaku', {
                  total: adapted.result.records.length + adapted.result.hiddenCount,
                  visible: adapted.result.records.length,
                  hidden: adapted.result.hiddenCount,
                }, adapted.result.ok);
              }
              if (!adapted.result.ok) {
                empty();
                return;
              }
              replace(adapted.result.xml, false);
              return;
            }

            // B 站 JSON XHR 既可能使用默认 text 响应，也可能显式声明
            // responseType=json。两种情况都读取对应的原始载荷。
            if (responseType !== 'text' && responseType !== 'json') return;
            const payload = responseType === 'json' ? rawResponse : JSON.parse(rawText) as unknown;
            const transformed = processPayload(url, payload, configured, options, notify);
            const apply = (value: unknown): void => replace(value, responseType === 'json', true);
            if (transformed && typeof (transformed as PromiseLike<unknown>).then === 'function') {
              void (transformed as PromiseLike<unknown>).then(apply, empty);
            } else {
              apply(transformed);
            }
          } catch {
            empty();
          }
        };
        if (pendingConfig) {
          applyConfigured(pendingConfig);
        } else {
          void resolveConfig(options).then(applyConfigured, () => {
            if (!active) return;
            notify('config-read-failed', undefined, url);
            try {
              Object.defineProperty(this, 'responseText', { configurable: true, get: () => '' });
              Object.defineProperty(this, 'response', { configurable: true, get: () => '' });
            } catch {
              // 浏览器禁止实例覆盖时保持原生 XHR。
            }
          });
        }
      }, { once: true });
      return originalSend.call(this, ...(args as [Document | XMLHttpRequestBodyInit | null | undefined]));
    };
    try {
      Xhr.prototype.open = open as typeof Xhr.prototype.open;
      Xhr.prototype.send = send as typeof Xhr.prototype.send;
    } catch {
      notify('hook-failed', { cause: 'xhr-readonly' });
    }
  }
  if (__TIME_FILTER_DEV__) {
    devLog.log({
      reason: 'hook-installed',
      message: '网络 Hook 已安装',
      details: { xhr: xhrHooked, source: 'network-hook' },
    });
  }

  return {
    installed: true,
    uninstall() {
      if (!active) return;
      active = false;
      if (target.fetch === wrappedFetch) target.fetch = originalFetch;
      if (xhrHooked && Xhr) {
        Xhr.prototype.open = originalOpen;
        Xhr.prototype.send = originalSend;
      }
    },
  };
}

export const installPageNetworkHook = installNetworkHook;
