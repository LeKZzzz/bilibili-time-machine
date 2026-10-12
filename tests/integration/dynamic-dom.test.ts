/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { scanRenderedDynamics } from '../../src/page/initial-state';

describe('dynamic DOM rescan', () => {
  it('hides and restores rendered dynamic items immediately', () => {
    document.body.innerHTML = `
      <div class="bili-dyn-list__item"><div class="bili-dyn-item__desc">2020-01-02 00:00</div></div>
      <div class="bili-dyn-list__item"><div class="bili-dyn-item__desc">2020-01-01 00:00</div></div>`;
    const result = scanRenderedDynamics(document, '2020-01-01T12:00', { enabled: true });
    const items = Array.from(document.querySelectorAll('.bili-dyn-list__item')) as HTMLElement[];
    expect(result.hidden).toBe(1);
    expect(items[0].hidden).toBe(true);
    scanRenderedDynamics(document, null, { enabled: false });
    expect(items[0].hidden).toBe(false);
  });
});
