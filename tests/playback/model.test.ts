import { describe, expect, it } from 'vitest';
import { createDefaultPlaybackData, normalizePlaybackData, normalizePlaybackUrl, playbackQueue } from '../../src/playback/model';

describe('默认片单', () => {
  it('广告断点只保留仍在片单中的同一片源，兼容没有广告断点的旧数据', () => {
    const saved = createDefaultPlaybackData();
    expect(normalizePlaybackData(saved).progress.adResume).toBeUndefined();
    const ad = saved.config.ads[0];
    saved.progress.adResume = { id: ad.id, url: ad.url, position: 60 };
    expect(normalizePlaybackData(saved).progress.adResume).toEqual(saved.progress.adResume);
    saved.config.ads[0].url = saved.config.ads[1].url;
    expect(normalizePlaybackData(saved).progress.adResume).toBeUndefined();
    saved.config.ads = [];
    expect(normalizePlaybackData(saved).progress.adResume).toBeUndefined();
  });

  it('作品和条目 ID 唯一，播放链接有效且不重复', () => {
    const { config } = createDefaultPlaybackData();
    expect(config.works.length).toBeGreaterThanOrEqual(20);
    expect(new Set(config.works.map(work => work.id)).size).toBe(config.works.length);
    expect(new Set(config.works.map(work => work.title)).size).toBe(config.works.length);
    expect(config.works.every(work => work.title && work.entries.length > 0)).toBe(true);
    const entries = [...playbackQueue(config), ...config.ads];
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    const urls = entries.map(entry => normalizePlaybackUrl(entry.url));
    expect(urls.every(Boolean)).toBe(true);
    expect(new Set(urls).size).toBe(entries.length);
  });

  it('已有自选片单和主动清空的片单不会被新默认值覆盖', () => {
    const saved = createDefaultPlaybackData();
    saved.config.works = [{ id: 'custom', title: '自选动画', entries: [{
      id: 'custom-1', title: '自选集数', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3',
    }] }];
    saved.config.ads = [];
    const restored = normalizePlaybackData(saved);
    expect(restored.config.works).toEqual(saved.config.works);
    expect(restored.config.ads).toEqual([]);
    saved.config.works = [];
    expect(normalizePlaybackData(saved).config.works).toEqual([]);
  });

  it('默认作品待解析，旧版未修改的内置作品会恢复为待解析', () => {
    const saved = createDefaultPlaybackData();
    expect(saved.config.works.every(work => work.sourceStatus === 'pending')).toBe(true);
    for (const work of saved.config.works) delete work.sourceStatus;

    const restored = normalizePlaybackData(saved);
    expect(restored.config.works.every(work => work.sourceStatus === 'pending')).toBe(true);
  });

  it('仅完全匹配默认 seed 的旧作品自动待解析，已修改的 pending seed 标为 manual', () => {
    const saved = createDefaultPlaybackData();
    const originalId = saved.config.works[0].id;
    for (const work of saved.config.works) delete work.sourceStatus;
    saved.config.works[0].entries[0].title += '（用户编辑）';

    const restored = normalizePlaybackData(saved);
    expect(restored.config.works.find(work => work.id === originalId)?.sourceStatus).toBeUndefined();
    expect(restored.config.works.slice(1).every(work => work.sourceStatus === 'pending')).toBe(true);

    const pending = createDefaultPlaybackData();
    pending.config.works[0].title += '（用户编辑）';
    expect(normalizePlaybackData(pending).config.works[0].sourceStatus).toBe('manual');
  });
});
