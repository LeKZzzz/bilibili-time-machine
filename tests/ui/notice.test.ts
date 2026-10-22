import { describe, expect, it, vi } from 'vitest';
import { createNoticeManager, NOTICE_ROOT_ID } from '../../src/ui/notice';

describe('createNoticeManager', () => {
  it('deduplicates by route and reason and cleans up', () => {
    const manager = createNoticeManager({ document, durationMs: 0 });
    manager.show('解析失败', 'xml', '/video');
    manager.show('解析失败', 'xml', '/video');
    manager.show('解析失败', 'xml', '/search');
    const root = document.getElementById(NOTICE_ROOT_ID);
    expect(root?.children).toHaveLength(2);
    manager.closeAll();
    expect(root?.children).toHaveLength(0);
    manager.destroy();
    expect(document.getElementById(NOTICE_ROOT_ID)).toBeNull();
  });

  it('keeps one search toast until completion and allows subsequent rounds', () => {
    vi.useFakeTimers();
    const manager = createNoticeManager({ document });
    const root = document.getElementById(NOTICE_ROOT_ID)!;
    manager.setSearching(true);
    manager.setSearching(true);
    expect(root.querySelectorAll('[data-favorite-searching]')).toHaveLength(1);
    expect(root.textContent).toContain('正在搜索补位视频');
    vi.advanceTimersByTime(30_000);
    expect(root.children).toHaveLength(1);
    manager.setSearching(false);
    expect(root.children).toHaveLength(0);
    manager.setSearching(true);
    expect(root.children).toHaveLength(1);
    manager.destroy();
    expect(document.getElementById(NOTICE_ROOT_ID)).toBeNull();
    vi.useRealTimers();
  });
});
