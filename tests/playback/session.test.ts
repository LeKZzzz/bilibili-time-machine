import { describe, expect, it, vi } from 'vitest';
import { createDefaultPlaybackData, normalizePlaybackData, normalizePlaybackUrl, type PlaybackData } from '../../src/playback/model';
import { PlaybackSession, type PlaybackPorts } from '../../src/playback/session';

function fixture(saved?: PlaybackData) {
  let clock = 0;
  const data = saved ?? createDefaultPlaybackData();
  if (!saved) {
    data.config.works = ['A', 'B'].map((title, index) => ({ id: title, title,
      entries: Array.from({ length: index + 2 }, (_, n) => ({ id: `${title}${n + 1}`, title: `${title}${n + 1}`, url: `https://www.bilibili.com/video/BV1Ex411q7SJ/?p=${n + 1}` })) }));
    data.config.intervalMinutes = 1;
  }
  const ports: PlaybackPorts = { navigate: vi.fn(async () => {}), play: vi.fn(), pause: vi.fn(),
    showAd: vi.fn(), closeAd: vi.fn(), releaseEnded: vi.fn(), save: vi.fn(), state: vi.fn() };
  const session = new PlaybackSession(data, ports, { now: () => clock, random: () => 0.2 });
  return { session, ports, data, advanceTime(ms: number) { clock += ms; session.tick(); } };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

describe('播放会话', () => {
  it('普通广告切换到动画续播时先清理广告并清零原模式计时，不放行原生下一条', async () => {
    const { session, ports, data, advanceTime } = fixture();
    session.configure({ ...data.config, normalAds: true });
    session.mediaPlaying(); advanceTime(60_000); session.mediaEnded();
    expect(session.getState().ad).not.toBeNull();
    await session.resume();
    expect(ports.closeAd).toHaveBeenCalledOnce();
    expect(ports.releaseEnded).not.toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ mode: 'animation', ad: null });
    expect(session.getData().progress.normalElapsedMs).toBe(0);
  });
  it('自动播放被拒绝后保留手动继续入口，迟到的暂停或缓冲不覆盖它', async () => {
    const { session, advanceTime } = fixture();
    await session.start(); session.autoplayBlocked();
    session.mediaWaiting(); session.mediaPaused(); advanceTime(60_000);
    expect(session.getState()).toMatchObject({ status: 'blocked', message: '点击继续播放', elapsedMs: 0 });
    session.continuePlayback(); session.mediaPlaying();
    expect(session.getState().status).toBe('playing');
    advanceTime(60_000); session.autoplayBlocked(); session.mediaPaused();
    expect(session.getState().status).toBe('blocked');
    session.adPlaying();
    expect(session.getState()).toMatchObject({ status: 'ad', message: '' });
  });
  it.each([
    ['round-robin', ['A1', 'B1', 'A2', 'B2', 'B3', 'A1']],
    ['sequential', ['A1', 'A2', 'B1', 'B2', 'B3', 'A1']],
  ] as const)('按 %s 完成整轮后循环', async (order, expected) => {
    const { session, ports, data } = fixture();
    session.configure({ ...data.config, order });
    await session.start();
    for (let n = 0; n < 5; n++) { expect(session.mediaEnded()).toBe(true); await settle(); }
    expect(vi.mocked(ports.navigate).mock.calls.map(([entry]) => entry.id)).toEqual(expected);
    expect(session.getData().progress.round).toBe(1);
  });

  it('按真实经过时间计时，暂停缓冲拖动和广告不累计', async () => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); advanceTime(30_000);
    session.mediaPosition(2000); session.mediaWaiting(); advanceTime(80_000);
    session.mediaPlaying(); advanceTime(10_000); session.mediaPaused(); advanceTime(80_000);
    expect(session.getState().elapsedMs).toBe(40_000);
    session.mediaPlaying(); advanceTime(20_000);
    expect(session.getState().status).toBe('ad');
    expect(ports.pause).toHaveBeenCalled();
    advanceTime(100_000); expect(session.getState().elapsedMs).toBe(60_000);
    session.finishAd(); expect(ports.closeAd).toHaveBeenCalled();
    expect(ports.play).toHaveBeenLastCalledWith(2000);
    expect(session.getState().elapsedMs).toBe(0);
  });

  it('普通观看只在片尾插一条且与动画独立计时', async () => {
    const { session, ports, data, advanceTime } = fixture();
    session.configure({ ...data.config, normalAds: true });
    session.mediaPlaying(); advanceTime(180_000);
    expect(session.getState().status).toBe('waiting-end');
    expect(ports.showAd).not.toHaveBeenCalled();
    expect(session.mediaEnded()).toBe(true);
    session.finishAd(); expect(ports.releaseEnded).toHaveBeenCalledOnce();
    expect(session.getState().elapsedMs).toBe(0);
    session.mediaPlaying(); advanceTime(25_000);
    await session.start(); expect(session.getState().elapsedMs).toBe(0);
    session.exit(); expect(session.getState().elapsedMs).toBe(25_000);
  });

  it('广告遍历和跳过不跨轮连续重复', async () => {
    const { session, ports, data, advanceTime } = fixture();
    session.configure({ ...data.config, ads: ['x', 'y', 'z'].map(id => ({ id, title: id, url: 'https://www.bilibili.com/video/BV13r4y117HE/' })) });
    await session.start();
    for (let n = 0; n < 9; n++) { session.mediaPlaying(); advanceTime(60_000); session.finishAd(); }
    const ids = vi.mocked(ports.showAd).mock.calls.map(([ad]) => ad.id);
    for (let n = 0; n < 9; n += 3) expect(new Set(ids.slice(n, n + 3)).size).toBe(3);
    for (let n = 1; n < 9; n++) expect(ids[n]).not.toBe(ids[n - 1]);
  });

  it('保存续播位置但新会话不自动启动；主动离开只清理不恢复', async () => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); advanceTime(15_000); session.mediaPosition(80); session.exit();
    const restored = fixture(session.getData());
    expect(restored.session.getState().mode).toBe('normal');
    expect(restored.ports.navigate).not.toHaveBeenCalled();
    await restored.session.resume();
    expect(restored.ports.navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'A1' }), 80);
    expect(restored.session.getState().elapsedMs).toBe(15_000);
    session.resume(); await settle(); session.mediaPlaying(); advanceTime(45_000);
    session.leave(); expect(ports.closeAd).toHaveBeenCalled(); expect(ports.play).not.toHaveBeenCalled();
  });

  it('整份片单不可用时停止；自动播放受限不会跳条目', async () => {
    const { session, ports } = fixture();
    await session.start(); session.autoplayBlocked();
    expect(session.getState().status).toBe('blocked'); expect(ports.navigate).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 5; n++) { session.mediaFailed('仅可试看'); await settle(); }
    expect(session.getState().status).toBe('stopped');
    expect(ports.navigate).toHaveBeenCalledTimes(5);
  });

  it('保存完成前不导航，退出取消尚未发生的导航', async () => {
    const { session, ports } = fixture();
    let resolve!: () => void;
    vi.mocked(ports.save).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const starting = session.start(); expect(ports.navigate).not.toHaveBeenCalled();
    session.leave(); resolve(); await starting;
    expect(ports.navigate).not.toHaveBeenCalled();
  });

  it('保存失败不切集，广告设置修改不结束动画会话', async () => {
    const { session, ports, data, advanceTime } = fixture();
    vi.mocked(ports.save).mockRejectedValueOnce(new Error('storage'));
    await session.start();
    expect(ports.navigate).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('blocked');
    await session.resume(); session.mediaPlaying(); advanceTime(10_000);
    session.configure({ ...data.config, animationAds: false }); advanceTime(10_000);
    expect(session.getState().mode).toBe('animation');
    expect(session.getState().elapsedMs).toBe(20_000);
  });

  it('广告失败先清理覆盖再恢复且不连续补播', async () => {
    const { session, ports, advanceTime } = fixture();
    const actions: string[] = [];
    vi.mocked(ports.closeAd).mockImplementation(() => { actions.push('close'); });
    vi.mocked(ports.play).mockImplementation(() => { actions.push('play'); });
    await session.start(); session.mediaPlaying(); advanceTime(60_000);
    session.mediaFailed('广告不可用');
    expect(actions).toEqual(['close', 'play']);
    expect(session.getState().elapsedMs).toBe(0);
    expect(ports.showAd).toHaveBeenCalledOnce();
  });

  it('跨页面保留广告遍历顺序，广告中断按跳过重新计时', async () => {
    let context = fixture();
    context.session.configure({ ...context.data.config,
      ads: ['x', 'y', 'z'].map(id => ({ id, title: id, url: 'https://www.bilibili.com/video/BV13r4y117HE/' })) });
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) {
      await context.session.resumeNavigation(); context.session.mediaPlaying(); context.advanceTime(60_000);
      ids.push(context.session.getState().ad!.id);
      context = fixture(context.session.getData());
      await context.session.resumeNavigation();
      expect(context.session.getState().elapsedMs).toBe(0);
      expect(context.session.getState().ad).toBeNull();
    }
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(new Set(ids.slice(3, 6)).size).toBe(3);
    expect(ids[2]).not.toBe(ids[3]);
  });

  it('损坏存储只保留合法配置与非负进度', () => {
    const data = normalizePlaybackData({ config: { intervalMinutes: -1, works: [null], ads: [{ id: 'x', title: 'x', url: 'javascript:alert(1)' }] },
      progress: { cursor: Infinity, position: -1, animationElapsedMs: NaN } });
    expect(data.config.intervalMinutes).toBe(20);
    expect(data.config.works).toEqual([]); expect(data.config.ads).toEqual([]);
    expect(data.progress.position).toBe(0); expect(data.progress.animationElapsedMs).toBe(0);
  });

  it('同页导航期间立即报告的失效来源也会跳过', async () => {
    const { session, ports } = fixture();
    vi.mocked(ports.navigate).mockImplementationOnce(async () => { session.mediaFailed('仅可试看'); });
    await session.start(); await settle();
    expect(vi.mocked(ports.navigate).mock.calls.map(([entry]) => entry.id)).toEqual(['A1', 'B1']);
    expect(session.getState().current?.id).toBe('B1');
  });

  it('保存期间暂停会取消待定导航，继续再导航而非播放旧页面', async () => {
    const { session, ports } = fixture();
    let resolve!: () => void;
    vi.mocked(ports.save).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const starting = session.start(); session.pause(); resolve(); await starting;
    expect(ports.navigate).not.toHaveBeenCalled();
    expect(session.getState().status).toBe('paused');
    session.continuePlayback(); await settle();
    expect(ports.navigate).toHaveBeenCalledOnce(); expect(ports.play).not.toHaveBeenCalled();
  });

  it('只接受可独立定位的B站链接并去掉跟踪参数', () => {
    expect(normalizePlaybackUrl('https://www.bilibili.com/video/BV1Ex411q7SJ?p=1&spm_id_from=foo'))
      .toBe(normalizePlaybackUrl('https://www.bilibili.com/video/BV1Ex411q7SJ/'));
    expect(normalizePlaybackUrl('https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2&spm_id_from=foo'))
      .toBe('https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2');
    expect(normalizePlaybackUrl('https://www.bilibili.com/bangumi/play/ep123')).toBe('https://www.bilibili.com/bangumi/play/ep123');
    expect(normalizePlaybackUrl('https://www.bilibili.com/bangumi/play/ss123')).toBeNull();
    expect(normalizePlaybackUrl('https://evil.test/video/BV1Ex411q7SJ')).toBeNull();
    expect(normalizePlaybackUrl('https://www.bilibili.com/video/BV1Ex411q7SJ/?p=0')).toBeNull();
  });
});
