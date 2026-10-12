import { describe, expect, it } from 'vitest';
import { adaptDynamicPayload, isDynamicUrl } from '../../src/page/dynamic-adapter';

describe('dynamic adapter', () => {
  it('recognises both dynamic feed endpoints', () => {
    expect(isDynamicUrl('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all')).toBe(true);
    expect(isDynamicUrl('https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/feed/space')).toBe(true);
    expect(isDynamicUrl('https://api.bilibili.com/x/web-interface/search')).toBe(false);
  });

  it('filters items by author publish timestamp and keeps metadata', () => {
    const result = adaptDynamicPayload({ data: { offset: 'cursor', has_more: true, items: [
      { id_str: 'before', modules: { module_author: { pub_ts: 1546300800 } } },
      { id_str: 'after', modules: { module_author: { pub_ts: 1609459200 } } },
    ] } }, { cutoff: '2020-01-01T00:00', enabled: true });
    expect(result.handled).toBe(true);
    expect(result.hiddenCount).toBe(1);
    expect((result.payload as { data: { offset: string; items: Array<{ id_str: string }> } }).data).toEqual({
      offset: 'cursor', has_more: true, items: [{ id_str: 'before', modules: { module_author: { pub_ts: 1546300800 } } }],
    });
  });

  it('hides an item whose timestamp cannot be verified', () => {
    const result = adaptDynamicPayload({ data: { items: [{ id_str: 'unknown' }] } }, { cutoff: '2020-01-01T00:00', enabled: true });
    expect(result.hiddenCount).toBe(1);
    expect((result.payload as { data: { items: unknown[] } }).data.items).toHaveLength(0);
  });
});
