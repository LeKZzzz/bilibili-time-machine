import { countCommentNodes, filterFlatComments, filterCommentTree, type CommentFilterOptions } from '../core/comments';
import type { CommentRecord, FilteredCommentTree } from '../core/types';

export interface CommentAdapterOptions extends CommentFilterOptions {
  cutoff: string | number | null | undefined;
}

export interface CommentAdaptResult<T = unknown> {
  handled: boolean;
  payload: T;
  hiddenCount: number;
  /** 本批次收到的评论节点总数（含楼中楼）。 */
  totalCount: number;
  /** 过滤后保留的评论节点数。 */
  visibleCount: number;
  reason?: 'unsupported-shape' | 'parse-failed';
}

const COMMENT_PATH = /\/(?:x\/v2\/)?reply(?:\/|$)|\/reply\/main(?:\/|$)/i;

export function isCommentUrl(url: string): boolean {
  try {
    return COMMENT_PATH.test(new URL(url, window.location.href).pathname);
  } catch {
    return COMMENT_PATH.test(url.split('?')[0]);
  }
}

function collectComments(payload: unknown): { comments: CommentRecord[]; replace: (comments: CommentRecord[]) => unknown } | null {
  if (Array.isArray(payload)) {
    return { comments: payload as CommentRecord[], replace: (comments) => comments };
  }
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    return { comments: root.data as CommentRecord[], replace: (comments) => ({ ...root, data: comments }) };
  }
  if (root.data && typeof root.data === 'object') {
    const data = root.data as Record<string, unknown>;
    for (const key of ['replies', 'top_replies', 'comments', 'repliesList']) {
      if (Array.isArray(data[key])) {
        return {
          comments: data[key] as CommentRecord[],
          replace: (comments) => ({ ...root, data: { ...data, [key]: comments } }),
        };
      }
    }
  }
  return null;
}

/** 判断响应中的数组是否是按 root/parent 展开的扁平评论列表。 */
function isFlatCommentList(comments: readonly CommentRecord[]): boolean {
  // 嵌套 replies 优先按树处理；扁平响应通常没有 replies 数组，且至少带一条父子引用。
  if (comments.some((comment) => Array.isArray(comment.replies))) return false;
  return comments.some((comment) => {
    const root = comment.root;
    const parent = comment.parent;
    return (root !== null && root !== undefined && root !== '' && root !== 0 && root !== '0')
      || (parent !== null && parent !== undefined && parent !== '' && parent !== 0 && parent !== '0');
  });
}

function filterCollectedComments(
  comments: readonly CommentRecord[],
  options: CommentAdapterOptions,
): { comments: CommentRecord[]; hiddenCount: number } {
  return isFlatCommentList(comments)
    ? filterFlatComments(comments, options.cutoff, options)
    : filterCommentTree(comments, options.cutoff, options);
}

/** 适配当前页面已收到的评论响应；不触碰 all_count、分页游标等外层元数据。 */
export function adaptCommentPayload<T = unknown>(payload: T, options: CommentAdapterOptions): CommentAdaptResult<T> {
  const found = collectComments(payload);
  if (!found) return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'unsupported-shape' };
  try {
    const totalCount = countCommentNodes(found.comments);
    const filtered = filterCollectedComments(found.comments, options);
    return {
      handled: true,
      payload: found.replace(filtered.comments) as T,
      hiddenCount: filtered.hiddenCount,
      totalCount,
      visibleCount: Math.max(0, totalCount - filtered.hiddenCount),
    };
  } catch {
    return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'parse-failed' };
  }
}

/** 处理带 data 包装的评论响应，作为与核心保持一致的便捷入口。 */
export function adaptCommentResponse<T extends Record<string, unknown>>(
  payload: T,
  options: CommentAdapterOptions,
): CommentAdaptResult<T> {
  const found = collectComments(payload);
  if (!found) return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'unsupported-shape' };
  try {
    const totalCount = countCommentNodes(found.comments);
    const filtered = filterCollectedComments(found.comments, options);
    return {
      handled: true,
      payload: found.replace(filtered.comments) as T,
      hiddenCount: filtered.hiddenCount,
      totalCount,
      visibleCount: Math.max(0, totalCount - filtered.hiddenCount),
    };
  } catch {
    return { handled: false, payload, hiddenCount: 0, totalCount: 0, visibleCount: 0, reason: 'parse-failed' };
  }
}

export type CommentTreeFilter = (
  comments: readonly CommentRecord[],
  cutoff: string | number | null | undefined,
  options?: CommentFilterOptions,
) => FilteredCommentTree;

