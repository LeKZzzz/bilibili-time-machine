import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FUTURE_TOLERANCE_SECONDS,
  isBeforeCutoff,
  parseLocalMinute,
  parseValidatedUnixSeconds,
} from '../../src/core/time';

describe('core time', () => {
  it('parses local minute and rejects invalid calendar values', () => {
    const parsed = parseLocalMinute('2025-01-02T03:04');
    expect(parsed).toBe(new Date(2025, 0, 2, 3, 4, 0, 0).getTime() / 1000);
    expect(parseLocalMinute('2025-02-29T03:04')).toBeNull();
    expect(parseLocalMinute('2025-01-02')).toBeNull();
    expect(parseLocalMinute('2025-01-02T03:04:05')).toBe(new Date(2025, 0, 2, 3, 4, 5, 0).getTime() / 1000);
  });

  it('parses explicit UTC offsets and rejects invalid offset dates and seconds', () => {
    expect(parseLocalMinute('2025-01-02T03:04-05:00')).toBe(Date.UTC(2025, 0, 2, 8, 4) / 1000);
    expect(parseLocalMinute('2025-01-02T03:04:05+05:30')).toBe(Date.UTC(2025, 0, 1, 21, 34, 5) / 1000);
    expect(parseLocalMinute('2025-02-29T03:04-05:00')).toBeNull();
    expect(parseLocalMinute('2025-04-31T03:04-05:00')).toBeNull();
    expect(parseLocalMinute('2025-01-02T24:00-05:00')).toBeNull();
    expect(parseLocalMinute('2025-01-02T03:04:60-05:00')).toBeNull();
    expect(parseLocalMinute('2025-01-02T03:04+24:00')).toBeNull();
    expect(parseLocalMinute('2025-01-02T03:04-05:60')).toBeNull();
    expect(parseLocalMinute('2025-01-02T03:04-05')).toBeNull();
    expect(new Date(parseLocalMinute('0001-01-02T03:04+05:30')! * 1000).toISOString()).toBe('0001-01-01T21:34:00.000Z');
  });

  it('uses strict before comparison and a five-minute future clock bound', () => {
    expect(isBeforeCutoff(100, 101, { nowSeconds: 1000 })).toBe(true);
    expect(isBeforeCutoff(101, 101, { nowSeconds: 1000 })).toBe(false);
    expect(isBeforeCutoff(102, 101, { nowSeconds: 1000 })).toBe(false);
    expect(parseValidatedUnixSeconds(1000 + DEFAULT_FUTURE_TOLERANCE_SECONDS, { nowSeconds: 1000 })).toBe(1300);
    expect(parseValidatedUnixSeconds(1301, { nowSeconds: 1000 })).toBeNull();
    expect(parseValidatedUnixSeconds(0, { nowSeconds: 1000 })).toBeNull();
    expect(parseValidatedUnixSeconds(-1, { nowSeconds: 1000 })).toBeNull();
  });
});

