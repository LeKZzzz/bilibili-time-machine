import type { DiagnosticEvent, DiagnosticLevel, DiagnosticReason } from './types';

export interface DiagnosticInput {
  level?: DiagnosticLevel;
  reason: DiagnosticReason;
  message?: string;
  url?: string | URL;
  host?: string;
  path?: string;
  route?: string;
  status?: number;
  count?: number;
  details?: Record<string, unknown>;
  at?: number;
}

const SAFE_MESSAGE = /^[\p{L}\p{N}\s._:/-]{0,160}$/u;

/** 将 URL 脱敏为 origin 主机与 pathname；绝不保留 query、hash 或凭据。 */
export function redactUrl(value: unknown): { host?: string; path?: string } {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value));
    return { host: parsed.hostname, path: parsed.pathname || '/' };
  } catch {
    return {};
  }
}

function safeDetails(details: Record<string, unknown> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,40}$/.test(key)) continue;
    if (typeof value === 'string') {
      if (value.length <= 80 && SAFE_MESSAGE.test(value)
        && !/cookie|token|secret|content|comment|body|url/i.test(key)
        && !/^https?:\/\//i.test(value)) {
        result[key] = value;
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 创建可本地记录的诊断事件；输入中的正文、Cookie、查询参数不会进入事件。 */
export function createDiagnosticEvent(input: DiagnosticInput): DiagnosticEvent {
  const redacted = input.url === undefined ? {} : redactUrl(input.url);
  const suppliedHost = typeof input.host === 'string' ? input.host.split(/[/?#]/, 1)[0] : undefined;
  const suppliedPath = typeof input.path === 'string' ? input.path.split(/[?#]/, 1)[0] : undefined;
  const suppliedRoute = typeof input.route === 'string' ? input.route.split(/[?#]/, 1)[0] : undefined;
  const message = typeof input.message === 'string' && SAFE_MESSAGE.test(input.message)
    && !/cookie|token|secret|content|comment|body|https?:\/\//i.test(input.message)
    ? input.message
    : undefined;
  return {
    level: input.level ?? 'info',
    reason: input.reason,
    ...(message ? { message } : {}),
    ...(suppliedHost ?? redacted.host ? { host: suppliedHost ?? redacted.host } : {}),
    ...(suppliedPath ?? redacted.path ? { path: suppliedPath ?? redacted.path } : {}),
    ...(suppliedRoute ? { route: suppliedRoute.slice(0, 80) } : {}),
    ...(typeof input.status === 'number' && Number.isFinite(input.status) ? { status: input.status } : {}),
    ...(typeof input.count === 'number' && Number.isFinite(input.count) ? { count: input.count } : {}),
    ...(safeDetails(input.details) ? { details: safeDetails(input.details) } : {}),
    at: input.at ?? Date.now(),
  };
}

export const makeDiagnosticEvent = createDiagnosticEvent;

export interface DiagnosticSink {
  enabled: boolean;
  emit(event: DiagnosticEvent): void;
}

/** 仅在 debug 开关开启时把脱敏事件交给调用方；默认不产生遥测或 console 输出。 */
export function emitDiagnostic(sink: DiagnosticSink | undefined, input: DiagnosticInput): DiagnosticEvent | null {
  if (!sink?.enabled) return null;
  const event = createDiagnosticEvent(input);
  sink.emit(event);
  return event;
}

export function createMemoryDiagnosticSink(enabled = false): DiagnosticSink & { events: DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  return {
    enabled,
    events,
    emit(event) {
      events.push(event);
    },
  };
}
