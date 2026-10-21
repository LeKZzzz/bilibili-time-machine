import { describe, expect, it } from 'vitest';
import {
  SEARCH_PAGE_PROBE_LIMIT,
  SEARCH_PAGE_SIZE_FALLBACK,
  decideSearchItem,
  needsRepagination,
  normalizeSearchResultRecord,
  planSearchReflow,
  replaceSearchPayloadItems,
  replaceSearchPayloadSummary,
  searchFooterSummary,
  searchItemId,
  shouldProbeMorePages,
  type SearchPageSnapshot,
} from '../../src/core/search-repagination';

const CUTOFF = '2020-01-01T00:00';
/** 2019-06-01T00:00:00Z，早于 CUTOFF。 */
const BEFORE = 1559347200;
/** 2025-01-01T00:00:00Z，晚于 CUTOFF。 */
const AFTER = 1735689600;

interface ItemSpec {
  bvid: string;
  pubdate?: number;
}

function snapshot(page: number, specs: ItemSpec[]): SearchPageSnapshot {
  return {
    page,
    items: specs.map((spec) => {
      const record = spec.pubdate === undefined ? { bvid: spec.bvid } : { bvid: spec.bvid, pubdate: spec.pubdate };
      return { id: searchItemId(record, page * 100000 + specs.indexOf(spec)), record };
    }),
  };
}

describe('search repagination core', () => {
  it('exposes bounded defaults', () => {
    expect(SEARCH_PAGE_PROBE_LIMIT).toBe(2);
    expect(SEARCH_PAGE_SIZE_FALLBACK).toBe(30);
  });

  it('triggers only when visible results fall below half a page', () => {
    expect(shouldProbeMorePages(4, 10)).toBe(true);
    expect(shouldProbeMorePages(5, 10)).toBe(false);
    expect(shouldProbeMorePages(0, 0)).toBe(false);
    expect(needsRepagination(3, 8)).toBe(true);
  });

  it('normalizes video, dynamic and unknown entries', () => {
    expect(normalizeSearchResultRecord({ bvid: 'BV1', pubdate: BEFORE })).toMatchObject({ bvid: 'BV1' });
    expect(normalizeSearchResultRecord({ modules: { module_author: { pub_ts: BEFORE } } })).toEqual({ pubdate: BEFORE });
    expect(normalizeSearchResultRecord({ type: 'dynamic', id_str: 'x', pub_ts: BEFORE })).toEqual({ pubdate: BEFORE });
    expect(normalizeSearchResultRecord({ title: 'no time' })).toBeNull();
    expect(normalizeSearchResultRecord(null)).toBeNull();
  });

  it('derives stable dedupe ids with BV, aid and position fallbacks', () => {
    expect(searchItemId({ bvid: 'bv1abc' }, 0)).toBe('bvid:BV1ABC');
    expect(searchItemId({ aid: 42 }, 1)).toBe('aid:42');
    expect(searchItemId(null, 7)).toBe('pos:7');
  });

  it('classifies visible records and hides unknown times', () => {
    expect(decideSearchItem({ bvid: 'BV1', pubdate: BEFORE }, { cutoff: CUTOFF, enabled: true })).toBe('keep');
    expect(decideSearchItem({ bvid: 'BV2', pubdate: AFTER }, { cutoff: CUTOFF, enabled: true })).toBe('hide');
    expect(decideSearchItem({ bvid: 'BV3' }, { cutoff: CUTOFF, enabled: true })).toBe('hide');
    expect(decideSearchItem(null, { cutoff: CUTOFF, enabled: true })).toBe('hide');
  });

  it('compacts visible results across pages into the original page capacity', () => {
    const plan = planSearchReflow([
      snapshot(1, [
        { bvid: 'BVoldA', pubdate: BEFORE },
        { bvid: 'BVnewB', pubdate: AFTER },
        { bvid: 'BVoldC', pubdate: BEFORE },
        { bvid: 'BVnewD', pubdate: AFTER },
      ]),
      snapshot(2, [
        { bvid: 'BVoldE', pubdate: BEFORE },
        { bvid: 'BVoldF', pubdate: BEFORE },
        { bvid: 'BVnewG', pubdate: AFTER },
        { bvid: 'BVoldH', pubdate: BEFORE },
      ]),
      snapshot(3, [
        { bvid: 'BVoldI', pubdate: BEFORE },
        { bvid: 'BVnewJ', pubdate: AFTER },
      ]),
    ], { cutoff: CUTOFF, enabled: true, originalPage: 1, endPage: 3, capacity: 4 });

    expect(plan.total).toBe(6);
    expect(plan.pageCount).toBe(2);
    expect(plan.originalVisible).toBe(2);
    expect(plan.pages.get(1)).toEqual(['bvid:BVOLDA', 'bvid:BVOLDC', 'bvid:BVOLDE', 'bvid:BVOLDF']);
    expect(plan.pages.get(2)).toEqual(['bvid:BVOLDH', 'bvid:BVOLDI']);
    expect(plan.states.get('bvid:BVOLDE')).toBe('advance');
    expect(plan.states.get('bvid:BVOLDH')).toBe('keep');
    expect(plan.advancedIds.has('bvid:BVOLDE')).toBe(true);
  });

  it('deduplicates repeated BV ids and keeps the first occurrence', () => {
    const dup = { bvid: 'BVdup', pubdate: BEFORE };
    const plan = planSearchReflow([
      { page: 1, items: [{ id: searchItemId(dup, 0), record: dup }] },
      { page: 2, items: [{ id: searchItemId(dup, 0), record: { ...dup } }] },
    ], { cutoff: CUTOFF, enabled: true, originalPage: 1, endPage: 2, capacity: 4 });
    expect(plan.total).toBe(1);
    expect(plan.states.get('bvid:BVDUP')).toBe('keep');
  });

  it('reports footer totals and page counts from the scanned range', () => {
    const plan = planSearchReflow([
      snapshot(1, [{ bvid: 'BV1', pubdate: BEFORE }, { bvid: 'BV2', pubdate: BEFORE }]),
    ], { cutoff: CUTOFF, enabled: true, originalPage: 1, endPage: 1, capacity: 4 });
    const footer = searchFooterSummary(plan);
    expect(footer).toEqual({ total: 2, pages: 1, currentPage: 1, pageSize: 4 });
  });

  it('replaces the result array while preserving page metadata', () => {
    const payload = { code: 0, data: { page: 2, numPages: 9, numResults: 180, result: [{ bvid: 'BV1' }, { bvid: 'BV2' }] } };
    const next = replaceSearchPayloadItems(payload, [{ bvid: 'BV2' }]) as typeof payload;
    expect(next.data.page).toBe(2);
    expect(next.data.numPages).toBe(9);
    expect(next.data.result).toEqual([{ bvid: 'BV2' }]);
    expect(replaceSearchPayloadItems({ data: {} }, [])).toEqual({ data: {} });
  });

  it('replaces only the video group in the all/v2 wrapped response', () => {
    const payload = {
      code: 0,
      data: {
        page: 1,
        result: [
          { result_type: 'activity', data: [{ id: 'activity-1' }] },
          { result_type: 'video', data: [{ bvid: 'BV1' }, { bvid: 'BV2' }] },
        ],
      },
    };
    const next = replaceSearchPayloadItems(payload, [{ bvid: 'BV1' }]) as typeof payload;
    expect(next.data.result[0]).toEqual(payload.data.result[0]);
    expect((next.data.result[1] as { data: unknown[] }).data).toEqual([{ bvid: 'BV1' }]);
  });

  it('updates existing search total and page-count metadata', () => {
    const payload = { data: { numResults: 180, numPages: 9, pageinfo: { video: { numResults: 180, numPages: 9 } }, result: [] } };
    expect(replaceSearchPayloadSummary(payload, { total: 6, pages: 2 })).toEqual({
      data: { numResults: 6, numPages: 2, pageinfo: { video: { numResults: 6, numPages: 2 } }, result: [] },
    });
  });

  it('keeps non-video entries when a wrapped search group contains ads or courses', () => {
    const plan = planSearchReflow([
      { page: 1, items: [
        { id: 'pos:1', record: null, filterable: false },
        { id: 'bvid:BVOLD', record: { bvid: 'BVOLD', pubdate: BEFORE } },
      ] },
    ], { cutoff: CUTOFF, enabled: true, originalPage: 1, endPage: 1, capacity: 2 });
    expect(plan.pages.get(1)).toEqual(['pos:1', 'bvid:BVOLD']);
  });
});
