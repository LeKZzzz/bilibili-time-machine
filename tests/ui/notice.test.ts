import { describe, expect, it } from 'vitest';
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
});
