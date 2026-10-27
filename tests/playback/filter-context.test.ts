/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isAnimationDetailRequest, isAnimationPlaybackDocument } from '../../src/playback/filter-context';
import { scanRenderedMainVideo, scanRenderedVideoCards } from '../../src/page/initial-state';
import { installNetworkHook } from '../../src/page/network-hook';

const config = Object.freeze({ cutoffMinute: '2020-01-01T00:00', enabled: true, supplementBudget: 20, debug: false });
const current = 'BV1Ex411q7SJ';
const other = 'BV1QJfPYQEYg';
const old = { bvid: 'BV13r4y117HE', pubdate: 1546300800 };
const recent = { bvid: current, pubdate: 1735689600 };
const initial = { __INITIAL_STATE__: { videoData: recent } };
function mount(): void {
  window.history.replaceState({}, '', `/video/${current}/`);
  document.body.innerHTML = `<div id="viewbox_report"><h1 class="video-title">动画</h1></div>
    <div class="bili-video-card" data-bvid="${other}" data-pubdate="1735689600">推荐</div>`;
}
afterEach(() => {
  document.documentElement.removeAttribute('data-time-machine-animation');
  document.body.innerHTML = ''; window.name = ''; window.history.replaceState({}, '', '/');
});

describe('动画播放的局部过滤例外', () => {
  it.each(['active', 'ticket'] as const)('%s只豁免主条目，推荐卡片和原配置不变', (kind) => {
    mount();
    if (kind === 'active') document.documentElement.setAttribute('data-time-machine-animation', '');
    else window.name = 'bilibili-time-machine:navigate:' + JSON.stringify({ url: `https://www.bilibili.com/video/${current}/?p=1`, previousName: '' });
    const snapshot = JSON.stringify(config);
    expect(scanRenderedMainVideo(document, config.cutoffMinute, config, initial).hidden).toBe(0);
    expect(scanRenderedVideoCards(document, config.cutoffMinute, config).hidden).toBe(1);
    expect(document.querySelector<HTMLElement>('#viewbox_report')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.bili-video-card')!.hidden).toBe(true);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it('普通观看和目的条目不同的票据不会豁免，p2不能冒充p1', () => {
    mount();
    expect(scanRenderedMainVideo(document, config.cutoffMinute, config, initial).hidden).toBe(2);
    for (const url of [`https://www.bilibili.com/video/${other}/`, `https://www.bilibili.com/video/${current}/?p=2`]) {
      window.name = 'bilibili-time-machine:navigate:' + JSON.stringify({ url });
      expect(isAnimationPlaybackDocument(document)).toBe(false);
      expect(scanRenderedMainVideo(document, config.cutoffMinute, config, initial).hidden).toBe(2);
    }
    window.name = 'bilibili-time-machine:navigate:not-json';
    expect(isAnimationPlaybackDocument(document)).toBe(false);
  });

  it('动画标记移除后恢复主条目过滤', () => {
    mount(); document.documentElement.setAttribute('data-time-machine-animation', '');
    scanRenderedMainVideo(document, config.cutoffMinute, config, initial);
    document.documentElement.removeAttribute('data-time-machine-animation');
    expect(scanRenderedMainVideo(document, config.cutoffMinute, config, initial).hidden).toBe(2);
  });

  it('只豁免当前视频的详情和分P请求，其他详情与推荐仍走网络过滤', async () => {
    mount(); document.documentElement.setAttribute('data-time-machine-animation', '');
    const detail = `https://api.bilibili.com/x/web-interface/view?bvid=${current}`;
    const another = `https://api.bilibili.com/x/web-interface/view?bvid=${other}`;
    const recommendations = 'https://api.bilibili.com/x/web-interface/archive/related';
    expect(isAnimationDetailRequest(detail, window)).toBe(true);
    expect(isAnimationDetailRequest(`https://api.bilibili.com/x/player/pagelist?bvid=${current}`, window)).toBe(true);
    expect(isAnimationDetailRequest(another, window)).toBe(false);
    expect(isAnimationDetailRequest(recommendations, window)).toBe(false);
    const hook = installNetworkHook({ target: window, config,
      fetch: async () => new Response(JSON.stringify({ data: [old, recent] }), { headers: { 'content-type': 'application/json' } }),
    });
    try {
      expect(await (await window.fetch(detail)).json()).toEqual({ data: [old, recent] });
      expect(await (await window.fetch(another)).json()).toEqual({ data: [old] });
      expect(await (await window.fetch(recommendations)).json()).toEqual({ data: [old] });
      expect(config.enabled).toBe(true); expect(config.cutoffMinute).toBe('2020-01-01T00:00');
    } finally { hook.uninstall(); }
  });
});
