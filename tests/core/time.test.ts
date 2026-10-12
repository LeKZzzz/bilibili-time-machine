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

