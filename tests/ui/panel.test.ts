import { describe, expect, it, vi } from 'vitest';
import { createFilterPanel } from '../../src/ui/panel';

describe('createFilterPanel', () => {
  it('renders, emits changes, and resets the cutoff to the current time', async () => {
    const onChange = vi.fn();
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false },
      onChange,
    });
    const root = controller.element.shadowRoot;
    expect(root).not.toBeNull();
    const toggle = root?.querySelector<HTMLButtonElement>('.toggle');
    const enabled = root?.querySelector<HTMLInputElement>('#enabled');
    expect(toggle).not.toBeNull();
    expect(enabled).not.toBeNull();
    expect(root?.querySelector('[data-action="clear"]')).toBeNull();

    toggle?.click();
    expect(root?.querySelector('.card')?.hasAttribute('hidden')).toBe(false);
    if (!enabled) throw new Error('面板控件未创建');
    root?.querySelector<HTMLElement>('.switch')?.click();
    expect(enabled.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change'));
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    root?.querySelector<HTMLButtonElement>('[data-preset="now"]')?.click();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cutoffMinute: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/) }));
    controller.destroy();
    expect(document.getElementById('bilibili-time-filter-panel')).toBeNull();
  });

  it('fills only the current local time without changing the date and restarts auto advance', () => {
    vi.useFakeTimers();
    const now = new Date(2025, 5, 4, 15, 4, 7);
    vi.setSystemTime(now);
    const onChange = vi.fn();
    const controller = createFilterPanel({
      document,
      config: {
        cutoffMinute: '2024-12-31T10:20:15',
        enabled: true,
        supplementBudget: 20,
        debug: false,
        autoAdvance: true,
        autoAdvanceStartedAt: now.getTime() - 60_000,
        autoAdvanceBaseCutoffMinute: '2024-12-31T10:20:15',
      },
      onChange,
    });
    const root = controller.element.shadowRoot!;

    root.querySelector<HTMLButtonElement>('#fill-current-time')!.click();

    expect(root.querySelector<HTMLInputElement>('#cutoff-date')!.value).toBe('2024-12-31');
    expect(root.querySelector<HTMLInputElement>('#cutoff-time')!.value).toBe('15:04:07');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      cutoffMinute: '2024-12-31T15:04:07',
      autoAdvance: true,
      autoAdvanceStartedAt: now.getTime(),
      autoAdvanceBaseCutoffMinute: '2024-12-31T15:04:07',
    }));

    controller.destroy();
    vi.useRealTimers();
  });

  it('keeps favorite fill outside advanced settings and hides its actions when disabled', () => {
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false },
    });
    const root = controller.element.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    const favoriteContent = root.querySelector<HTMLElement>('#favorite-content')!;
    const favoriteEnabled = root.querySelector<HTMLInputElement>('#favorite-enabled')!;

    expect(favoriteContent.closest('details')).toBeNull();
    expect(favoriteContent.hidden).toBe(true);
    expect(root.querySelector('details[open]')).toBeNull();

    favoriteEnabled.checked = true;
    favoriteEnabled.dispatchEvent(new Event('change'));
    expect(favoriteContent.hidden).toBe(false);

    controller.destroy();
  });

  it('shows folder management as a second view and saves selections only on confirmation', async () => {
    const onChange = vi.fn();
    const onFavoriteFoldersRefresh = vi.fn(async () => Array.from({ length: 12 }, (_, index) => ({
      id: String(index + 1), title: `收藏夹 ${index + 1}`, mediaCount: 4,
    })));
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true, favoriteFolderLimit: 1 },
      onChange,
      onFavoriteFoldersRefresh,
    });
    const root = controller.element.shadowRoot;
    root?.querySelector<HTMLButtonElement>('.toggle')?.click();
    await vi.waitFor(() => expect(onFavoriteFoldersRefresh).toHaveBeenCalled());
    root?.querySelector<HTMLButtonElement>('#favorite-folders-open')?.click();
    expect(root?.querySelector<HTMLElement>('#main-view')?.hidden).toBe(true);
    expect(root?.querySelector<HTMLElement>('#favorite-folders-dialog')?.hidden).toBe(false);
    const folders = root?.querySelector<HTMLElement>('#favorite-folders');
    expect(folders?.querySelectorAll('button')).toHaveLength(12);
    folders?.querySelector<HTMLButtonElement>('[data-folder-id="2"]')?.click();
    expect(folders?.querySelector('[data-folder-id="2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    folders?.querySelector<HTMLButtonElement>('[data-folder-id="3"]')?.click();
    expect(folders?.querySelector('[data-folder-id="3"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root?.querySelector('#favorite-folders-validation')?.textContent).toContain('已达到');
    root?.querySelector<HTMLButtonElement>('#favorite-folders-save')?.click();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ favoriteFolderIds: ['2'] }));
    expect(root?.querySelector<HTMLElement>('#favorite-folders-dialog')?.hidden).toBe(true);
    controller.destroy();
  });

  it('discards modal drafts on cancel or Escape, validates limits, and preserves drafts on unrelated updates', async () => {
    const config = { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true, favoriteFolderIds: ['1', '2'], favoriteFolderLimit: 3, favoriteVideoLimit: 50 };
    const onChange = vi.fn();
    const controller = createFilterPanel({ document, config, onChange,
      onFavoriteFoldersRefresh: async () => [{ id: '1', title: '音乐' }, { id: '2', title: '游戏' }, { id: '3', title: '电影' }],
    });
    const root = controller.element.shadowRoot!;
    const open = root.querySelector<HTMLButtonElement>('#favorite-folders-open')!;
    const limit = root.querySelector<HTMLInputElement>('#favorite-folder-limit')!;
    const videos = root.querySelector<HTMLInputElement>('#favorite-video-limit')!;
    const save = root.querySelector<HTMLButtonElement>('#favorite-folders-save')!;
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.folder-option')).toHaveLength(3));
    open.click();
    limit.value = '1';
    limit.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(true);
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    root.querySelector<HTMLButtonElement>('[data-folder-id="2"]')!.click();
    videos.value = '201';
    videos.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(true);
    videos.value = '20';
    videos.dispatchEvent(new Event('input'));
    expect(save.disabled).toBe(false);
    controller.update({ ...config, supplementBudget: 10 });
    expect(limit.value).toBe('1');
    expect(videos.value).toBe('20');
    expect(root.querySelector<HTMLElement>('#main-view')!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('#favorite-folders-cancel')!.click();
    expect(root.querySelector<HTMLElement>('#favorite-folders-dialog')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#main-view')!.hidden).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    open.click();
    expect(limit.value).toBe('3');
    expect(videos.value).toBe('50');
    expect(root.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    limit.value = '2';
    limit.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('#favorite-folders-close')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector<HTMLElement>('#favorite-folders-dialog')!.hidden).toBe(true);
    expect(root.activeElement).toBe(open);
    open.click();
    expect(limit.value).toBe('3');
    videos.value = '80';
    save.click();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ favoriteFolderIds: ['1', '2'], favoriteVideoLimit: 80 }));
    controller.destroy();
  });

  it('blocks folder requests while disabled and does not re-enable refresh after an in-flight load', async () => {
    let resolve!: (value: { id: string; title: string }[]) => void;
    const onFavoriteFoldersRefresh = vi.fn(() => new Promise<{ id: string; title: string }[]>((done) => { resolve = done; }));
    const controller = createFilterPanel({ document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false },
      onFavoriteFoldersRefresh,
    });
    const root = controller.element.shadowRoot!;
    const enabled = root.querySelector<HTMLInputElement>('#favorite-enabled')!;
    const refresh = root.querySelector<HTMLButtonElement>('#favorite-folders-refresh')!;
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    refresh.dispatchEvent(new Event('click'));
    expect(onFavoriteFoldersRefresh).not.toHaveBeenCalled();
    expect(refresh.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('#favorite-folders-open')!.disabled).toBe(true);
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    expect(onFavoriteFoldersRefresh).toHaveBeenCalledWith(false);
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change'));
    resolve([{ id: '1', title: '不应写入的收藏夹' }]);
    await vi.waitFor(() => expect(root.querySelector('#favorite-folder-status')!.textContent).toContain('开启收藏补位'));
    expect(refresh.disabled).toBe(true);
    expect(root.querySelectorAll('.folder-option')).toHaveLength(0);
    controller.destroy();
  });

  it('distinguishes cached loading from forced refresh and explains caching on focus', async () => {
    const onFavoriteFoldersRefresh = vi.fn(async () => [{ id: '1', title: '收藏夹' }]);
    const controller = createFilterPanel({ document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true },
      onFavoriteFoldersRefresh,
    });
    const root = controller.element.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.folder-option')).toHaveLength(1));
    root.querySelector<HTMLButtonElement>('#favorite-folders-open')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('#favorite-folders-refresh')!.disabled).toBe(false));
    root.querySelector<HTMLButtonElement>('#favorite-folders-refresh')!.click();
    expect(onFavoriteFoldersRefresh).toHaveBeenLastCalledWith(true);
    const help = root.querySelector<HTMLButtonElement>('[data-help="favorite-list-cache"]')!;
    help.focus();
    const tooltip = root.querySelector<HTMLElement>('#setting-tooltip')!;
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toContain('按账号缓存');
    expect(tooltip.textContent).toContain('手动刷新');
    expect(help.getAttribute('aria-describedby')).toBe(tooltip.id);
    help.blur();
    expect(tooltip.hidden).toBe(true);
    controller.destroy();
  });

  it('updates the status after the manual favorite refresh request settles', async () => {
    const onChange = vi.fn(async () => undefined);
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true, favoriteFolderIds: ['1'] },
      onChange,
    });
    const root = controller.element.shadowRoot;
    root?.querySelector<HTMLButtonElement>('.toggle')?.click();
    const refresh = root?.querySelector<HTMLButtonElement>('#favorite-refresh');
    const status = root?.querySelector<HTMLElement>('.status');
    if (!refresh || !status) throw new Error('收藏标签刷新控件未创建');

    refresh.click();
    expect(status.textContent).toBe('已提交收藏标签刷新请求');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ favoriteRefreshRequestedAt: expect.any(Number) }));
    controller.destroy();
  });

  it('opens a popup listing the current favorite tags', async () => {
    const onFavoriteTagsLoad = vi.fn(async () => [
      { tag: '游戏', score: 1, frequency: 1, freshness: 1, videoCount: 3, latestFavoritedAt: 1000 },
      { tag: '音乐', score: 0.6, frequency: 0.5, freshness: 0.75, videoCount: 1, latestFavoritedAt: 900 },
    ]);
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true, favoriteFolderIds: ['1'] },
      onFavoriteTagsLoad,
    });
    const root = controller.element.shadowRoot;
    root?.querySelector<HTMLButtonElement>('.toggle')?.click();
    const open = root?.querySelector<HTMLButtonElement>('#favorite-tags');
    const dialog = root?.querySelector<HTMLElement>('#favorite-tags-dialog');
    const status = root?.querySelector<HTMLElement>('#favorite-tags-status');
    const list = root?.querySelector<HTMLOListElement>('#favorite-tags-list');
    if (!open || !dialog || !status || !list) throw new Error('当前标签控件未创建');

    open.click();
    await vi.waitFor(() => expect(onFavoriteTagsLoad).toHaveBeenCalledOnce());
    expect(dialog.hidden).toBe(false);
    expect(status.textContent).toBe('共 2 个标签');
    expect(list.textContent).toContain('游戏');
    expect(list.textContent).toContain('音乐');
    root?.querySelector<HTMLButtonElement>('#favorite-tags-close')?.click();
    expect(dialog.hidden).toBe(true);
    controller.destroy();
  });
});
