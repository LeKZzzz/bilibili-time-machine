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
});
