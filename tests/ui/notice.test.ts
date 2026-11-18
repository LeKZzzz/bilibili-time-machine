import { describe, expect, it, vi } from 'vitest';
import { createNoticeManager, NOTICE_ROOT_ID } from '../../src/ui/notice';

describe('createNoticeManager', () => {
  it('关闭提示后恢复Shadow DOM中进入提示前的实际控件', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>原控件</button><button>最近使用控件</button>';
    document.body.append(host);
    const buttons = shadow.querySelectorAll<HTMLButtonElement>('button');
    buttons[0].focus();
    const manager = createNoticeManager({ document, durationMs: 0 });
    manager.show('测试', 'shadow');
    buttons[1].focus();
    const close = document.getElementById(NOTICE_ROOT_ID)!.querySelector<HTMLButtonElement>('button')!;
    close.focus(); close.click();
    expect(shadow.activeElement).toBe(buttons[1]);
    manager.destroy(); host.remove();
  });

  it('提示到期时保留焦点，离开后移除，手动关闭恢复到原控件', async () => {
    vi.useFakeTimers();
    const opener = document.createElement('button');
    document.body.append(opener); opener.focus();
    const manager = createNoticeManager({ document, durationMs: 1000 });
    manager.show('第一条', 'first');
    manager.show('第二条', 'second');
    const root = document.getElementById(NOTICE_ROOT_ID)!;
    const first = root.querySelector<HTMLButtonElement>('button')!;
    first.focus();
    vi.advanceTimersByTime(1000);
    expect(root.children).toHaveLength(1);
    expect(document.activeElement).toBe(first);
    opener.focus();
    await Promise.resolve();
    expect(root.children).toHaveLength(0);
    manager.show('第三条', 'third');
    const third = root.querySelector<HTMLButtonElement>('button')!;
    third.focus(); third.click();
    expect(document.activeElement).toBe(opener);
    expect(root.children).toHaveLength(0);
    manager.destroy(); opener.remove(); vi.useRealTimers();
  });

  it('手动关闭聚焦提示后转到相邻提示，搜索完成也不会移除聚焦节点', async () => {
    const manager = createNoticeManager({ document, durationMs: 0 });
    manager.show('普通提示', 'first');
    manager.setSearching(true);
    const root = document.getElementById(NOTICE_ROOT_ID)!;
    const buttons = root.querySelectorAll<HTMLButtonElement>('button');
    buttons[0].focus(); buttons[0].click();
    expect(document.activeElement).toBe(buttons[1]);
    manager.setSearching(false);
    expect(root.children).toHaveLength(1);
    expect(document.activeElement).toBe(buttons[1]);
    buttons[1].blur();
    await Promise.resolve();
    expect(root.children).toHaveLength(0);
    manager.destroy();
  });

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
    expect(root.textContent).toContain('正在寻找符合截止时间的视频');
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
