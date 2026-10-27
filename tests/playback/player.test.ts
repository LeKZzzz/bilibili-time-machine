// @vitest-environment-options { "url": "https://www.bilibili.com/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackPlayer, playbackUnavailableReason, type PlaybackPlayer } from '../../src/playback/player';
import { createAdvertisementOverlay } from '../../src/playback/overlay';

describe('真实播放器接入边界', () => {
  let player: PlaybackPlayer;
  let video: HTMLVideoElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button id="before">开始</button><div class="bpx-player-container"><video></video></div>';
    video = document.querySelector('video')!;
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  });
  afterEach(() => {
    player?.destroy();
    delete (window as Window & { __playinfo__?: unknown }).__playinfo__;
    delete (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });
  it('截住原生片尾，在放行后才通知原生监听器', () => {
    player = createPlaybackPlayer({ onEvent: vi.fn(), shouldHoldEnded: () => true });
    player.refresh();
    const nativeEnded = vi.fn();
    video.addEventListener('ended', nativeEnded);
    video.dispatchEvent(new Event('ended'));
    expect(nativeEnded).not.toHaveBeenCalled();
    player.releaseEnded();
    expect(nativeEnded).toHaveBeenCalledOnce();
    player.releaseEnded();
    expect(nativeEnded).toHaveBeenCalledOnce();
  });
  it('完整权限不被季级会员标记拒绝，明确试看在结束前被拒绝', () => {
    const page = window as Window & { __playinfo__?: unknown };
    page.__playinfo__ = { result: { play_check: { play_detail: 'PLAY_WHOLE' }, video_info: { is_preview: false }, status: 13 } };
    expect(playbackUnavailableReason(window)).toBeNull();
    page.__playinfo__ = { result: { play_check: { play_detail: 'PLAY_PREVIEW' }, video_info: { is_preview: true } } };
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    player.refresh();
    expect(onEvent).toHaveBeenCalledWith({ type: 'unavailable', reason: '当前条目仅可试看，已跳过' });
    const nativeEnded = vi.fn();
    video.addEventListener('ended', nativeEnded);
    video.dispatchEvent(new Event('ended'));
    expect(nativeEnded).not.toHaveBeenCalled();
  });
  it('识别真实UGC错误页的404状态，不等待自动跳转首页', () => {
    (window as Window & { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__ = { error: { code: 404, trueCode: -404, message: '啥都木有' } };
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    player.refresh();
    expect(onEvent).toHaveBeenCalledWith({ type: 'unavailable', reason: '当前视频已失效' });
  });
  it('同条目跟踪参数变化不会屏蔽明确试看判定', () => {
    const previousUrl = window.location.href;
    window.history.replaceState(null, '', '/video/BV1Ex411q7SJ/?p=1');
    (window as Window & { __playinfo__?: unknown }).__playinfo__ = { result: { video_info: { is_preview: true } } };
    const onEvent = vi.fn(); let managed = false;
    player = createPlaybackPlayer({ onEvent, managed: () => managed, shouldHoldEnded: () => false });
    player.refresh();
    window.history.replaceState(null, '', '/video/BV1Ex411q7SJ/?spm_id_from=333.788');
    managed = true; player.refresh();
    expect(onEvent).toHaveBeenCalledWith({ type: 'unavailable', reason: '当前条目仅可试看，已跳过' });
    window.history.replaceState(null, '', previousUrl);
  });
  it('替换媒体后继续监听，缓冲和拖动不变为失败', () => {
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    player.refresh();
    const replacement = document.createElement('video');
    video.replaceWith(replacement);
    vi.advanceTimersByTime(500);
    replacement.dispatchEvent(new Event('waiting'));
    replacement.dispatchEvent(new Event('seeking'));
    vi.advanceTimersByTime(60_000);
    expect(player.media()).toBe(replacement);
    expect(onEvent).toHaveBeenCalledWith({ type: 'waiting' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'seeking' });
    expect(onEvent.mock.calls.some(([event]) => event.type === 'unavailable')).toBe(false);
  });
  it('浏览器拒绝自动播放时等待点击，不跳过来源', async () => {
    vi.mocked(video.play).mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    await player.play();
    expect(onEvent).toHaveBeenCalledWith({ type: 'blocked', reason: '点击继续播放' });
    expect(onEvent.mock.calls.some(([event]) => event.type === 'unavailable')).toBe(false);
  });
  it('普通观看试看不暂停，也不将试看结束交给插播调度', () => {
    (window as Window & { __playinfo__?: unknown }).__playinfo__ = { result: { video_info: { is_preview: true } } };
    const onEvent = vi.fn();
    const shouldHoldEnded = vi.fn(() => true);
    player = createPlaybackPlayer({ managed: () => false, onEvent, shouldHoldEnded });
    player.refresh();
    const nativeEnded = vi.fn();
    video.addEventListener('ended', nativeEnded);
    video.dispatchEvent(new Event('ended'));
    expect(video.pause).not.toHaveBeenCalled();
    expect(shouldHoldEnded).not.toHaveBeenCalled();
    expect(nativeEnded).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls.some(([event]) => event.type === 'unavailable')).toBe(false);
  });
  it('拖动结束仅在媒体确实继续播放时恢复计时信号', () => {
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    player.refresh();
    video.dispatchEvent(new Event('seeked'));
    expect(onEvent).not.toHaveBeenCalledWith({ type: 'playing' });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
    video.dispatchEvent(new Event('seeked'));
    expect(onEvent).toHaveBeenCalledWith({ type: 'playing' });
  });
  it('同一次媒体载入重复报错只跳过一次', () => {
    const onEvent = vi.fn();
    player = createPlaybackPlayer({ onEvent, shouldHoldEnded: () => false });
    player.refresh();
    video.dispatchEvent(new Event('error'));
    video.dispatchEvent(new Event('error'));
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'unavailable')).toHaveLength(1);
  });
  it('路由已切换但播放判定仍为旧对象时不误跳过新条目', () => {
    const page = window as Window & { __playinfo__?: unknown };
    page.__playinfo__ = { result: { video_info: { is_preview: true } } };
    const onEvent = vi.fn();
    let isManaged = false;
    player = createPlaybackPlayer({ managed: () => isManaged, onEvent, shouldHoldEnded: () => false });
    player.refresh();
    const previousUrl = window.location.href;
    window.history.replaceState(null, '', '/bangumi/play/ep123');
    isManaged = true;
    player.refresh();
    expect(onEvent.mock.calls.some(([event]) => event.type === 'unavailable')).toBe(false);
    page.__playinfo__ = { result: { video_info: { is_preview: true } } };
    player.refresh();
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'unavailable')).toHaveLength(1);
    window.history.replaceState(null, '', previousUrl);
  });
  it('广告尚未加载也可跳过，保护正片暂停并恢复焦点', () => {
    player = createPlaybackPlayer({ onEvent: vi.fn(), shouldHoldEnded: () => false });
    player.refresh();
    const before = document.querySelector<HTMLButtonElement>('#before')!;
    before.focus();
    const onFinish = vi.fn();
    const overlay = createAdvertisementOverlay({ url: '/video/BV13r4y117HE/', player, onFinish });
    const layer = document.querySelector('[data-time-machine-ad]')!;
    expect(layer.parentElement).toBe(video.parentElement);
    video.dispatchEvent(new Event('play'));
    expect(video.pause).toHaveBeenCalled();
    layer.shadowRoot!.querySelector<HTMLButtonElement>('.skip')!.click();
    expect(document.querySelector('[data-time-machine-ad]')).toBeNull();
    expect(document.activeElement).toBe(before);
    expect(onFinish).toHaveBeenCalledWith('skipped');
    overlay.destroy();
    expect(onFinish).toHaveBeenCalledOnce();
  });
  it('广告播放器一直未载入时清罩，不继续阻挡正片', () => {
    player = createPlaybackPlayer({ onEvent: vi.fn(), shouldHoldEnded: () => false });
    player.refresh();
    const onFinish = vi.fn();
    createAdvertisementOverlay({ url: '/video/BV13r4y117HE/', player, onFinish });
    vi.advanceTimersByTime(30_000);
    expect(onFinish).toHaveBeenCalledWith('error');
    expect(document.querySelector('[data-time-machine-ad]')).toBeNull();
  });
  it('跳过控件使用顶层popover，全屏变化后恢复且退出时清理', () => {
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: showPopover, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'hidePopover', { value: hidePopover, configurable: true });
    try {
      player = createPlaybackPlayer({ onEvent: vi.fn(), shouldHoldEnded: () => false });
      player.refresh();
      const overlay = createAdvertisementOverlay({ url: '/video/BV13r4y117HE/', player, onFinish: vi.fn() });
      const layer = document.querySelector('[data-time-machine-ad]')!;
      const controls = layer.shadowRoot!.querySelector<HTMLElement>('.controls')!;
      expect(controls.getAttribute('popover')).toBe('manual');
      expect(showPopover).toHaveBeenCalledOnce();
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(showPopover).toHaveBeenCalledTimes(2);
      expect(hidePopover).toHaveBeenCalledOnce();
      overlay.destroy();
      expect(hidePopover).toHaveBeenCalledTimes(2);
      expect(layer.isConnected).toBe(false);
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(showPopover).toHaveBeenCalledTimes(2);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
      delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
    }
  });
});
