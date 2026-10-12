import { describe, expect, it } from 'vitest';
import { resolveAutoAdvanceConfig, startAutoAdvance, stopAutoAdvance } from '../../src/core/auto-advance';

const base = {
  cutoffMinute: '2020-01-01T00:00',
  enabled: true,
  supplementBudget: 20,
  debug: false,
};

describe('auto advance cutoff', () => {
  it('moves the cutoff by complete elapsed minutes from the start anchor', () => {
    const started = startAutoAdvance(base, 1_000_000);
    expect(resolveAutoAdvanceConfig(started, 1_000_000 + 119_999).cutoffMinute).toBe('2020-01-01T00:01');
    expect(resolveAutoAdvanceConfig(started, 1_000_000 + 120_000).cutoffMinute).toBe('2020-01-01T00:02');
  });

  it('freezes the effective cutoff when stopped', () => {
    const started = startAutoAdvance(base, 1_000_000);
    const stopped = stopAutoAdvance(started, 1_000_000 + 61_000);
    expect(stopped).toMatchObject({ cutoffMinute: '2020-01-01T00:01', autoAdvance: false, autoAdvanceStartedAt: null });
  });

  it('preserves second precision when the start cutoff includes seconds', () => {
    const started = startAutoAdvance({ ...base, cutoffMinute: '2020-01-01T00:00:37' }, 1_000_000);
    expect(resolveAutoAdvanceConfig(started, 1_000_000 + 60_000).cutoffMinute).toBe('2020-01-01T00:01:37');
  });
});
