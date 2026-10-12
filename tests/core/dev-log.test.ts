import { describe, expect, it, vi } from 'vitest';
import {
  DEV_LOG_PREFIX,
  cardDecisionLog,
  configLog,
  createConsoleDevLog,
  createNoopDevLog,
  formatDevLogLabel,
  nativeDateLog,
  supplementFailedLog,
  supplementPlanLog,
  supplementStartLog,
  supplementSuccessLog,
} from '../../src/core/dev-log';
import type { DiagnosticEvent } from '../../src/core/types';

const config = {
  cutoffMinute: '2020-01-01T00:00',
  enabled: true,
  supplementBudget: 20,
  debug: false,
};

describe('core dev logger', () => {
  it('writes described and redacted events through the injected sink', () => {
    const events: Array<{ label: string; event: DiagnosticEvent }> = [];
    const logger = createConsoleDevLog((label, event) => events.push({ label, event }));

    logger.log({
      reason: 'network-filtered',
      message: '网络响应已过滤',
      url: 'https://api.bilibili.com/x/v2/reply?oid=1&token=secret',
      details: { adapter: 'comment', content: 'comment body' },
    });

    expect(events).toHaveLength(1);
    expect(events[0].label).toContain(DEV_LOG_PREFIX);
    expect(events[0].event.host).toBe('api.bilibili.com');
    expect(events[0].event.path).toBe('/x/v2/reply');
    expect(events[0].event.details).toEqual({ adapter: 'comment' });
    expect(JSON.stringify(events[0].event)).not.toContain('secret');
    expect(JSON.stringify(events[0].event)).not.toContain('comment body');
  });

  it('deduplicates events that share a key', () => {
    const write = vi.fn();
    const logger = createConsoleDevLog(write);
    logger.log({ reason: 'card-decision', key: 'same', details: { bvid: 'BV1' } });
    logger.log({ reason: 'card-decision', key: 'same', details: { bvid: 'BV1' } });
    logger.log({ reason: 'card-decision', key: 'other', details: { bvid: 'BV2' } });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('formats labels with the shared prefix', () => {
    expect(formatDevLogLabel({ reason: 'config-loaded', level: 'info', message: '配置已读取', at: 0 }))
      .toBe(`${DEV_LOG_PREFIX} config-loaded · 配置已读取`);
    expect(formatDevLogLabel({ reason: 'network-bypassed', level: 'info', at: 0 }))
      .toBe(`${DEV_LOG_PREFIX} network-bypassed`);
  });

  it('never emits through the noop logger', () => {
    const logger = createNoopDevLog();
    expect(() => logger.log({ reason: 'hook-failed' })).not.toThrow();
  });

  it('builds card decisions carrying bvid, pubdate, cutoff and visibility', () => {
    const input = cardDecisionLog(
      { bvid: 'BV1card', pubdate: 1546300800 },
      { visible: true, reason: 'before-cutoff', timestamp: 1546300800, record: {} },
      '2020-01-01T00:00',
      'dom',
    );
    expect(input.reason).toBe('card-decision');
    expect(input.details).toMatchObject({
      bvid: 'BV1card',
      pubdate: 1546300800,
      cutoff: '2020-01-01T00:00',
      verdict: 'before-cutoff',
      visible: true,
      source: 'dom',
    });
  });

  it('marks main-video decisions distinctly', () => {
    const input = cardDecisionLog(
      { bvid: 'BVmain', pubdate: 1546300800 },
      { visible: false, reason: 'at-or-after-cutoff', timestamp: 1546300800, record: {} },
      null,
      'main-video',
    );
    expect(input.reason).toBe('main-video-decision');
    expect(input.details).toMatchObject({ cutoff: null, visible: false });
  });

  it('builds config, native-date and supplement logs with bounded fields', () => {
    expect(configLog('config-loaded', config, 'userscript').details).toMatchObject({
      enabled: true,
      cutoff: '2020-01-01T00:00',
      budget: 20,
      debug: false,
      source: 'userscript',
    });
    expect(nativeDateLog('2020-01-01T00:00', 1245974400, 1577894399, true).details).toEqual({
      cutoff: '2020-01-01T00:00',
      startDate: '2009-06-26',
      endDate: '2020-01-01',
      pubtime_begin_s: 1245974400,
      pubtime_end_s: 1577894399,
      matched: true,
    });
    expect(supplementPlanLog('dom', 3, 20, 3).details).toEqual({ source: 'dom', candidates: 3, budget: 20, concurrency: 3 });
    expect(supplementStartLog('dom', 'BV1', 3).details).toMatchObject({ bvid: 'BV1', concurrency: 3 });
    expect(supplementSuccessLog('dom', 'BV1', 1546300800).details).toMatchObject({ bvid: 'BV1', pubdate: 1546300800 });
    expect(supplementFailedLog('dom', 'BV1', 'empty').details).toMatchObject({ bvid: 'BV1', cause: 'empty' });
  });
});
