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

  it('loads selectable favorite folders and emits selected ids', async () => {
    const onChange = vi.fn();
    const onFavoriteFoldersRefresh = vi.fn(async () => [
      { id: '1', title: '默认收藏夹', mediaCount: 12, isDefault: true },
      { id: '2', title: '稍后再看', mediaCount: 4 },
    ]);
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true },
      onChange,
      onFavoriteFoldersRefresh,
    });
    const root = controller.element.shadowRoot;
    root?.querySelector<HTMLButtonElement>('.toggle')?.click();
    await vi.waitFor(() => expect(onFavoriteFoldersRefresh).toHaveBeenCalled());
    const folders = root?.querySelector<HTMLSelectElement>('#favorite-folders');
    expect(folders?.options).toHaveLength(2);
    if (!folders) throw new Error('收藏夹选择器未创建');
    folders.options[1].selected = true;
    folders.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ favoriteFolderIds: ['2'] }));
    controller.destroy();
  });

  it('updates the status after the manual favorite refresh request settles', async () => {
    const onChange = vi.fn(async () => undefined);
    const controller = createFilterPanel({
      document,
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true },
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
      config: { cutoffMinute: null, enabled: false, supplementBudget: 20, debug: false, favoriteHomeFillEnabled: true },
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
