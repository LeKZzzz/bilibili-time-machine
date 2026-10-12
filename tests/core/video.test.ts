import { describe, expect, it } from 'vitest';
import records from '../fixtures/core-video.json';
import { classifyVideo, filterPartsByMainVideo, filterVideos, planVideoSupplements } from '../../src/core/video';

const cutoff = 1760000060;

describe('core video', () => {
  it('hides exact, late and unknown timestamps while keeping the cover coupled', () => {
    expect(filterVideos(records, cutoff, { nowSeconds: 1760000200 }).map((record) => record.bvid)).toEqual(['BVbefore']);
    expect(classifyVideo(records[1], cutoff, { nowSeconds: 1760000200 }).reason).toBe('at-or-after-cutoff');
    expect(classifyVideo(records[2], cutoff, { nowSeconds: 1760000200 }).reason).toBe('unknown-time');
  });

  it('plans only bounded page-visible supplement candidates', () => {
    const plan = planVideoSupplements(records, 20, { nowSeconds: 1760000200 });
    expect(plan.candidates.map((item) => item.bvid)).toEqual(['BVunknown', 'BVsupplement']);
    expect(plan.concurrency).toBe(3);
    expect(planVideoSupplements(records, 0).candidates).toEqual([]);
    expect(planVideoSupplements([...records, ...records], 100).candidates).toHaveLength(2);
  });

  it('uses the main video timestamp for all parts', () => {
    expect(filterPartsByMainVideo([{ page: 1 }], records[0], cutoff)).toEqual([{ page: 1 }]);
    expect(filterPartsByMainVideo([{ page: 2 }], records[1], cutoff)).toEqual([]);
  });
});

