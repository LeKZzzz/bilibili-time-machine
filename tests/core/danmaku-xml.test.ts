import { describe, expect, it } from 'vitest';
import xml from '../fixtures/core-danmaku.xml?raw';
import { filterDanmakuXml, parseDanmakuXml } from '../../src/core/danmaku-xml';

const cutoff = 1760000060;

describe('core XML danmaku', () => {
  it('keeps only p[4] strictly earlier than cutoff', () => {
    const result = filterDanmakuXml(xml, cutoff, { nowSeconds: 1760000200 });
    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].raw).toBe('before');
    expect(result.xml).toContain('before');
    expect(result.xml).not.toContain('exact');
    expect(result.xml).not.toContain('after');
  });

  it('drops malformed, empty and invalid-time input instead of returning original', () => {
    expect(filterDanmakuXml('', cutoff).xml).toBe('');
    expect(filterDanmakuXml('<i><d p="1,2,3">x</d></i>', cutoff).ok).toBe(false);
    expect(filterDanmakuXml('<i><d p="1,2,3,4,nope">x</d></i>', cutoff).xml).toBe('');
    expect(parseDanmakuXml('<i><d p="1,2,3,4,1">x</d></i>', { nowSeconds: 100 })).toMatchObject({ ok: true });
    expect(filterDanmakuXml('<i><d p="1,2,3,4,1">x</i>', cutoff).reason).toBe('invalid-xml');
  });
});
