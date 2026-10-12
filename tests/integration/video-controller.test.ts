/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { describe, expect, it, vi } from 'vitest';
import { createPageVideoFetcher, createVideoController } from '../../src/runtime/video-controller';

const config = { cutoffMinute: '2020-01-01T00:00', enabled: true, supplementBudget: 20, debug: false };

function mountCard(bvid: string, pubdate?: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'bili-video-card';
  card.dataset.bvid = bvid;
  if (pubdate !== undefined) card.dataset.pubdate = String(pubdate);
  document.body.append(card);
  return card;
}

describe('video controller', () => {
  it('fetches bounded supplement metadata from the current page origin', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://api.bilibili.com/x/web-interface/view?bvid=BVfetch');
      return new Response(JSON.stringify({ code: 0, data: { bvid: 'BVfetch', aid: 7, pubdate: 1546300800, title: 'title' } }), { status: 200 });
    });
    const target = { fetch, location: window.location } as unknown as Window;
    await expect(createPageVideoFetcher(target)('BVfetch')).resolves.toMatchObject({ bvid: 'BVfetch', pubdate: 1546300800 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('extracts the bvid from a search card link when the card has no data attribute', async () => {
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BV1search123/"></a></div>';
    const fetchVideo = vi.fn(async (bvid: string) => {
      expect(bvid).toBe('BV1search123');
      return { bvid, pubdate: 1546300800 };
    });
    const controller = createVideoController({ root: document, config, fetchVideo, observe: false });
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledWith('BV1search123');
    controller.disconnect();
  });

  it('resets the supplement budget when B站分页 changes', async () => {
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BVpage001/"></a></div>';
    const fetchVideo = vi.fn(async (bvid: string) => ({ bvid, pubdate: 1546300800 }));
    const controller = createVideoController({ root: document, config: { ...config, supplementBudget: 1 }, fetchVideo, observe: false });
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledTimes(1);

    window.history.pushState({}, '', '/all?keyword=test&page=2&o=36');
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BVpage002/"></a></div>';
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledTimes(2);
    controller.disconnect();
    window.history.pushState({}, '', '/');
  });

  it('does not spend the new page budget on stale cards during back navigation', async () => {
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BVoldpage/"></a></div>';
    const fetchVideo = vi.fn(async (bvid: string) => ({ bvid, pubdate: 1546300800 }));
    const controller = createVideoController({ root: document, config: { ...config, supplementBudget: 1 }, fetchVideo, observe: false });
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledTimes(1);

    window.history.pushState({}, '', '/all?keyword=test&page=2&o=36');
    controller.scan();
    expect(fetchVideo).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BVnewpage/"></a></div>';
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledTimes(2);
    window.history.pushState({}, '', '/all?keyword=test');
    controller.scan();
    expect(fetchVideo).toHaveBeenCalledTimes(2);
    document.body.innerHTML = '<div class="bili-video-card"><a href="//www.bilibili.com/video/BVbackpage/"></a></div>';
    controller.scan();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchVideo).toHaveBeenCalledTimes(3);
    controller.disconnect();
    window.history.pushState({}, '', '/');
  });


  it('uses window.__INITIAL_STATE__ metadata when classifying the first rendered cards', () => {
    document.body.innerHTML = '';
    const card = mountCard('BVstate');
    (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
      videoData: { bvid: 'BVstate', pubdate: 1735689600 },
    };
    const controller = createVideoController({ root: document, config, observe: false });

    controller.scan();

    expect(card.hidden).toBe(true);
    expect(card.getAttribute('data-time-filter-hidden')).toBe('1');
    controller.disconnect();
  });

  it('hides the video detail header when the SSR main video is at or after the cutoff', () => {
    document.body.innerHTML = '<div id="viewbox_report"><h1 class="video-title">title</h1></div>';
    window.history.pushState({}, '', '/video/BVstate');
    (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = {
      videoData: { bvid: 'BVstate', pubdate: 1735689600, title: 'title' },
    };
    const controller = createVideoController({ root: document, config, observe: false });

    controller.scan();

    expect(document.querySelector('#viewbox_report')?.getAttribute('data-time-filter-hidden')).toBe('1');
    controller.disconnect();
    window.history.pushState({}, '', '/');
  });

  it('keeps supplement failures hidden and never requests when budget is zero', async () => {
    document.body.innerHTML = '';
    const card = mountCard('BVmissing');
    const fetchVideo = vi.fn(async () => null);
    const controller = createVideoController({
      root: document,
      config: { ...config, supplementBudget: 1 },
      fetchVideo,
      observe: false,
    });

    controller.scan();
    await vi.waitFor(() => expect(fetchVideo).toHaveBeenCalledWith('BVmissing'));
    expect(card.hidden).toBe(true);
    controller.disconnect();

    const noRequest = vi.fn(async () => null);
    const zeroBudget = createVideoController({
      root: document,
      config: { ...config, supplementBudget: 0 },
      fetchVideo: noRequest,
      observe: false,
    });
    zeroBudget.scan();
    await Promise.resolve();
    expect(noRequest).not.toHaveBeenCalled();
    zeroBudget.disconnect();
  });

  it('does not supplement while the cutoff configuration is still pending', async () => {
    document.body.innerHTML = '';
    mountCard('BVpending');
    const fetchVideo = vi.fn(async () => null);
    const controller = createVideoController({
      root: document,
      config: { cutoffMinute: null, enabled: true, supplementBudget: 20, debug: false },
      fetchVideo,
      observe: false,
    });

    const result = controller.scan();
    expect(result.hidden).toBe(1);
    await Promise.resolve();
    expect(fetchVideo).not.toHaveBeenCalled();
    controller.disconnect();
  });

  it('hides and restores the search grid cell with its filtered card', () => {
    document.body.innerHTML = '';
    const cell = document.createElement('div');
    cell.className = 'col_3 col_xs_1_5 col_md_2 col_xl_1_7';
    const card = mountCard('BVgrid', 1735689600);
    cell.append(card);
    document.body.append(cell);
    const controller = createVideoController({ root: document, config, observe: false });

    controller.scan();
    expect(card.hidden).toBe(true);
    expect(cell.hidden).toBe(true);

    controller.updateConfig({ ...config, enabled: false });
    expect(card.hidden).toBe(false);
    expect(cell.hidden).toBe(false);
    controller.disconnect();
  });
});

