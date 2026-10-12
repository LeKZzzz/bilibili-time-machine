import { describe, expect, it } from 'vitest';
import fixture from '../fixtures/core-comments.json';
import { filterCommentTree, filterFlatComments } from '../../src/core/comments';

const cutoff = 1760000060;

describe('core comments', () => {
  it('cascades hidden parents and preserves loaded replies only', () => {
    const result = filterCommentTree(fixture.data.replies, cutoff, { nowSeconds: 1760000200 });
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].rpid).toBe(1);
    expect(result.comments[0].replies).toEqual([]);
    expect(result.hiddenCount).toBe(3);
  });

  it('keeps flat child hidden when its parent is hidden', () => {
    const result = filterFlatComments([
      { rpid: 1, ctime: 1760000100 },
      { rpid: 11, root: 1, parent: 1, ctime: 1759999000 },
    ], cutoff, { nowSeconds: 1760000200 });
    expect(result.comments).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });
});

