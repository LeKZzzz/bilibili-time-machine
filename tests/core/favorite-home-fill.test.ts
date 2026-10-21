/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://www.bilibili.com/" }
 */

import { describe, expect, it } from 'vitest';
import {
  cleanSearchTitle, createFavoriteSnapshot, createFavoriteHomeFillStore, normalizeFavoriteFolders, normalizeFavoriteVideos, normalizeSearchCandidates, scoreFavoriteTags,
  selectHomeFillCandidates,
} from '../../src/core/favorite-home-fill';

describe('favorite home fill core', () => {
  it('scores frequency and recency, and keeps tag order deterministic', () => {
    const scores = scoreFavoriteTags([
      { bvid: 'BV1', tags: ['游戏', '音乐'], favoritedAt: 1000 },
      { bvid: 'BV2', tags: ['游戏'], favoritedAt: 2000 },
      { bvid: 'BV3', tags: ['音乐'], favoritedAt: 3000 },
    ], 3000);
    expect(scores[0].score).toBeGreaterThan(scores.find((item) => item.tag === '游戏')?.score ?? 0);
    expect(scores.find((item) => item.tag === '游戏')?.videoCount).toBe(2);
  });

  it('filters unknown and late candidates and de-duplicates BV ids', () => {
    const snapshot = createFavoriteSnapshot('7', ['1'], [{ bvid: 'F', tags: ['游戏'], favoritedAt: 1000 }]);
    const candidates = normalizeSearchCandidates({ data: { result: [
      { bvid: 'BV1', title: 'old', pubdate: 1000 },
      { bvid: 'BV1', title: 'duplicate', pubdate: 1000 },
      { bvid: 'BV2', title: 'new', pubdate: 5000 },
      { bvid: 'BV3', title: 'unknown' },
    ] } }, ['游戏'], 1000);
    const selected = selectHomeFillCandidates(candidates, snapshot.tags, 5, 2000, [], [], 6000);
    expect(selected.map((item) => item.bvid)).toEqual(['BV1']);
    expect(selected[0]?.sourceTag).toBe('游戏');
  });

  it('gives different tags the first slots before allocating the remaining slots by weight', () => {
    const scores = scoreFavoriteTags([{ bvid: 'BVfav', tags: ['a', 'b', 'c'], favoritedAt: 1 }])
      .map((score, index) => ({ ...score, score: [1, 0.4, 0.2][index] }));
    const candidates = ['a', 'b', 'c'].flatMap((tag) => normalizeSearchCandidates({ data: { result:
      Array.from({ length: 6 }, (_, index) => ({ bvid: `BV${tag}${index}`, pubdate: 1 })),
    } }, [tag]));
    expect(selectHomeFillCandidates(candidates, scores, 3, 100).map((item) => item.sourceTag)).toEqual(['a', 'b', 'c']);
    const selected = selectHomeFillCandidates(candidates, scores, 7, 100);
    expect(selected.map((item) => item.sourceTag)).toEqual(['a', 'b', 'c', 'a', 'a', 'a', 'b']);
    expect(selected.filter((item) => item.sourceTag === 'a').map((item) => item.bvid)).toEqual(['BVa0', 'BVa1', 'BVa2', 'BVa3']);
  });

  it('cleans search highlight markup and HTML entities from titles', () => {
    expect(cleanSearchTitle('【<em class="keyword">标签</em>】 &quot;测试&quot; &amp; 更多')).toBe('【标签】 "测试" & 更多');
    const [candidate] = normalizeSearchCandidates({ data: { result: [{ bvid: 'BVtitle', title: '<em class="keyword">安静</em>的时候' }] } }, ['安静']);
    expect(candidate?.title).toBe('安静的时候');
  });

  it('normalizes search card metadata used by native home cards', () => {
    const [candidate] = normalizeSearchCandidates({ data: { result: [{
      bvid: 'BVmeta', title: '标题', pic: '//cover.jpg', pubdate: 123,
      author: '真实 UP', mid: 42, duration: '12:34', play: 12345, video_review: 67,
    }] } }, ['音乐'], 456);
    expect(candidate).toEqual(expect.objectContaining({
      author: '真实 UP', mid: 42, duration: '12:34', play: 12345, videoReview: 67,
    }));
  });

  it('keeps records isolated by uid in the fallback store', async () => {
    const store = createFavoriteHomeFillStore({ indexedDB: undefined });
    await store.putSnapshot(createFavoriteSnapshot('a', ['1'], []));
    await store.putSnapshot(createFavoriteSnapshot('b', ['2'], []));
    expect((await store.getSnapshot('a'))?.uid).toBe('a');
    expect((await store.getSnapshot('b'))?.uid).toBe('b');
  });

  it('normalizes common favorite resource aliases', () => {
    const videos = normalizeFavoriteVideos({ data: { medias: [{ bv_id: 'BValias', cover: 'cover.jpg', pub_time: 100, fav_time: 200 }] } }, 'folder', 10);
    expect(videos).toEqual([expect.objectContaining({ bvid: 'BValias', pic: 'cover.jpg', pubdate: 100, favoritedAt: 200 })]);
  });

  it('normalizes favorite folder options with names and counts', () => {
    const folders = normalizeFavoriteFolders({ data: { list: [
      { id: 1, title: '默认收藏夹', media_count: 12, is_default: true },
      { media_id: '2', name: '稍后再看', count: '4' },
      { id: 1, title: 'duplicate' },
    ] } });
    expect(folders).toEqual([
      { id: '1', title: '默认收藏夹', mediaCount: 12, isDefault: true },
      { id: '2', title: '稍后再看', mediaCount: 4 },
    ]);
  });

  it('loads favorite folder options from the current account', async () => {
    const requested: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { mid: 7 } }), { status: 200 });
      if (url.includes('/x/v3/fav/folder/created/list-all')) return new Response(JSON.stringify({ code: 0, data: { list: [{ id: 1, title: '我的收藏' }] } }), { status: 200 });
      return new Response(JSON.stringify({ code: -404 }), { status: 200 });
    };
    const { loadFavoriteFolders } = await import('../../src/runtime/favorite-home-fill-controller');
    await expect(loadFavoriteFolders(fetch as typeof globalThis.fetch)).resolves.toEqual([{ id: '1', title: '我的收藏' }]);
    expect(requested.some((url) => url.includes('up_mid=7'))).toBe(true);
  });

  it('clones a native card and marks its source accessibly', async () => {
    const { cloneHomeFillCard } = await import('../../src/runtime/favorite-home-fill-controller');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div class="bili-video-card" data-pubdate="99"><h3 class="bili-video-card__info--tit" title="old"><a href="/video/BVold"><span>old</span></a></h3><a class="owner" href="//space.bilibili.com/7" title="owner">owner</a><img src="old.jpg"></div>';
    const template = wrapper.querySelector('.bili-video-card')!;
    const clone = cloneHomeFillCard(template, { bvid: 'BVnew', title: 'new', pic: 'new.jpg', pubdate: 1, tags: ['x'], searchOrder: 0, collectedAt: Date.now() });
    expect(clone?.getAttribute('data-favorite-home-fill')).toBe('1');
    expect(clone?.querySelector('a')?.getAttribute('href')).toBe('/video/BVnew');
    expect(clone?.getAttribute('data-pubdate')).toBe('1');
    expect(clone?.hasAttribute('data-time-filter-hidden')).toBe(false);
    expect(clone?.querySelector('a')?.textContent).toBe('new');
    expect(clone?.querySelector('.owner')?.getAttribute('href')).toBeNull();
    expect(clone?.querySelector('.owner')?.textContent).toBe('');
    expect(clone?.textContent).toContain('收藏标签补位：x');
    expect(clone?.querySelector('[data-favorite-home-fill-label]')?.getAttribute('aria-label')).toBe('根据收藏标签“x”添加的补位视频');
  });

  it('replaces picture sources and native card metadata with the candidate', async () => {
    const { cloneHomeFillCard } = await import('../../src/runtime/favorite-home-fill-controller');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<div class="bili-video-card" data-bvid="BVold">
      <picture><source type="image/avif" srcset="template.avif"><img src="template.jpg" srcset="template-2x.jpg" alt="template"></picture>
      <h3 class="bili-video-card__info--tit"><a href="/video/BVold"><span>template title</span></a></h3>
      <a class="bili-video-card__info--author" href="//space.bilibili.com/7" title="template owner">template owner</a>
      <span class="bili-video-card__stats--text">4.8万</span><span class="bili-video-card__stats--text">112</span>
      <span class="bili-video-card__stats__duration">26:10</span>
    </div>`;
    const candidate = {
      bvid: 'BVnew', title: '真实标题', pic: '//candidate.jpg', pubdate: 1, tags: ['音乐'], searchOrder: 0, collectedAt: Date.now(),
      author: '真实 UP', mid: 123, play: 12345, videoReview: 67, duration: '12:34',
    };
    const clone = cloneHomeFillCard(wrapper.firstElementChild!, candidate);
    expect(clone?.querySelector('picture source')).toBeNull();
    expect(clone?.querySelector('img')?.getAttribute('src')).toBe('//candidate.jpg');
    expect(clone?.querySelector('img')?.getAttribute('srcset')).toBeNull();
    expect(clone?.querySelector('.bili-video-card__info--author')?.textContent).toBe('真实 UP');
    expect(clone?.querySelector('.bili-video-card__info--author')?.getAttribute('href')).toBe('//space.bilibili.com/123');
    expect(Array.from(clone?.querySelectorAll('.bili-video-card__stats--text') ?? []).map((node) => node.textContent)).toEqual(['1.2万', '67']);
    expect(clone?.querySelector('.bili-video-card__stats__duration')?.textContent).toBe('12:34');
  });

  it('cleans cached candidate titles while cloning a card', async () => {
    const { cloneHomeFillCard } = await import('../../src/runtime/favorite-home-fill-controller');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div class="bili-video-card"><h3 class="bili-video-card__info--tit"><a href="/video/BVold"><span>old</span></a></h3><img></div>';
    const clone = cloneHomeFillCard(wrapper.firstElementChild!, { bvid: 'BVcached', title: '<em class="keyword">标签</em> &quot;测试&quot;', pic: 'new.jpg', pubdate: 1, tags: ['x'], searchOrder: 0, collectedAt: Date.now() });
    expect(clone?.querySelector('.bili-video-card__info--tit')?.textContent).toContain('标签 "测试"');
    expect(clone?.textContent).not.toContain('<em');
  });

  it('enriches favorite resources without inline tags before filling a hidden home card', async () => {
    document.body.innerHTML = '<div class="col_3"><div class="bili-video-card" data-bvid="BVhidden" data-pubdate="2000000000" hidden data-time-filter-hidden="1"><a href="/video/BVhidden"><span class="bili-video-card__info--tit__text">hidden</span></a></div></div><div class="col_3"><div class="bili-video-card" data-bvid="BVtemplate" data-pubdate="1"><a href="/video/BVtemplate"><span class="bili-video-card__info--tit__text">template</span></a></div></div>';
    const store = createFavoriteHomeFillStore({ indexedDB: undefined });
    await store.clear();
    const requested: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { mid: 7 } }), { status: 200 });
      if (url.includes('/x/v3/fav/resource/list')) return new Response(JSON.stringify({ code: 0, data: { medias: [{ bvid: 'BVfav', cover: 'fav.jpg', fav_time: 1000 }] } }), { status: 200 });
      if (url.includes('/x/web-interface/view/detail')) return new Response(JSON.stringify({ code: 0, data: { Tags: [{ tag_name: '游戏' }] } }), { status: 200 });
      if (url.includes('/x/web-interface/search/type')) return new Response(JSON.stringify({ code: 0, data: { result: [{ bvid: 'BVcandidate', title: 'candidate', pic: 'candidate.jpg', pubdate: 1 }] } }), { status: 200 });
      return new Response(JSON.stringify({ code: -404 }), { status: 200 });
    };
    const { createFavoriteHomeFillController } = await import('../../src/runtime/favorite-home-fill-controller');
    const config = {
      cutoffMinute: '2030-01-01T00:00', enabled: true, supplementBudget: 20, debug: false,
      favoriteHomeFillEnabled: true, favoriteFolderIds: ['1'], favoriteFolderLimit: 1, favoriteVideoLimit: 1,
    };
    const controller = createFavoriteHomeFillController({
      root: document,
      store,
      fetch: fetch as typeof globalThis.fetch,
      config,
    });
    await controller.run();
    const replacement = document.querySelector('[data-favorite-home-fill]');
    expect(replacement?.getAttribute('data-pubdate')).toBe('1');
    expect(replacement?.querySelector('a')?.getAttribute('href')).toBe('/video/BVcandidate');
    await expect(controller.getTags()).resolves.toEqual([expect.objectContaining({ tag: '游戏', videoCount: 1 })]);
    expect(requested.some((url) => url.includes('/x/web-interface/view/detail?bvid=BVfav'))).toBe(true);
    controller.updateConfig({ ...config, favoriteHomeFillEnabled: false });
    expect(document.querySelector('[data-favorite-home-fill]')).toBeNull();
    expect(document.querySelector('[data-bvid="BVhidden"]')?.getAttribute('data-time-filter-hidden')).toBe('1');
    controller.disconnect();
  });
});
