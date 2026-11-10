import { describe, expect, it, vi } from 'vitest';
import { createFilterPanel } from '../../src/ui/panel';
import { createDefaultPlaybackData } from '../../src/playback/model';
import type { PlaybackState } from '../../src/playback/session';
import { createPlaybackPanel, type PlaybackPanelClient } from '../../src/ui/playback-panel';
import type { ResolvedPlaybackSource } from '../../src/playback/source';

if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

function setup() {
  const config = createDefaultPlaybackData().config;
  config.works.forEach(work => { work.sourceStatus = 'resolved'; });
  let state: PlaybackState = { config, mode: 'normal', status: 'idle', current: null, next: null, ad: null, elapsedMs: 0, message: '', canResume: true };
  let listener: (state: PlaybackState) => void = () => {};
  const unsubscribe = vi.fn();
  const command = vi.fn<PlaybackPanelClient['command']>();
  const resolveSource = vi.fn<PlaybackPanelClient['resolveSource']>(async () => ({
    title: '解析作品', kind: 'parts', entries: [
      { id: 'parser-entry-1', title: '第一集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/' },
      { id: 'parser-entry-2', title: '第二集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2' },
    ],
  } satisfies ResolvedPlaybackSource));
  const onChange = vi.fn();
  const panel = createFilterPanel({ document, config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false }, onChange,
    playback: { getState: () => state, subscribe: callback => { listener = callback; return unsubscribe; }, command, resolveSource } });
  const root = panel.element.shadowRoot!;
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#playback-${id}`)!;
  root.querySelector<HTMLButtonElement>('.toggle')!.click(); root.querySelector<HTMLButtonElement>('#playback-tab')!.click();
  return { panel, root, get, command, resolveSource, onChange, unsubscribe, update: (next: Partial<PlaybackState>) => { state = { ...state, ...next }; listener(state); } };
}

describe('playback panel', () => {
  it('starts independently of cutoff and announces default advertising, switches through top tabs', () => {
    const { panel, root, get, command, onChange, unsubscribe } = setup();
    expect(get('dialog').hidden).toBe(false);
    expect(get<HTMLInputElement>('animation-ads').checked).toBe(true);
    expect(get<HTMLInputElement>('normal-ads').checked).toBe(false);
    expect(get<HTMLInputElement>('interval').value).toBe('20');
    expect(get('ad-notice').textContent).toContain('已开启');
    get('start').click();
    expect(command).toHaveBeenCalledWith({ type: 'start' });
    expect(onChange).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('#filter-tab')!.click();
    expect(get('dialog').hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#main-view')!.hidden).toBe(false);
    panel.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('标签页支持方向键切换，保留两边草稿，更新配置和重新打开仍留在当前页', () => {
    const { panel, root, get, command, onChange } = setup();
    const filterTab = root.querySelector<HTMLButtonElement>('#filter-tab')!;
    const playbackTab = root.querySelector<HTMLButtonElement>('#playback-tab')!;
    const interval = get<HTMLInputElement>('interval');
    interval.value = '25';
    interval.dispatchEvent(new Event('input'));
    playbackTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(root.activeElement).toBe(filterTab);
    expect(filterTab.getAttribute('aria-selected')).toBe('true');
    expect(playbackTab.tabIndex).toBe(-1);
    const date = root.querySelector<HTMLInputElement>('#cutoff-date')!;
    date.value = '2020-01-02';
    date.dispatchEvent(new Event('input'));
    filterTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(root.activeElement).toBe(playbackTab);
    expect(playbackTab.getAttribute('aria-selected')).toBe('true');
    expect(filterTab.tabIndex).toBe(-1);
    expect(interval.value).toBe('25');
    panel.update({ cutoffMinute: null, enabled: false, supplementBudget: 10, debug: false });
    expect(get('dialog').hidden).toBe(false);
    root.querySelector<HTMLButtonElement>('.close')!.click();
    expect(root.querySelector<HTMLElement>('.card')!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    expect(get('dialog').hidden).toBe(false);
    playbackTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(root.activeElement).toBe(filterTab);
    expect(date.value).toBe('2020-01-02');
    expect(command).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('广告开关保存前显示待生效提示，计时始终依据已生效的对应模式设置', async () => {
    const { panel, get, command, update } = setup();
    const animationAds = get<HTMLInputElement>('animation-ads');
    const normalAds = get<HTMLInputElement>('normal-ads');
    expect(get('clock').textContent).toBe('普通观看片尾插播已关闭');
    update({ mode: 'animation', status: 'playing', elapsedMs: 65000 });
    expect(get('clock').textContent).toBe('累计观看 1 分 5 秒 · 广告间隔 20 分钟');

    animationAds.checked = false;
    animationAds.dispatchEvent(new Event('change'));
    normalAds.checked = true;
    normalAds.dispatchEvent(new Event('change'));
    expect(get('ad-notice').textContent).toBe('动画中途插播将关闭；普通观看片尾插播将开启，保存后生效。');
    expect(get('clock').textContent).toContain('广告间隔 20 分钟');
    command.mockImplementation(async action => {
      if (action.type === 'save-config') update({ config: action.config });
    });
    get('save').click();
    await vi.waitFor(() => expect(get('feedback').textContent).toBe('播放设置已保存'));
    expect(get('ad-notice').textContent).toBe('动画中途插播已关闭。');
    expect(get('clock').textContent).toBe('动画中途插播已关闭');
    update({ mode: 'normal', status: 'idle' });
    expect(get('clock').textContent).toContain('累计观看 1 分 5 秒');

    animationAds.checked = true;
    animationAds.dispatchEvent(new Event('change'));
    expect(get('ad-notice').textContent).toBe('动画中途插播将开启，保存后生效。');
    animationAds.checked = false;
    animationAds.dispatchEvent(new Event('change'));
    expect(get('ad-notice').textContent).toBe('动画中途插播已关闭。');
    panel.destroy();
  });

  it('用通用弹窗手动添加作品和集数，草稿统一保存', async () => {
    const { panel, get, root, command, update } = setup();
    get<HTMLButtonElement>('add-work').click();
    expect((get('add-dialog') as HTMLDialogElement).open).toBe(true);
    get<HTMLInputElement>('add-name').value = '自选动画';
    get<HTMLInputElement>('add-url').value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3';
    get<HTMLButtonElement>('add-direct').click();
    expect((get('add-dialog') as HTMLDialogElement).open).toBe(false);
    const workButton = [...get('works').querySelectorAll<HTMLButtonElement>('.playback-work-open')].at(-1)!;
    expect(workButton.textContent).toContain('1 集');
    workButton.click();
    expect((get('details-dialog') as HTMLDialogElement).open).toBe(true);
    get<HTMLButtonElement>('details-add').click();
    expect((get('add-dialog') as HTMLDialogElement).open).toBe(true);
    get<HTMLInputElement>('add-name').value = '第二集';
    get<HTMLInputElement>('add-url').value = 'https://www.bilibili.com/bangumi/play/ep12345';
    get<HTMLButtonElement>('add-direct').click();
    expect(root.activeElement).toBe(get('details-add'));
    get('details-close').click();
    get<HTMLInputElement>('interval').value = '150'; get('interval').dispatchEvent(new Event('input'));
    update({ elapsedMs: 65000, config: { ...createDefaultPlaybackData().config, normalAds: true } });
    expect(get<HTMLInputElement>('interval').value).toBe('150');
    expect(get('clock').textContent).toContain('累计观看 1 分 5 秒');
    get('save').click(); await Promise.resolve();
    const saved = command.mock.calls.at(-1)![0];
    expect(saved.type).toBe('save-config');
    if (saved.type !== 'save-config') throw new Error('缺少保存命令');
    expect(saved.config.intervalMinutes).toBe(150);
    expect(saved.config.works.at(-1)!.sourceStatus).toBe('manual');
    expect(saved.config.works.at(-1)!.entries.map(entry => entry.url)).toEqual([
      'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3', 'https://www.bilibili.com/bangumi/play/ep12345',
    ]);
    panel.destroy();
  });

  it('locks playlist edits but allows order changes during animation and exposes playback controls', () => {
    const { panel, get, command, update } = setup();
    update({ mode: 'animation', status: 'playing' });
    expect(get<HTMLSelectElement>('order').disabled).toBe(false);
    expect(get<HTMLButtonElement>('add-work').disabled).toBe(true);
    expect(get('works').querySelector<HTMLButtonElement>('[aria-label^="删除作品"]')!.disabled).toBe(true);
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

  it('播放中选择新顺序后可以保存，不发送退出或重新开始命令', async () => {
    const { panel, get, command, update } = setup();
    update({ mode: 'animation', status: 'playing' });
    const order = get<HTMLSelectElement>('order');
    order.value = 'sequential'; order.dispatchEvent(new Event('change'));
    expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    expect(get('feedback').textContent).toBe('设置尚未保存');
    get('save').click(); await Promise.resolve();
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-config', config: expect.objectContaining({ order: 'sequential' }) }));
    expect(get('works').querySelector<HTMLButtonElement>('[aria-label^="删除作品"]')!.disabled).toBe(true);
    expect(get('pause').hidden).toBe(false);
    panel.destroy();
  });

  it('keeps newer edits unsaved when an earlier save finishes', async () => {
    const { panel, get, command, update } = setup();
    update({ config: { ...createDefaultPlaybackData().config, normalAds: true } });
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
    await vi.waitFor(() => expect(get('clock').textContent).toContain('广告间隔 25 分钟'));
    expect(interval.value).toBe('30');
    expect(save.disabled).toBe(false);
    expect(get('feedback').textContent).toBe('设置尚未保存');
    save.click();
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'save-config', config: expect.objectContaining({ intervalMinutes: 30 }) }));
    await vi.waitFor(() => expect(save.disabled).toBe(true));
    expect(get('feedback').textContent).toBe('播放设置已保存');
    panel.destroy();
  });

  it('集数默认不渲染，点击作品后在可独立滚动的详情弹窗中展示，播放中仍可查看', () => {
    const { panel, get, update } = setup();
    const works = get('works');
    const workButtons = [...works.querySelectorAll<HTMLButtonElement>('.playback-work-open')];
    expect(workButtons.length).toBeGreaterThan(0);
    expect(works.querySelector('details')).toBeNull();
    expect(works.querySelector('ol')).toBeNull();
    expect(get('details-entries').children).toHaveLength(0);

    workButtons[0].click();
    expect((get('details-dialog') as HTMLDialogElement).open).toBe(true);
    expect(get('details-entries').querySelectorAll('ol li').length).toBeGreaterThan(0);
    update({ mode: 'animation', status: 'playing' });
    expect((get('details-dialog') as HTMLDialogElement).open).toBe(true);
    expect(get('details-entries').querySelectorAll('ol li').length).toBeGreaterThan(0);
    expect(get<HTMLButtonElement>('details-add').disabled).toBe(true);
    expect(get('details-entries').querySelector<HTMLButtonElement>('[aria-label^="删除"]')!.disabled).toBe(true);
    get('details-close').click();
    expect(get('details-entries').children).toHaveLength(0);
    panel.destroy();
  });

  it('modal预览后才加入草稿，筛选选集且重复导入使用新ID', async () => {
    const { panel, get, command, resolveSource } = setup();
    resolveSource.mockResolvedValue({
      title: '解析作品', kind: 'parts', entries: [
        { id: 'parser-id', title: '第一集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/' },
        { id: 'parser-id', title: '第二集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2' },
      ],
    });
    const importOnce = async (selectSecond: boolean) => {
      get<HTMLButtonElement>('add-work').click();
      const url = get<HTMLInputElement>('add-url');
      url.value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/';
      url.dispatchEvent(new Event('input'));
      get<HTMLFormElement>('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(get('add-status').textContent).toContain('已找到'));
      const choices = get('add-preview').querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(choices).toHaveLength(2);
      if (!selectSecond) { choices[1].checked = false; choices[1].dispatchEvent(new Event('change')); }
      get<HTMLButtonElement>('add-confirm').click();
      expect((get('add-dialog') as HTMLDialogElement).open).toBe(false);
      expect(command).not.toHaveBeenCalled();
    };

    await importOnce(false);
    await importOnce(true);
    const save = get<HTMLButtonElement>('save');
    expect(save.disabled).toBe(false);
    save.click();
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-config' })));
    const saved = command.mock.calls.at(-1)![0];
    if (saved.type !== 'save-config') throw new Error('缺少保存命令');
    const imported = saved.config.works.filter(work => work.title === '解析作品');
    expect(imported).toHaveLength(2);
    expect(imported[0].sourceStatus).toBe('resolved');
    expect(imported[0].entries).toHaveLength(1);
    expect(imported[1].entries).toHaveLength(2);
    const ids = [...imported.map(work => work.id), ...imported.flatMap(work => work.entries.map(entry => entry.id))];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('parser-id');
    panel.destroy();
  });

  it('取消或按Escape后忽略迟到的解析结果并恢复焦点', async () => {
    const { panel, get, root, resolveSource } = setup();
    let finish!: (source: ResolvedPlaybackSource) => void;
    resolveSource.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const originalCount = get('works').querySelectorAll('.playback-work-open').length;
    get<HTMLButtonElement>('add-work').click();
    get<HTMLInputElement>('add-url').value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/';
    get<HTMLInputElement>('add-url').dispatchEvent(new Event('input'));
    get<HTMLFormElement>('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    get<HTMLButtonElement>('add-cancel').click();
    expect((get('add-dialog') as HTMLDialogElement).open).toBe(false);
    expect(root.activeElement).toBe(get('add-work'));
    finish({ title: '迟到作品', kind: 'parts', entries: [{ id: 'late', title: '第一集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/' }] });
    await Promise.resolve();
    expect(get('works').querySelectorAll('.playback-work-open')).toHaveLength(originalCount);

    get<HTMLButtonElement>('add-work').click();
    const sourceDialog = get<HTMLDialogElement>('add-dialog');
    sourceDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(root.querySelector<HTMLElement>('#main-view')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#playback-dialog')!.hidden).toBe(false);
    expect(sourceDialog.open).toBe(true);
    sourceDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(sourceDialog.open).toBe(false);
    expect(root.activeElement).toBe(get('add-work'));
    panel.destroy();
  });

  it('解析失败、空结果和链接变更都会清空预览且不改动草稿', async () => {
    const { panel, get, resolveSource } = setup();
    const originalCount = get('works').querySelectorAll('.playback-work-open').length;
    resolveSource.mockRejectedValueOnce(new Error('网络不可用'));
    get<HTMLButtonElement>('add-work').click();
    const url = get<HTMLInputElement>('add-url');
    url.value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/'; url.dispatchEvent(new Event('input'));
    get<HTMLFormElement>('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(get('add-status').textContent).toContain('网络不可用'));
    expect(get<HTMLButtonElement>('add-confirm').disabled).toBe(true);
    expect(get('add-preview').children).toHaveLength(0);

    resolveSource.mockResolvedValueOnce({ title: '空结果', kind: 'parts', entries: [] });
    url.value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2'; url.dispatchEvent(new Event('input'));
    get<HTMLFormElement>('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(get('add-status').textContent).toContain('未找到可添加的分集'));
    expect(get('add-preview').children).toHaveLength(0);
    expect(get('works').querySelectorAll('.playback-work-open')).toHaveLength(originalCount);

    let finish!: (source: ResolvedPlaybackSource) => void;
    resolveSource.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    url.value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/'; url.dispatchEvent(new Event('input'));
    get<HTMLFormElement>('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    url.value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3'; url.dispatchEvent(new Event('input'));
    finish({ title: '旧链接结果', kind: 'parts', entries: [{ id: 'stale', title: '第一集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/' }] });
    await Promise.resolve();
    expect(get('add-status').textContent).toContain('链接已更改');
    expect(get('add-preview').children).toHaveLength(0);
    expect(get<HTMLButtonElement>('add-confirm').disabled).toBe(true);
    expect(get('works').querySelectorAll('.playback-work-open')).toHaveLength(originalCount);
    panel.destroy();
  });

  it('自动补全时阻止开始与续播，草稿更改只发送一次取消命令', () => {
    const { panel, get, command, update } = setup();
    update({ catalogResolving: true, catalogMessage: '正在补全动画条目' });
    expect(get('catalog-message').textContent).toBe('正在补全动画条目');
    expect(get<HTMLButtonElement>('cancel-catalog').hidden).toBe(false);
    expect(get<HTMLButtonElement>('start').disabled).toBe(true);
    expect(get<HTMLButtonElement>('resume').disabled).toBe(true);
    get<HTMLInputElement>('interval').value = '21'; get<HTMLInputElement>('interval').dispatchEvent(new Event('input'));
    get<HTMLInputElement>('interval').value = '22'; get<HTMLInputElement>('interval').dispatchEvent(new Event('input'));
    get<HTMLButtonElement>('cancel-catalog').click();
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({ type: 'cancel-catalog-resolution' });
    update({ catalogResolving: false, catalogMessage: '' });
    expect(get<HTMLButtonElement>('cancel-catalog').hidden).toBe(true);
    panel.destroy();
  });

  it('只在普通模式打开面板时请求待补全片单，并避免重复启动', () => {
    const makePanel = (mode: PlaybackState['mode']) => {
      const config = structuredClone(createDefaultPlaybackData().config);
      config.works[0].sourceStatus = 'pending';
      const state: PlaybackState = { config, mode, status: 'idle', current: null, next: null, ad: null, elapsedMs: 0, message: '', canResume: true };
      const command = vi.fn<PlaybackPanelClient['command']>();
      const client: PlaybackPanelClient = {
        getState: () => state,
        subscribe: () => () => {},
        command,
        resolveSource: vi.fn(async () => ({ title: '作品', kind: 'single' as const, entries: [] })),
      };
      const panel = createPlaybackPanel(document, client);
      return { panel, command };
    };
    const normal = makePanel('normal');
    normal.panel.open(); normal.panel.open();
    expect(normal.command).toHaveBeenCalledOnce();
    expect(normal.command).toHaveBeenCalledWith({ type: 'resolve-catalog' });
    normal.panel.destroy();

    const dirty = makePanel('normal');
    const interval = dirty.panel.element.querySelector<HTMLInputElement>('#playback-interval')!;
    interval.value = '21'; interval.dispatchEvent(new Event('input'));
    dirty.panel.open(); dirty.panel.open();
    expect(dirty.command).not.toHaveBeenCalled();
    dirty.panel.destroy();

    const animation = makePanel('animation');
    animation.panel.open();
    expect(animation.command).not.toHaveBeenCalled();
    animation.panel.destroy();
  });

  it('rejects unsupported links and nonpositive intervals without affecting filters', () => {
    const { panel, get, command, onChange } = setup();
    get('add-ad').click();
    get<HTMLInputElement>('add-url').value = 'https://example.com/video/BV1Ex411q7SJ';
    get('add-direct').click();
    expect(get('add-status').textContent).toContain('请输入 B 站');
    get('add-cancel').click();
    get<HTMLInputElement>('interval').value = '0'; get('interval').dispatchEvent(new Event('input')); get('save').click();
    expect(get('feedback').textContent).toContain('大于 0');
    expect(command).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    panel.destroy();
  });

  it('广告与作品共用添加窗口，广告只加入指定链接且播放中仍可编辑', async () => {
    const { panel, get, command, resolveSource, update } = setup();
    const count = get('ads').querySelectorAll('li').length;
    expect(get('ads').querySelector('form')).toBeNull();
    expect(get('works').querySelector('input')).toBeNull();
    update({ mode: 'animation', status: 'playing' });
    get('add-ad').click();
    expect(get<HTMLDialogElement>('add-dialog').open).toBe(true);
    expect(get('add-parse').hidden).toBe(true);
    expect(get('add-preview').hidden).toBe(true);
    get<HTMLInputElement>('add-name').value = '公益广告';
    get<HTMLInputElement>('add-url').value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3';
    get('add-cancel').click();
    expect(get('ads').querySelectorAll('li')).toHaveLength(count);
    expect(get<HTMLButtonElement>('save').disabled).toBe(true);
    get('add-ad').click();
    get<HTMLInputElement>('add-name').value = '公益广告';
    get<HTMLInputElement>('add-url').value = 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3';
    get('add-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(get('ads').querySelectorAll('li')).toHaveLength(count + 1);
    expect(resolveSource).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    get('save').click(); await Promise.resolve();
    const saved = command.mock.calls.at(-1)![0];
    if (saved.type !== 'save-config') throw new Error('缺少保存命令');
    expect(saved.config.ads.at(-1)).toMatchObject({ title: '公益广告', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3' });
    panel.destroy();
  });

  it('嵌套窗口只关闭顶层，详情编辑后仍回到对应作品按钮并清理集数DOM', () => {
    const { panel, root, get, command } = setup();
    const first = get('works').querySelector<HTMLButtonElement>('.playback-work-open')!;
    const workId = first.dataset.workId;
    first.click();
    get('details-add').click();
    const add = get<HTMLDialogElement>('add-dialog');
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    add.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(add.open).toBe(false);
    expect(get<HTMLDialogElement>('details-dialog').open).toBe(true);
    expect(root.activeElement).toBe(get('details-add'));
    get('details-entries').querySelector<HTMLButtonElement>('li button')!.click();
    expect(get<HTMLButtonElement>('save').disabled).toBe(false);
    expect(command).not.toHaveBeenCalled();
    get('details-close').click();
    expect(get('details-entries').children).toHaveLength(0);
    expect((root.activeElement as HTMLElement).dataset.workId).toBe(workId);
    expect(get('dialog').hidden).toBe(false);
    panel.destroy();
  });
});
