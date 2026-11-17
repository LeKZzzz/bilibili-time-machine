/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://search.bilibili.com/all?keyword=test" }
 */

import { describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'bilibili-time-filter.config.v1';
const CUTOFF = '2020-01-01T00:00';
/** 2019-06-01T00:00:00Z，严格早于 CUTOFF。 */
const BEFORE_CUTOFF = 1559347200;
/** 2025-01-01T00:00:00Z，晚于 CUTOFF。 */
const AFTER_CUTOFF = 1735689600;

interface CardOptions {
  bvid: string;
  pubdate?: number;
}

function mountCard({ bvid, pubdate }: CardOptions): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bili-video-card';
  card.setAttribute('data-bvid', bvid);
  card.setAttribute('title', bvid);
  if (pubdate !== undefined) card.setAttribute('data-pubdate', String(pubdate));
  const cover = document.createElement('a');
  cover.href = `/video/${bvid}`;
  cover.append(document.createElement('img'));
  card.append(cover);
  document.body.append(card);
  return card;
}

function panelControl<T extends Element>(selector: string): T {
  const panel = document.getElementById('bilibili-time-filter-panel');
  const control = panel?.shadowRoot?.querySelector<T>(selector) ?? null;
  if (!control) throw new Error(`面板控件未找到：${selector}`);
  return control;
}

describe('MV3 content entry', () => {
  it('hides cards at or after the cutoff, keeps earlier ones, and restores them when filtering is disabled', async () => {
    const late = mountCard({ bvid: 'BVlate', pubdate: AFTER_CUTOFF });
    const early = mountCard({ bvid: 'BVearly', pubdate: BEFORE_CUTOFF });
    const unknown = mountCard({ bvid: 'BVunknown' });

    const set = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    let resolveConfig!: (value: { cutoffMinute: string; enabled: boolean; supplementBudget: number; debug: boolean }) => void;
    const configRead = new Promise<{ cutoffMinute: string; enabled: boolean; supplementBudget: number; debug: boolean }>((resolve) => {
      resolveConfig = resolve;
    });
    const get = vi.fn((key: string) => key === STORAGE_KEY
      ? configRead.then(value => ({ [STORAGE_KEY]: value }))
      : Promise.resolve({}));
    const post = vi.spyOn(window, 'postMessage');
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get,
          set,
          remove,
        },
      },
    });

    vi.resetModules();
    await import('../../src/runtime/mv3-content');

    const cutoffDate = panelControl<HTMLInputElement>('#cutoff-date');
    cutoffDate.value = '2024-01-01';
    cutoffDate.dispatchEvent(new Event('input', { bubbles: true }));
    panelControl<HTMLButtonElement>('#time-apply').click();
    expect(cutoffDate.value).toBe('2024-01-01');
    expect(panelControl('#time-draft-status').textContent).toBe('修改尚未应用');
    expect(panelControl<HTMLElement>('#config-save-feedback').hidden).toBe(false);
    expect(panelControl('#config-save-status').textContent).toContain('设置尚未读取完成');
    expect(set).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'time-filter/config-update')).toHaveLength(0);

    resolveConfig({ cutoffMinute: CUTOFF, enabled: true, supplementBudget: 20, debug: false });

    await vi.waitFor(() => expect(late.getAttribute('data-time-filter-hidden')).toBe('1'));
    expect(cutoffDate.value).toBe('2024-01-01');
    expect(panelControl('#time-draft-status').textContent).toBe('修改尚未应用');
    expect(late.hidden).toBe(true);
    expect(unknown.hidden).toBe(true);
    await vi.waitFor(() => expect(early.hidden).toBe(false));

    panelControl<HTMLButtonElement>('#time-apply').click();
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
    expect(panelControl('#time-draft-status').textContent).toBe('时间已应用');

    const enabled = panelControl<HTMLInputElement>('#enabled');
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(late.hidden).toBe(false));
    expect(late.hasAttribute('data-time-filter-hidden')).toBe(false);
    expect(unknown.hidden).toBe(false);
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
  });
});
