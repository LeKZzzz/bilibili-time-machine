import { describe, expect, it } from 'vitest';
import { resolveAutoAdvanceConfig, startAutoAdvance, stopAutoAdvance } from '../../src/core/auto-advance';
import { parseLocalMinute } from '../../src/core/time';
import { createConfigStore, createLocalStorage } from '../../src/runtime/config-store';

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

  it('preserves explicit-offset instants through storage, stop, and restart', async () => {
    const cutoffMinute = '2026-11-01T01:00-05:00';
    const cutoffSeconds = parseLocalMinute(cutoffMinute)!;
    const startedAt = Date.UTC(2026, 10, 1, 6, 0);
    const persistedValues = new Map<string, string>();
    const store = createConfigStore(createLocalStorage({
      getItem: (key) => persistedValues.get(key) ?? null,
      setItem: (key, value) => { persistedValues.set(key, value); },
      removeItem: (key) => { persistedValues.delete(key); },
    }));
    const started = startAutoAdvance({ ...base, cutoffMinute }, startedAt);
    await store.saveConfig(started);
    const restoredStarted = await store.loadConfig();
    const advanced = resolveAutoAdvanceConfig(restoredStarted, startedAt + 60_000);

    expect(advanced.autoAdvanceBaseCutoffMinute).toBe(cutoffMinute);
    expect(parseLocalMinute(advanced.cutoffMinute)).toBe(cutoffSeconds + 60);

    await store.saveConfig(advanced);
    const restoredAdvanced = await store.loadConfig();
    const stopped = stopAutoAdvance(restoredAdvanced, startedAt + 60_000);
    expect(parseLocalMinute(stopped.cutoffMinute)).toBe(cutoffSeconds + 60);
    expect(stopped.autoAdvanceBaseCutoffMinute).toBeNull();

    await store.saveConfig(stopped);
    const restoredStopped = await store.loadConfig();
    const restarted = startAutoAdvance(restoredStopped, startedAt + 60_000);
    expect(restarted.autoAdvanceBaseCutoffMinute).toBe(stopped.cutoffMinute);
    expect(parseLocalMinute(resolveAutoAdvanceConfig(restarted, startedAt + 120_000).cutoffMinute)).toBe(cutoffSeconds + 120);
  });
});
