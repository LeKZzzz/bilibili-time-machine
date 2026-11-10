import { describe, expect, it, vi } from 'vitest';
import { resolvePlaybackSource } from '../../src/playback/source';

function videoResponse(data: Record<string, unknown>) {
  return { code: 0, data };
}

function seasonResponse(result: Record<string, unknown>) {
  return { code: 0, result };
}

describe('B站片源解析', () => {
  it('按 P 数排序 13P 视频，并按规范化 URL 去重', async () => {
    const pageNumbers = [13, 6, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 6];
    const response = videoResponse({
      bvid: 'BV1xG411x7XD',
      title: '十三集作品',
      pages: pageNumbers.map(page => ({ page, part: `第${page}集`, cid: page * 100 })),
    });
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => response);

    const resolved = await resolvePlaybackSource('BV1xG411x7XD', requestJson);

    expect(resolved.kind).toBe('parts');
    expect(resolved.title).toBe('十三集作品');
    expect(resolved.entries).toHaveLength(13);
    expect(resolved.entries.map(entry => entry.title)).toEqual(
      Array.from({ length: 13 }, (_, index) => `第${index + 1}集`),
    );
    expect(resolved.entries.map(entry => entry.url)).toEqual([
      'https://www.bilibili.com/video/BV1xG411x7XD/',
      ...Array.from({ length: 12 }, (_, index) => `https://www.bilibili.com/video/BV1xG411x7XD/?p=${index + 2}`),
    ]);
    expect(resolved.entries.map(entry => entry.id)).toEqual(
      Array.from({ length: 13 }, (_, index) => `BV1xG411x7XD-p${index + 1}`),
    );
    expect(new Set(resolved.entries.map(entry => entry.url)).size).toBe(13);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(new URL(requestJson.mock.calls[0][0]).searchParams.get('bvid')).toBe('BV1xG411x7XD');
  });

  it('展开 UGC 合集的多个 section，按来源顺序保留有效条目并去重', async () => {
    const response = videoResponse({
      bvid: 'BV1xG411x7XD',
      title: '当前视频标题',
      pages: [{ page: 1, part: '当前页' }],
      ugc_season: {
        title: '合集标题',
        sections: [
          { episodes: [
            { bvid: 'BV1AA411x7AB', title: '合集第一项' },
            { aid: 123456, title: '合集第二项' },
          ] },
          { episodes: [
            { arc: { bvid: 'BV1AA411x7AB' }, title: '重复项' },
            { arc: { aid: 654321 }, page: { part: '合集第三项' } },
          ] },
        ],
      },
    });
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => response);

    const resolved = await resolvePlaybackSource('BV1xG411x7XD', requestJson);

    expect(resolved).toEqual({
      title: '合集标题',
      kind: 'collection',
      entries: [
        { id: 'BV1AA411x7AB', title: '合集第一项', url: 'https://www.bilibili.com/video/BV1AA411x7AB/' },
        { id: 'av123456', title: '合集第二项', url: 'https://www.bilibili.com/video/av123456/' },
        { id: 'av654321', title: '合集第三项', url: 'https://www.bilibili.com/video/av654321/' },
      ],
    });
  });

  it('返回无合集单 P 视频，并清理输入 URL 的跟踪参数', async () => {
    const response = videoResponse({
      aid: 123456,
      title: '单视频标题',
      pages: [{ page: 1, part: '实际分集名', cid: 321 }],
    });
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => response);

    const resolved = await resolvePlaybackSource(
      'https://www.bilibili.com/video/av123456/?spm_id_from=abc&vd_source=xyz',
      requestJson,
    );

    expect(resolved).toEqual({
      title: '单视频标题',
      kind: 'single',
      entries: [{
        id: 'av123456-p1',
        title: '实际分集名',
        url: 'https://www.bilibili.com/video/av123456/',
      }],
    });
    expect(new URL(requestJson.mock.calls[0][0]).searchParams.get('aid')).toBe('123456');
  });

  it('通过 ep 链接取得正片分集并输出规范 ep 链接', async () => {
    const response = seasonResponse({
      title: '番剧名',
      episodes: [
        { id: 8801, title: '1', long_title: '第一话标题' },
        { id: 8802, title: '2', long_title: '第二话标题' },
        { id: 8802, title: '重复记录', long_title: '重复记录' },
      ],
      sections: [{ episodes: [{ id: 9999, title: '不在正片列表' }] }],
    });
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => response);

    const resolved = await resolvePlaybackSource(
      'https://www.bilibili.com/bangumi/play/ep8801?from_spmid=tracking',
      requestJson,
    );

    expect(resolved).toEqual({
      title: '番剧名',
      kind: 'season',
      entries: [
        { id: 'ep8801', title: '第一话标题', url: 'https://www.bilibili.com/bangumi/play/ep8801' },
        { id: 'ep8802', title: '第二话标题', url: 'https://www.bilibili.com/bangumi/play/ep8802' },
      ],
    });
    const requestUrl = new URL(requestJson.mock.calls[0][0]);
    expect(requestUrl.pathname).toBe('/pgc/view/web/season');
    expect(requestUrl.searchParams.get('ep_id')).toBe('8801');
  });

  it('将 ss 导入输入解析为 ep 分集链接', async () => {
    const response = seasonResponse({
      title: '按季导入',
      episodes: [{ id: 9201, title: '1', long_title: '第一集' }],
    });
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => response);

    const resolved = await resolvePlaybackSource('ss9200', requestJson);
    const urlImport = await resolvePlaybackSource(
      'https://www.bilibili.com/bangumi/play/ss9200?from_spmid=tracking',
      requestJson,
    );

    expect(resolved.entries).toEqual([{
      id: 'ep9201',
      title: '第一集',
      url: 'https://www.bilibili.com/bangumi/play/ep9201',
    }]);
    const requestUrl = new URL(requestJson.mock.calls[0][0]);
    expect(requestUrl.searchParams.get('season_id')).toBe('9200');
    expect(urlImport.entries).toEqual(resolved.entries);
  });

  it('拒绝无效链接，且不请求任意域名', async () => {
    const requestJson = vi.fn(async (_url: string): Promise<unknown> => ({}));

    await expect(resolvePlaybackSource('https://example.com/video/BV1xG411x7XD', requestJson))
      .rejects.toThrow('请输入有效的 B 站视频、番剧或合集链接');
    await expect(resolvePlaybackSource('https://example.com/bangumi/play/ss9200', requestJson))
      .rejects.toThrow('请输入有效的 B 站视频、番剧或合集链接');
    await expect(resolvePlaybackSource('ss0', requestJson)).rejects.toThrow(
      '请输入有效的 B 站视频、番剧或合集链接',
    );
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('报告 API 错误、HTTP 拒绝和空结果，不降级为单条视频', async () => {
    const apiError = vi.fn(async (_url: string): Promise<unknown> => ({ code: -404, message: 'not found' }));
    await expect(resolvePlaybackSource('BV1xG411x7XD', apiError)).rejects.toThrow(/错误代码：-404/);

    const httpError = vi.fn(async (_url: string): Promise<unknown> => {
      throw new Error('HTTP 403');
    });
    await expect(resolvePlaybackSource('BV1xG411x7XD', httpError)).rejects.toThrow('HTTP 403');

    const emptyVideo = vi.fn(async (_url: string): Promise<unknown> => videoResponse({ title: '空视频', pages: [] }));
    await expect(resolvePlaybackSource('BV1xG411x7XD', emptyVideo)).rejects.toThrow('未找到可添加的分集');

    const emptySeason = vi.fn(async (_url: string): Promise<unknown> => seasonResponse({ title: '空番剧', episodes: [] }));
    await expect(resolvePlaybackSource('ss123', emptySeason)).rejects.toThrow('未找到可添加的正片分集');
  });
});