import { isBeforeCutoff, parseValidatedUnixSeconds, type TimeValidationOptions } from './time';
import type { CommentRecord, FilteredCommentTree } from './types';

export interface CommentFilterOptions extends TimeValidationOptions {
  enabled?: boolean;
}

function id(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function commentId(comment: CommentRecord): string | null {
  return id(comment.rpid);
}

function commentVisible(
  comment: CommentRecord,
  cutoff: string | number | null | undefined,
  options: CommentFilterOptions,
): boolean {
  if (options.enabled === false || cutoff === null || cutoff === undefined || cutoff === '') return true;
  return isBeforeCutoff(comment.ctime, cutoff, options);
}

function childRecords(comment: CommentRecord): CommentRecord[] {
  return Array.isArray(comment.replies) ? comment.replies : [];
}

interface WalkResult {
  record?: CommentRecord;
  hiddenCount: number;
}

/** 递归过滤单条评论；父节点隐藏时不再遍历其后代到展示结果。 */
function filterNode(
  comment: CommentRecord,
  cutoff: string | number | null | undefined,
  options: CommentFilterOptions,
): WalkResult {
  const children = childRecords(comment);
  if (!commentVisible(comment, cutoff, options)) {
    return { hiddenCount: 1 + countNodes(children) };
  }
  let hiddenCount = 0;
  const filteredReplies: CommentRecord[] = [];
  for (const child of children) {
    const result = filterNode(child, cutoff, options);
    hiddenCount += result.hiddenCount;
    if (result.record) filteredReplies.push(result.record);
  }
  // 无论 rcount 是多少，都不凭空生成未收到的历史回复；保留原始 rcount。
  return {
    record: children.length > 0 ? { ...comment, replies: filteredReplies } : { ...comment },
    hiddenCount,
  };
}

function countNodes(records: readonly CommentRecord[]): number {
  return records.reduce((count, comment) => count + 1 + countNodes(childRecords(comment)), 0);
}

/** 统计当前批次收到的评论节点数（含楼中楼），供调用方做展示范围统计。 */
export function countCommentNodes(records: readonly CommentRecord[]): number {
  return countNodes(records);
}

/**
 * 过滤当前已经收到的一级评论和楼中楼。输入记录、元数据均不原地修改，
 * 分页计数和游标应由调用方在 response 外层继续保留。
 */
export function filterCommentTree(
  comments: readonly CommentRecord[],
  cutoff: string | number | null | undefined,
  options: CommentFilterOptions = {},
): FilteredCommentTree {
  let hiddenCount = 0;
  const visible: CommentRecord[] = [];
  for (const comment of comments) {
    const result = filterNode(comment, cutoff, options);
    hiddenCount += result.hiddenCount;
    if (result.record) visible.push(result.record);
  }
  return { comments: visible, hiddenCount };
}

export const filterComments = filterCommentTree;
export const filterCommentRecords = filterCommentTree;

/**
 * 过滤扁平评论列表，按 root/parent 建立父子关系并保证父隐藏时后代不展示。
 * 已经是嵌套 replies 的响应应优先调用 filterCommentTree。
 */
export function filterFlatComments(
  comments: readonly CommentRecord[],
  cutoff: string | number | null | undefined,
  options: CommentFilterOptions = {},
): FilteredCommentTree {
  const byId = new Map<string, CommentRecord>();
  for (const comment of comments) {
    const key = commentId(comment);
    if (key) byId.set(key, comment);
  }
  const visibleIds = new Set<string>();
  const hiddenIds = new Set<string>();
  const visit = (comment: CommentRecord): boolean => {
    const key = commentId(comment);
    if (key && visibleIds.has(key)) return true;
    if (key && hiddenIds.has(key)) return false;
    const parent = id(comment.parent) || id(comment.root);
    const ownVisible = commentVisible(comment, cutoff, options);
    const parentVisible = !parent || parent === key || !byId.has(parent) || visit(byId.get(parent)!);
    const visible = ownVisible && parentVisible;
    if (key) (visible ? visibleIds : hiddenIds).add(key);
    return visible;
  };
  const result: CommentRecord[] = [];
  let hiddenCount = 0;
  for (const comment of comments) {
    if (visit(comment)) result.push({ ...comment });
    else hiddenCount += 1;
  }
  return { comments: result, hiddenCount };
}

/** 从常见 response 包装中提取评论数组，同时原样保留外层元数据。 */
export function filterCommentResponse<T extends Record<string, unknown>>(
  response: T,
  cutoff: string | number | null | undefined,
  options: CommentFilterOptions = {},
): T & { data: unknown } {
  const data = response.data;
  if (Array.isArray(data)) {
    const result = filterCommentTree(data as CommentRecord[], cutoff, options);
    return { ...response, data: result.comments } as T & { data: unknown };
  }
  if (data && typeof data === 'object') {
    const objectData = data as Record<string, unknown>;
    const key = Array.isArray(objectData.replies)
      ? 'replies'
      : Array.isArray(objectData.top_replies)
        ? 'top_replies'
        : Array.isArray(objectData.comments)
          ? 'comments'
          : null;
    if (key) {
      const result = filterCommentTree(objectData[key] as CommentRecord[], cutoff, options);
      return { ...response, data: { ...objectData, [key]: result.comments } } as T & { data: unknown };
    }
  }
  return { ...response } as T & { data: unknown };
}

