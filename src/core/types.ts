/** 跨运行时共享的数据类型。核心模块不依赖浏览器或扩展 API。 */

export type UnixSeconds = number;

export interface FilterConfig {
  /** 本地日期时间输入，例如 2026-09-22T12:34:05；null 表示未设置。 */
  cutoffMinute: string | null;
  enabled: boolean;
  supplementBudget: number;
  debug: boolean;
  /** 是否按启动时刻持续向后推进截止时间。 */
  autoAdvance?: boolean;
  /** 自动推进的启动时刻，Unix 毫秒。 */
  autoAdvanceStartedAt?: number | null;
  /** 自动推进启动时的截止时间，用于刷新页面后恢复进度。 */
  autoAdvanceBaseCutoffMinute?: string | null;
  /** 首页收藏标签补位（默认关闭）。 */
  favoriteHomeFillEnabled?: boolean;
  favoriteFolderIds?: string[];
  favoriteFolderLimit?: number;
  favoriteVideoLimit?: number;
  favoriteRefreshRequestedAt?: number | null;
}

/** 当前登录账号可选择的收藏夹元数据。 */
export interface FavoriteFolderOption {
  id: string;
  title: string;
  mediaCount?: number;
  isDefault?: boolean;
}

export const DEFAULT_FILTER_CONFIG: Readonly<FilterConfig> = {
  cutoffMinute: null,
  enabled: false,
  supplementBudget: 20,
  debug: false,
  autoAdvance: false,
  autoAdvanceStartedAt: null,
  autoAdvanceBaseCutoffMinute: null,
  favoriteHomeFillEnabled: false,
  favoriteFolderIds: [],
  favoriteFolderLimit: 3,
  favoriteVideoLimit: 50,
  favoriteRefreshRequestedAt: null,
};

export interface VideoRecord {
  bvid?: string;
  aid?: number | string;
  title?: string;
  pubdate?: number | string | null;
  pic?: string | null;
  /** 部分接口把主视频记录包在 archive/video 字段中。 */
  [key: string]: unknown;
}

export interface VideoVisibility {
  visible: boolean;
  reason: 'before-cutoff' | 'at-or-after-cutoff' | 'unknown-time' | 'filter-disabled';
  timestamp: UnixSeconds | null;
  record: VideoRecord;
}

export interface VideoSupplementCandidate {
  bvid: string;
  index: number;
  record: VideoRecord;
}

export interface SupplementPlan {
  candidates: VideoSupplementCandidate[];
  budget: number;
  concurrency: number;
}

export interface CommentRecord {
  rpid?: number | string;
  oid?: number | string;
  root?: number | string | null;
  parent?: number | string | null;
  ctime?: number | string | null;
  content?: unknown;
  replies?: CommentRecord[] | null;
  rcount?: number | string | null;
  [key: string]: unknown;
}

export interface FilteredCommentTree {
  /** 过滤后的展示记录；原记录不会被修改。 */
  comments: CommentRecord[];
  /** 接口元数据原样保留，调用方可继续使用分页和计数信息。 */
  metadata?: Record<string, unknown>;
  hiddenCount: number;
}

export interface DanmakuRecord {
  raw: string;
  attributes: string;
  fields: string[];
  timestamp: UnixSeconds | null;
}

export interface DanmakuFilterResult {
  ok: boolean;
  xml: string;
  records: DanmakuRecord[];
  hiddenCount: number;
  reason?: 'invalid-xml' | 'invalid-time' | 'empty';
}

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticReason =
  | 'config-pending'
  | 'config-read-failed'
  | 'parse-failed'
  | 'unknown-time'
  | 'supplement-failed'
  | 'hook-failed'
  | 'unsupported-route'
  | 'other'
  // 以下事件只在开发日志构建（__TIME_FILTER_DEV__）中产生，发布构建不输出。
  | 'config-loaded'
  | 'config-changed'
  | 'config-bridged'
  | 'hook-installed'
  | 'native-date'
  | 'network-filtered'
  | 'network-bypassed'
  | 'card-decision'
  | 'main-video-decision'
  | 'dynamic-decision'
  | 'supplement-plan'
  | 'supplement-start'
  | 'supplement-success'
  | 'repagination';

export interface DiagnosticEvent {
  level: DiagnosticLevel;
  reason: DiagnosticReason;
  message?: string;
  host?: string;
  path?: string;
  route?: string;
  status?: number;
  count?: number;
  /** 只允许脱敏的键值，不应放正文、Cookie 或查询字符串。 */
  details?: Record<string, string | number | boolean | null>;
  at: number;
}

