import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAutoAdvanceConfig, startAutoAdvance, stopAutoAdvance } from '../../src/core/auto-advance';
import { isBeforeCutoff, parseLocalMinute } from '../../src/core/time';

const inDstProbe = process.env.TIME_MACHINE_DST_PROBE === '1';

describe('auto advance across New York fall-back', () => {
  if (inDstProbe) {
    it('keeps the cutoff instant increasing through the repeated hour', () => {
      const firstOccurrence = parseLocalMinute('2026-11-01T01:00-04:00')!;
      const secondOccurrence = parseLocalMinute('2026-11-01T01:00-05:00')!;
      expect(firstOccurrence).toBe(Date.UTC(2026, 10, 1, 5, 0) / 1000);
      expect(secondOccurrence).toBe(Date.UTC(2026, 10, 1, 6, 0) / 1000);
      expect(new Date(firstOccurrence * 1000).getTimezoneOffset()).toBe(240);
      expect(new Date(secondOccurrence * 1000).getTimezoneOffset()).toBe(300);
      expect(parseLocalMinute('2026-03-08T02:30')).toBeNull();

      const cutoffMinute = '2026-11-01T01:59-04:00';
      const startedAt = Date.UTC(2026, 10, 1, 5, 59);
      const started = startAutoAdvance({
        cutoffMinute,
        enabled: true,
        supplementBudget: 20,
        debug: false,
      }, startedAt);
      const restoredStarted = JSON.parse(JSON.stringify(started)) as typeof started;
      const advanced = resolveAutoAdvanceConfig(restoredStarted, startedAt + 60_000);

      expect(advanced.cutoffMinute).toBe('2026-11-01T01:00-05:00');
      expect(parseLocalMinute(advanced.cutoffMinute)).toBe(secondOccurrence);
      expect(parseLocalMinute(advanced.cutoffMinute)).toBeGreaterThan(parseLocalMinute(cutoffMinute)!);
      expect(isBeforeCutoff(Date.UTC(2026, 10, 1, 5, 30) / 1000, advanced.cutoffMinute)).toBe(true);
      expect(advanced.autoAdvanceBaseCutoffMinute).toBe(cutoffMinute);

      const restoredAdvanced = JSON.parse(JSON.stringify(advanced)) as typeof advanced;
      const stopped = stopAutoAdvance(restoredAdvanced, startedAt + 60_000);
      expect(stopped.cutoffMinute).toBe('2026-11-01T01:00-05:00');
      expect(parseLocalMinute(stopped.cutoffMinute)).toBe(secondOccurrence);
      expect(stopped.autoAdvanceBaseCutoffMinute).toBeNull();

      const restoredStopped = JSON.parse(JSON.stringify(stopped)) as typeof stopped;
      const restarted = startAutoAdvance(restoredStopped, startedAt + 60_000);
      const resumed = resolveAutoAdvanceConfig(restarted, startedAt + 120_000);
      expect(resumed.cutoffMinute).toBe('2026-11-01T01:01-05:00');
      expect(parseLocalMinute(resumed.cutoffMinute)).toBe(Date.UTC(2026, 10, 1, 6, 1) / 1000);
    });
    it('retains the repeated-hour occurrence when applying displayed or edited local fields', async () => {
      const { createFilterPanel } = await import('../../src/ui/panel');
      const saved: Array<{ cutoffMinute: string | null }> = [];
      const config = { cutoffMinute: '2026-11-01T01:30-05:00', enabled: true, supplementBudget: 20, debug: false };
      const panel = createFilterPanel({ document, config, onChange: next => { saved.push(next); } });
      const root = panel.element.shadowRoot!;
      const apply = root.querySelector<HTMLButtonElement>('#time-apply')!;
      const time = root.querySelector<HTMLInputElement>('#cutoff-time')!;
      apply.click();
      expect(parseLocalMinute(saved.at(-1)?.cutoffMinute)).toBe(Date.UTC(2026, 10, 1, 6, 30) / 1000);
      time.value = '01:35:00'; time.dispatchEvent(new Event('input'));
      apply.click();
      expect(parseLocalMinute(saved.at(-1)?.cutoffMinute)).toBe(Date.UTC(2026, 10, 1, 6, 35) / 1000);
      const date = root.querySelector<HTMLInputElement>('#cutoff-date')!;
      date.value = '2026-07-01'; date.dispatchEvent(new Event('input'));
      apply.click();
      expect(saved.at(-1)?.cutoffMinute).toBe('2026-07-01T01:35:00');
      expect(parseLocalMinute(saved.at(-1)?.cutoffMinute)).toBe(Date.UTC(2026, 6, 1, 5, 35) / 1000);
      panel.destroy();
    }, 10_000);
  } else {
    it('runs the transition assertions in an isolated timezone process', () => {
      const testFile = resolve(process.cwd(), 'tests/core/time-dst.test.ts');
      const child = spawnSync(process.execPath, [
        resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'),
        'run',
        testFile,
        '--pool=forks',
        '--maxWorkers=1',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: 'America/New_York', TIME_MACHINE_DST_PROBE: '1' },
        encoding: 'utf8',
        timeout: 20_000,
      });
      if (child.error) throw child.error;
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    }, 25_000);
  }
});
