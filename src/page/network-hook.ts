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

function resolveConfig(options: NetworkHookOptions): FilterConfig | Promise<FilterConfig> {
  if (options.getConfig) return options.getConfig();
  if (options.config && typeof (options.config as Promise<FilterConfig>).then === 'function') return options.config;
  if (options.config) return options.config;
  throw new Error('filter configuration is unavailable');
}

/**
 * 内置适配器都是同步的，因此 XHR 的属性读取可以在返回给页面之前完成过滤。
 * 只有调用方提供 onResponse 且返回
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
  const responseTextDescriptor = Xhr && Object.getOwnPropertyDescriptor(Xhr.prototype, 'responseText');
  const responseDescriptor = Xhr && Object.getOwnPropertyDescriptor(Xhr.prototype, 'response');
  const nativeText = responseTextDescriptor?.get;
  const nativeResponse = responseDescriptor?.get;
  const xhrHooked = typeof originalOpen === 'function' && !!nativeText && !!nativeResponse;
  if (xhrHooked) {
    const open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      const requestUrl = String(url);
      const controlled = isCommentUrl(requestUrl) || isDanmakuUrl(requestUrl) || isDynamicUrl(requestUrl) || isVideoResponseUrl(requestUrl);
      // 未知配置按早于所有有效 Unix 时间的截止值隐藏已识别列表，保留响应包装与分页元数据。
      const hiddenConfig: FilterConfig = { cutoffMinute: '0001-01-01T00:00', enabled: true, supplementBudget: 0, debug: false };
      let configured: FilterConfig | undefined;
      let pendingConfig: Promise<FilterConfig> | undefined;
      let pendingNotified = false;
      let configFailed = false;
      let cache: { raw: unknown; key: string; value: unknown; text: string } | undefined;
      const readConfig = (announcePending = true): FilterConfig => {
        try {
          const value = resolveConfig(options);
          if (value && typeof (value as Promise<FilterConfig>).then === 'function') {
            const promise = value as Promise<FilterConfig>;
            if (promise !== pendingConfig) {
              pendingConfig = promise;
              void promise.then((config) => {
                if (pendingConfig === promise) configured = config;
              }, () => {
                if (pendingConfig !== promise) return;
                configured = undefined;
                if (!configFailed) notify('config-read-failed', undefined, requestUrl);
                configFailed = true;
              });
            }
            if (announcePending && !configured && !configFailed && !pendingNotified) {
              notify('config-pending', undefined, requestUrl);
              pendingNotified = true;
            }
            return configured ?? hiddenConfig;
          }
          configured = value as FilterConfig;
          pendingConfig = undefined;
          return configured;
        } catch {
          if (!configFailed) notify('config-read-failed', undefined, requestUrl);
          configFailed = true;
          return hiddenConfig;
        }
      };
      // 提前接收网络期间已就绪的异步配置，避免首次消费时再等待一个微任务。
      if (controlled) readConfig(false);
      const read = (asText: boolean): unknown => {
        // 先调用原生 getter，保留 responseType=json 时 responseText 抛错等浏览器语义。
        const raw = (asText ? nativeText : nativeResponse)!.call(this) as unknown;
        const responseType = this.responseType || 'text';
        if (!active || !controlled || (isDanmakuUrl(requestUrl)
          ? responseType !== 'text'
          : responseType !== 'text' && responseType !== 'json')) return raw;
        if (this.readyState < 3) return raw;
        const config = readConfig();
        if (!config.enabled) {
          if (__TIME_FILTER_DEV__) logBypassed(requestUrl);
          return raw;
        }
        // 文本响应在 LOADING 阶段可能只有半份 JSON，不能向页面泄漏未过滤片段。
        if (this.readyState !== 4) return responseType === 'json' ? null : '';
        const key = JSON.stringify(config);
        if (!cache || cache.raw !== raw || cache.key !== key) {
          const current = { raw, key, value: null as unknown, text: '' };
          cache = current;
          const apply = (value: unknown): void => {
            current.value = value;
            current.text = responseType === 'json' || !isDanmakuUrl(requestUrl) ? JSON.stringify(value) : String(value);
          };
          try {
            if (isDanmakuUrl(requestUrl)) {
              const adapted = adaptDanmakuResponse(requestUrl, raw, { cutoff: config.cutoffMinute, enabled: true });
              if (!adapted.result.ok) notify('parse-failed', { adapter: 'danmaku' }, requestUrl);
              if (__TIME_FILTER_DEV__) logNetwork(requestUrl, 'danmaku', {
                total: adapted.result.records.length + adapted.result.hiddenCount,
                visible: adapted.result.records.length,
                hidden: adapted.result.hiddenCount,
              }, adapted.result.ok);
              apply(adapted.result.xml);
            } else {
              const payload = responseType === 'json' ? raw : JSON.parse(String(raw)) as unknown;
              // 配置未知时不调用会补请求或补内容的搜索委托。
              const effectiveOptions = config === hiddenConfig ? { ...options, filterVideoResponse: undefined } : options;
              const transformed = processPayload(requestUrl, payload, config, effectiveOptions, notify);
              if (transformed && typeof (transformed as Promise<unknown>).then === 'function') {
                apply(processPayload(requestUrl, payload, hiddenConfig, { ...options, filterVideoResponse: undefined, onResponse: undefined }, notify));
                void (transformed as Promise<unknown>).then(apply, () => notify('parse-failed', undefined, requestUrl));
              } else apply(transformed);
            }
          } catch {
            notify('parse-failed', undefined, requestUrl);
          }
        }
        return responseType === 'json' ? cache.value : cache.text;
      };
      try {
        Object.defineProperties(this, {
          responseText: { configurable: true, enumerable: responseTextDescriptor.enumerable, get: () => read(true) },
          response: { configurable: true, enumerable: responseDescriptor.enumerable, get: () => read(false) },
        });
      } catch {
        notify('hook-failed', { cause: 'xhr-response-readonly' }, requestUrl);
      }
      return originalOpen.call(
        this,
        method,
        requestUrl,
        (rest[0] as boolean | undefined) ?? true,
        (rest[1] as string | undefined) ?? '',
        (rest[2] as string | undefined) ?? '',
      );
    };
    try {
      Xhr.prototype.open = open as typeof Xhr.prototype.open;
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
      }
    },
  };
}

export const installPageNetworkHook = installNetworkHook;
