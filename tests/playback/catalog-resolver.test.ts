import { describe, expect, it, vi } from 'vitest';
import { resolveCatalogWork, sameCatalogWork } from '../../src/playback/catalog-resolver';
import type { AnimationWork, PlaybackEntry } from '../../src/playback/model';
import type { ResolvedPlaybackSource } from '../../src/playback/source';

function entry(id: string, title: string, url: string): PlaybackEntry {
  return { id, title, url };
}

function source(entries: PlaybackEntry[]): ResolvedPlaybackSource {
  return { title: '作品', kind: 'parts', entries };
}

describe('默认片单补全辅助层', () => {
  it('同一 BV 的多分 P 只请求一次，保留 seed 对象并给新增集生成稳定且不冲突的 ID', async () => {
    const first = entry('toon-resolved-source-3', 'seed 1', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1');
    const second = entry('toon-2', 'seed 2', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2');
    const work: AnimationWork = { id: 'toon', title: '自定义作品名', sourceStatus: 'pending', entries: [first, second] };
    const resolveSource = vi.fn(async () => source([
      entry('source-1', '第 1 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1'),
      entry('source-2', '第 2 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2'),
      entry('source-3', '第 3 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3'),
    ]));

    const resolved = await resolveCatalogWork(work, resolveSource);
    expect(resolveSource).toHaveBeenCalledTimes(1);
    expect(resolveSource).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1Ex411q7SJ/');
    expect(resolved.sourceStatus).toBe('resolved');
    expect(resolved.title).toBe(work.title);
    expect(resolved.entries[0]).toBe(first);
    expect(resolved.entries[1]).toBe(second);
    expect(resolved.entries[2].title).toBe('第 3 集');
    expect(resolved.entries[2].id).toBe('toon-resolved-source-3-2');
    expect(new Set(resolved.entries.map(item => item.id)).size).toBe(resolved.entries.length);

    const retry = await resolveCatalogWork({ ...work, sourceStatus: 'pending' }, async () => source([
      entry('source-1', '第 1 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1'),
      entry('source-2', '第 2 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2'),
      entry('source-3', '第 3 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3'),
    ]));
    expect(retry.entries[2].id).toBe(resolved.entries[2].id);
  });

  it('解析顺序优先于 seed 顺序，并保留中段 seed 的原始 ID', async () => {
    const second = entry('toon-2', '手工第 2 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2');
    const third = entry('toon-3', '手工第 3 集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=3');
    const work: AnimationWork = { id: 'toon', title: '动画', sourceStatus: 'pending', entries: [second, third] };
    const resolved = await resolveCatalogWork(work, async () => source([1, 2, 3, 4].map(part =>
      entry(`api-${part}`, `第 ${part} 集`, `https://www.bilibili.com/video/BV1Ex411q7SJ/?p=${part}`))));

    expect(resolved.entries.map(item => item.title)).toEqual(['第 1 集', '手工第 2 集', '手工第 3 集', '第 4 集']);
    expect(resolved.entries.map(item => item.id)).toEqual([
      'toon-resolved-api-1', 'toon-2', 'toon-3', 'toon-resolved-api-4',
    ]);
    expect(resolved.entries[1]).toBe(second);
    expect(resolved.entries[2]).toBe(third);
  });

  it('前一个合集结果覆盖后续 seed 时跳过重复请求，并按规范 URL 去重多源结果', async () => {
    const ep1 = 'https://www.bilibili.com/bangumi/play/ep1001';
    const ep2 = 'https://www.bilibili.com/bangumi/play/ep1002';
    const collectionWork: AnimationWork = {
      id: 'season', title: '番剧', sourceStatus: 'pending',
      entries: [entry('season-1', '第一话', ep1), entry('season-2', '第二话', ep2)],
    };
    const resolveSeason = vi.fn(async () => source([
      entry('api-1', '第一话', ep1), entry('api-2', '第二话', `${ep2}?from_spmid=tracking`),
    ]));
    const resolvedSeason = await resolveCatalogWork(collectionWork, resolveSeason);
    expect(resolveSeason).toHaveBeenCalledTimes(1);
    expect(resolvedSeason.entries).toHaveLength(2);

    const firstSource = 'https://www.bilibili.com/video/BV1AA411x7AB/';
    const secondSource = 'https://www.bilibili.com/video/BV1BB411x7CD/';
    const sharedUrl = 'https://www.bilibili.com/video/BV1CC411x7EF/';
    const multiSourceWork: AnimationWork = {
      id: 'multi', title: '多源作品', sourceStatus: 'pending',
      entries: [entry('multi-1', '第一集', firstSource), entry('multi-2', '第二集', secondSource)],
    };
    const resolveMultiple = vi.fn(async (url: string) => url === firstSource
      ? source([entry('api-a', '第一集', firstSource), entry('api-shared-a', '共享条目', sharedUrl)])
      : source([entry('api-b', '第二集', secondSource), entry('api-shared-b', '共享条目', `${sharedUrl}?spm_id_from=test`)]));
    const resolvedMultiple = await resolveCatalogWork(multiSourceWork, resolveMultiple);
    expect(resolveMultiple).toHaveBeenCalledTimes(2);
    expect(resolvedMultiple.entries.filter(item => item.url === sharedUrl)).toHaveLength(1);
  });

  it('任一源失败时保留整组原始 entries，并标记 failed', async () => {
    const entries = [
      entry('multi-1', '第一集', 'https://www.bilibili.com/video/BV1AA411x7AB/'),
      entry('multi-2', '第二集', 'https://www.bilibili.com/video/BV1BB411x7CD/'),
    ];
    const work: AnimationWork = { id: 'multi', title: '多源作品', sourceStatus: 'pending', entries };
    const resolveSource = vi.fn(async (url: string) => {
      if (url.endsWith('BV1BB411x7CD/')) throw new Error('网络失败');
      return source([entry('new-entry', '新集', 'https://www.bilibili.com/video/BV1AA411x7AB/?p=2')]);
    });

    const failed = await resolveCatalogWork(work, resolveSource);
    expect(failed.sourceStatus).toBe('failed');
    expect(failed.entries).toBe(entries);
  });

  it('sameCatalogWork 比较完整 seed 内容及来源状态', () => {
    const left: AnimationWork = {
      id: 'toon', title: '动画', sourceStatus: 'pending',
      entries: [entry('toon-1', '第一集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1')],
    };
    const canonicalized: AnimationWork = {
      ...left,
      entries: [entry('toon-1', '第一集', 'https://www.bilibili.com/video/BV1Ex411q7SJ/')],
    };
    expect(sameCatalogWork(left, canonicalized)).toBe(true);
    expect(sameCatalogWork(left, { ...canonicalized, sourceStatus: 'manual' })).toBe(false);
    expect(sameCatalogWork(left, { ...canonicalized, entries: [entry('edited', '第一集', canonicalized.entries[0].url)] })).toBe(false);
  });
});
