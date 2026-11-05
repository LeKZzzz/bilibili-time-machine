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
  it('重复链接优先保留当前存档条目，接入时不重置轮次和动画插播计时', async () => {
    const { session, data, ports } = fixture();
    session.configure(data.config, { ...data.progress, cursor: 1, position: 80, round: 2, animationElapsedMs: 5000 });
    await session.resume({ url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=1&vd_source=test', position: 32 });
    expect(session.getState()).toMatchObject({ current: { id: 'B1' }, next: { id: 'A2' } });
    expect(session.getData().progress).toMatchObject({ cursor: 1, position: 32, round: 2, animationElapsedMs: 5000 });
    expect(ports.navigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'B1' }), 32);
  });

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

  it.each([
    ['round-robin', 'sequential', 1, 'B2'],
    ['sequential', 'round-robin', 2, 'A2'],
  ] as const)('播放中从 %s 改为 %s 保留当前集，下一集按新顺序接续', async (before, after, steps, next) => {
    const { session, ports, data, advanceTime } = fixture();
    session.configure({ ...data.config, order: before });
    await session.start();
    for (let index = 0; index < steps; index++) { session.mediaEnded(); await settle(); }
    session.mediaPlaying(); session.mediaPosition(85.25); advanceTime(12_000);
    expect(session.getState().current?.id).toBe('B1');
    vi.mocked(ports.navigate).mockClear(); vi.mocked(ports.play).mockClear(); vi.mocked(ports.pause).mockClear();
    session.configure({ ...session.getData().config, order: after });
    expect(session.getState()).toMatchObject({ mode: 'animation', status: 'playing', current: { id: 'B1' }, next: { id: next }, elapsedMs: 12_000 });
    expect(session.getData().progress.position).toBe(85.25);
    expect(ports.navigate).not.toHaveBeenCalled(); expect(ports.play).not.toHaveBeenCalled(); expect(ports.pause).not.toHaveBeenCalled();
    advanceTime(3_000); expect(session.getState().elapsedMs).toBe(15_000);
    session.mediaEnded(); await settle();
    expect(ports.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ id: next }), 0);
  });

  it.each(['paused', 'blocked', 'waiting', 'ad'] as const)('%s 时切换顺序不会自动恢复、清除提示或打断广告', async status => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); session.mediaPosition(42);
    if (status === 'paused') session.pause();
    else if (status === 'blocked') session.autoplayBlocked();
    else if (status === 'waiting') session.mediaWaiting();
    else { advanceTime(60_000); session.adPosition(18); }
    const before = session.getState(); const progress = session.getData().progress;
    vi.mocked(ports.play).mockClear(); vi.mocked(ports.pause).mockClear();
    session.configure({ ...session.getData().config, order: 'sequential' });
    expect(session.getState()).toMatchObject({ mode: 'animation', status, message: before.message, ad: before.ad });
    expect(session.getData().progress).toEqual(progress);
    expect(ports.play).not.toHaveBeenCalled(); expect(ports.pause).not.toHaveBeenCalled(); expect(ports.closeAd).not.toHaveBeenCalled();
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

  it('完整播完的广告遍历后不跨轮连续重复', async () => {
    const { session, ports, data, advanceTime } = fixture();
    session.configure({ ...data.config, ads: ['x', 'y', 'z'].map(id => ({ id, title: id, url: 'https://www.bilibili.com/video/BV13r4y117HE/' })) });
    await session.start();
    for (let n = 0; n < 9; n++) { session.mediaPlaying(); advanceTime(60_000); session.finishAd(); }
    const ids = vi.mocked(ports.showAd).mock.calls.map(([ad]) => ad.id);
    for (let n = 0; n < 9; n += 3) expect(new Set(ids.slice(n, n + 3)).size).toBe(3);
    for (let n = 1; n < 9; n++) expect(ids[n]).not.toBe(ids[n - 1]);
  });

  it('长广告跨次续播同一条，完整播完后才轮换', async () => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); advanceTime(60_000);
    const ad = session.getState().ad!;
    session.adPosition(60); session.finishAd('segment');
    expect(ports.play).toHaveBeenCalledWith(0);
    session.mediaPlaying(); advanceTime(60_000);
    expect(ports.showAd).toHaveBeenLastCalledWith(ad, 60);
    session.adPosition(120); session.finishAd('segment');
    session.mediaPlaying(); advanceTime(60_000);
    expect(ports.showAd).toHaveBeenLastCalledWith(ad, 120);
    session.finishAd('ended');
    expect(session.getData().progress.adResume).toBeUndefined();
    session.mediaPlaying(); advanceTime(60_000);
    expect(session.getState().ad?.id).not.toBe(ad.id);
  });

  it.each(['skipped', 'segment'] as const)('%s 后刷新不立即插播，下次插播保留同一广告断点', async reason => {
    const first = fixture();
    await first.session.start(); first.session.mediaPlaying(); first.advanceTime(60_000);
    const ad = first.session.getState().ad!;
    first.session.adPosition(24.5); first.session.finishAd(reason);
    const restored = fixture(first.session.getData());
    expect(restored.ports.showAd).not.toHaveBeenCalled();
    await restored.session.resume(); restored.session.mediaPlaying(); restored.advanceTime(60_000);
    expect(restored.ports.showAd).toHaveBeenCalledWith(ad, 24.5);
  });

  it('广告退出时采集最后位置，片源失败后清除续播避免反复抽中失效片源', async () => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); advanceTime(60_000);
    const ad = session.getState().ad!;
    vi.mocked(ports.closeAd).mockImplementation(() => session.adPosition(32.75));
    session.exit();
    expect(session.getData().progress.adResume).toMatchObject({ id: ad.id, position: 32.75 });
    await session.resume(); session.mediaPlaying(); advanceTime(60_000);
    expect(ports.showAd).toHaveBeenLastCalledWith(ad, 32.75);
    session.finishAd('error');
    expect(session.getData().progress.adResume).toBeUndefined();
  });

  it('替换广告链接后不把旧视频断点用于新片源', async () => {
    const { session, ports, advanceTime } = fixture();
    await session.start(); session.mediaPlaying(); advanceTime(60_000);
    const ad = session.getState().ad!;
    session.adPosition(35); session.finishAd('segment');
    const config = session.getData().config;
    const replacementUrl = config.ads.find(entry => entry.url !== ad.url)!.url;
    config.ads = [{ ...ad, url: replacementUrl }];
    session.configure(config);
    expect(session.getData().progress.adResume).toBeUndefined();
    session.mediaPlaying(); advanceTime(60_000);
    expect(ports.showAd).toHaveBeenLastCalledWith(config.ads[0], 0);
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
