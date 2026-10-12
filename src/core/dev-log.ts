/**
 * 开发构建专用的脱敏诊断日志。
 *
 * 发布构建中 Vite 把 `__TIME_FILTER_DEV__` 折叠为 `false`；所有调用点都写成
 * `if (__TIME_FILTER_DEV__) devLog.log(...)`，因此发布产物不会构造日志数据，
 * 也不会包含这里的 console 适配器（整个模块可被 Tree Shaking 移除）。
 * 开发构建自动启用，不受配置里的 `debug` 字段影响；`debug` 字段仅为存储兼容保留。
 *
 * 事件在输出前经过 `createDiagnosticEvent` 脱敏：URL 只保留主机与路径，
 * 响应正文、评论内容、Cookie、查询参数和疑似凭据字段一律不进入日志。
 */
import { createDiagnosticEvent, type DiagnosticInput } from './diagnostics';
import type { DiagnosticEvent, FilterConfig, VideoRecord, VideoVisibility } from './types';

export interface DevLogInput extends DiagnosticInput {
  /** 高频事件（逐卡判定等）的去重键；相同键在本次会话只输出一次。 */
  key?: string;
}

export type DevLogSink = (label: string, event: DiagnosticEvent) => void;

export interface DevLogger {
  log(input: DevLogInput): void;
}

/** console 中可直接用该前缀过滤本项目的全部开发日志。 */
export const DEV_LOG_PREFIX = '[时光机]';

/** 去重键上限；超过后清空，避免长会话无限增长。 */
const DEDUPE_LIMIT = 1000;

export function formatDevLogLabel(event: DiagnosticEvent): string {
  return event.message ? `${DEV_LOG_PREFIX} ${event.reason} · ${event.message}` : `${DEV_LOG_PREFIX} ${event.reason}`;
}

function defaultSink(label: string, event: DiagnosticEvent): void {
  console.debug(label, event);
}

/** 创建写入浏览器 console 的适配器；只有开发构建会实例化它。 */
export function createConsoleDevLog(write: DevLogSink = defaultSink): DevLogger {
  const seen = new Set<string>();
  return {
    log(input) {
      const key = input.key;
      if (key) {
        if (seen.has(key)) return;
        if (seen.size >= DEDUPE_LIMIT) seen.clear();
        seen.add(key);
      }
      const event = createDiagnosticEvent(input);
      write(formatDevLogLabel(event), event);
    },
  };
}

/** 与开发适配器同形的空实现，保证误用时不产生任何输出。 */
export function createNoopDevLog(): DevLogger {
  return { log: () => undefined };
}

/** 开发构建输出到 console；发布构建为 noop，且所有调用点都被编译期移除。 */
export const devLog: DevLogger = __TIME_FILTER_DEV__ ? createConsoleDevLog() : createNoopDevLog();

/** 逐卡判定的日志键：同一来源下结论相同的卡片只输出一次。 */
export function cardLogKey(record: VideoRecord, decision: VideoVisibility, cutoff: unknown, source: string): string {
  const bvid = typeof record.bvid === 'string' && record.bvid ? record.bvid : null;
  const aid = record.aid === undefined || record.aid === null ? null : String(record.aid);
  return `card:${source}:${bvid ?? aid ?? 'unknown'}:${decision.reason}:${decision.timestamp ?? 'null'}:${cutoff ?? 'none'}`;
}

/** 构造逐卡日志：bvid、发布时间、截止时间、判定原因和可见性。 */
export function cardDecisionLog(
  record: VideoRecord,
  decision: VideoVisibility,
  cutoff: string | number | null | undefined,
  source: string,
): DevLogInput {
  return {
    reason: source === 'main-video' ? 'main-video-decision' : 'card-decision',
    message: '内容时间判定',
    key: cardLogKey(record, decision, cutoff, source),
    details: {
      bvid: typeof record.bvid === 'string' && record.bvid ? record.bvid : null,
      pubdate: decision.timestamp,
      cutoff: cutoff === null || cutoff === undefined ? null : String(cutoff),
      verdict: decision.reason,
      visible: decision.visible,
      source,
      dateOnly: (record as Record<string, unknown>).__dateOnly === true,
    },
  };
}

/** 构造配置日志：启用状态、截止时间、补请求预算和自动推进状态。 */
export function configLog(
  reason: 'config-loaded' | 'config-changed' | 'config-bridged',
  config: FilterConfig,
  source: string,
): DevLogInput {
  const message = reason === 'config-bridged'
    ? '主世界已接收桥接配置'
    : reason === 'config-changed'
      ? '配置已更新'
      : '配置已读取';
  return {
    reason,
    message,
    details: {
      enabled: config.enabled,
      cutoff: config.cutoffMinute,
      budget: config.supplementBudget,
      debug: config.debug,
      autoAdvance: config.autoAdvance === true,
      source,
    },
  };
}

/** 构造补请求计划日志：候选数量、预算和并发上限。 */
export function supplementPlanLog(source: string, candidates: number, budget: number, concurrency: number): DevLogInput {
  return {
    reason: 'supplement-plan',
    message: '补请求计划',
    key: `supplement-plan:${source}:${candidates}:${budget}:${concurrency}`,
    details: { source, candidates, budget, concurrency },
  };
}

/** 构造补请求开始日志：只记录 bvid 和队列/并发信息，不含标题或响应正文。 */
export function supplementStartLog(source: string, bvid: string, concurrency: number): DevLogInput {
  return {
    reason: 'supplement-start',
    message: '开始补请求',
    key: `supplement-start:${source}:${bvid}`,
    details: { source, bvid, concurrency },
  };
}

/** 构造补请求成功日志：记录 bvid 与解析出的发布日期。 */
export function supplementSuccessLog(source: string, bvid: string, pubdate: number | null): DevLogInput {
  return {
    reason: 'supplement-success',
    message: '补请求成功',
    key: `supplement-success:${source}:${bvid}`,
    details: { source, bvid, pubdate },
  };
}

/** 构造补请求失败日志：记录 bvid 与脱敏原因。 */
export function supplementFailedLog(source: string, bvid: string | null, cause: string): DevLogInput {
  return {
    reason: 'supplement-failed',
    message: '补请求失败',
    key: `supplement-failed:${source}:${bvid ?? 'unknown'}:${cause}`,
    details: { source, bvid, cause },
  };
}

/** 构造 B 站原生日期筛选日志：记录计算出的截止日 `pubtime_end_s` 与是否命中。 */
export function nativeDateLog(
  cutoff: string,
  computedStartSeconds: number | null,
  computedEndSeconds: number | null,
  matched: boolean,
): DevLogInput {
  const endDate = /^(\d{4}-\d{2}-\d{2})T/.exec(cutoff)?.[1] ?? null;
  return {
    reason: 'native-date',
    message: '原生日期筛选',
    key: `native-date:${cutoff}:${computedStartSeconds ?? 'none'}:${computedEndSeconds ?? 'none'}:${matched}`,
    details: {
      cutoff,
      startDate: '2009-06-26',
      endDate,
      pubtime_begin_s: computedStartSeconds,
      pubtime_end_s: computedEndSeconds,
      matched,
    },
  };
}
