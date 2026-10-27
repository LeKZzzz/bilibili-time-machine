import { describe, expect, it, vi } from 'vitest';
import { createFilterPanel } from '../../src/ui/panel';
import { createDefaultPlaybackData } from '../../src/playback/model';
import type { PlaybackState } from '../../src/playback/session';
import type { PlaybackPanelClient } from '../../src/ui/playback-panel';

function setup() {
  const config = createDefaultPlaybackData().config;
  let state: PlaybackState = { config, mode: 'normal', status: 'idle', current: null, next: null, ad: null, elapsedMs: 0, message: '', canResume: true };
  let listener: (state: PlaybackState) => void = () => {};
  const unsubscribe = vi.fn();
  const command = vi.fn<PlaybackPanelClient['command']>();
  const onChange = vi.fn();
  const panel = createFilterPanel({ document, config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false }, onChange,
    playback: { getState: () => state, subscribe: callback => { listener = callback; return unsubscribe; }, command } });
  const root = panel.element.shadowRoot!;
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#playback-${id}`)!;
  root.querySelector<HTMLButtonElement>('.toggle')!.click(); get('open').click();
  return { panel, root, get, command, onChange, unsubscribe, update: (next: Partial<PlaybackState>) => { state = { ...state, ...next }; listener(state); } };
}

describe('playback panel', () => {
  it('starts independently of cutoff and announces default advertising, returns keyboard focus', () => {
    const { panel, root, get, command, onChange, unsubscribe } = setup();
    expect(get('dialog').hidden).toBe(false);
    expect(get<HTMLInputElement>('animation-ads').checked).toBe(true);
    expect(get<HTMLInputElement>('normal-ads').checked).toBe(false);
    expect(get<HTMLInputElement>('interval').value).toBe('20');
    expect(get('ad-notice').textContent).toContain('已开启');
    get('start').click();
    expect(command).toHaveBeenCalledWith({ type: 'start' });
    expect(onChange).not.toHaveBeenCalled();
    get('back').click();
    expect(root.activeElement).toBe(get('open'));
    panel.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('preserves drafts while updating status, saves a specified P and ep without expanding links', async () => {
    const { panel, get, command, update } = setup();
    get<HTMLInputElement>('work-title').value = '自选动画'; get('add-work').click();
    const forms = get('works').querySelectorAll('form');
    const form = forms[forms.length - 1];
    form.querySelectorAll('input')[0].value = '第一集';
    form.querySelectorAll('input')[1].value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const lastForm = get('works').querySelectorAll('form')[forms.length - 1];
    lastForm.querySelectorAll('input')[1].value = 'https://www.bilibili.com/bangumi/play/ep12345';
    lastForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    get<HTMLInputElement>('interval').value = '150'; get('interval').dispatchEvent(new Event('input'));
    update({ elapsedMs: 65000 });
    expect(get<HTMLInputElement>('interval').value).toBe('150');
    expect(get('clock').textContent).toContain('1:05');
    get('save').click(); await Promise.resolve();
    const saved = command.mock.calls.at(-1)![0];
    expect(saved.type).toBe('save-config');
    if (saved.type !== 'save-config') throw new Error('缺少保存命令');
    expect(saved.config.intervalMinutes).toBe(150);
    expect(saved.config.works.at(-1)!.entries.map(entry => entry.url)).toEqual([
      'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3', 'https://www.bilibili.com/bangumi/play/ep12345',
    ]);
    panel.destroy();
  });

  it('locks playlist changes during animation and exposes pause, blocked recovery and skip', () => {
    const { panel, get, command, update } = setup();
    update({ mode: 'animation', status: 'playing' });
    expect(get<HTMLSelectElement>('order').disabled).toBe(true);
    expect(get('works').querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
    expect(get('pause').hidden).toBe(false); get('pause').click();
    expect(command).toHaveBeenLastCalledWith({ type: 'pause' });
    update({ status: 'blocked', message: '浏览器需要手动播放' });
    expect(get('continue').hidden).toBe(false); get('continue').click();
    expect(command).toHaveBeenLastCalledWith({ type: 'continue' });
    update({ status: 'ad', ad: createDefaultPlaybackData().config.ads[0] }); expect(get('skip-ad').hidden).toBe(false); get('skip-ad').click();
    expect(command).toHaveBeenLastCalledWith({ type: 'skip-ad' });
    update({ status: 'blocked' }); expect(get('skip-ad').hidden).toBe(false);
    get('exit').click(); expect(command).toHaveBeenLastCalledWith({ type: 'exit' });
    update({ mode: 'normal', status: 'idle' }); expect(get<HTMLSelectElement>('order').disabled).toBe(false);
    panel.destroy();
  });

  it('keeps newer edits unsaved when an earlier save finishes', async () => {
    const { panel, get, command, update } = setup();
    let finishSave!: () => void;
    command.mockImplementationOnce(async action => {
      if (action.type !== 'save-config') throw new Error('缺少保存命令');
      await new Promise<void>(resolve => { finishSave = resolve; });
      update({ config: action.config });
    });
    const interval = get<HTMLInputElement>('interval');
    const save = get<HTMLButtonElement>('save');
    interval.value = '25'; interval.dispatchEvent(new Event('input')); save.click();
    interval.value = '30'; interval.dispatchEvent(new Event('input'));
    finishSave();
    await vi.waitFor(() => expect(get('clock').textContent).toContain('/ 25 分钟'));
    expect(interval.value).toBe('30');
    expect(save.disabled).toBe(false);
    expect(get('feedback').textContent).toBe('设置尚未保存');
    save.click();
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'save-config', config: expect.objectContaining({ intervalMinutes: 30 }) }));
    await vi.waitFor(() => expect(save.disabled).toBe(true));
    expect(get('feedback').textContent).toBe('播放设置已保存');
    panel.destroy();
  });

  it('rejects unsupported links and nonpositive intervals without affecting filters', () => {
    const { panel, get, command, onChange } = setup();
    const form = get('ads').querySelector('form')!;
    form.querySelectorAll('input')[1].value = 'https://example.com/video/BV1Ex411q7SJ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(get('feedback').textContent).toContain('请输入 B 站');
    get<HTMLInputElement>('interval').value = '0'; get('interval').dispatchEvent(new Event('input')); get('save').click();
    expect(get('feedback').textContent).toContain('大于零');
    expect(command).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    panel.destroy();
  });
});
