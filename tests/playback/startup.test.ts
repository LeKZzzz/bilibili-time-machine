// @vitest-environment-options { "url": "https://www.bilibili.com/video/BV1Ex411q7SJ/" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPlaybackData, type PlaybackData } from '../../src/playback/model';
import { createPlaybackRuntime, type PlaybackRuntime } from '../../src/playback/runtime';

let runtime: PlaybackRuntime;
let saved: PlaybackData | undefined;
let video: HTMLVideoElement;
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function media(readyState = 4): HTMLVideoElement {
  const element = document.createElement('video');
  for (const [key, value] of Object.entries({ readyState, paused: true, seeking: false, ended: false, duration: 1600 })) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true });
  }
  return element;
}
function set(values: Partial<{ readyState: number; paused: boolean; seeking: boolean; ended: boolean }>): void {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(video, key, { value, configurable: true, writable: true });
}
function emit(type: string): void { video.dispatchEvent(new Event(type)); }
async function mount(position: number, readyState = 4): Promise<void> {
  const data = createDefaultPlaybackData(); data.config.animationAds = false; data.progress.position = position;
  video = media(readyState); document.querySelector('.bpx-player-container')!.append(video);
  runtime = createPlaybackRuntime(window, data, {
    async get() { return saved; }, async set(_key, value) { saved = structuredClone(value) as PlaybackData; }, async remove() {},
  });
  await flush();
  await runtime.command({ type: position === 0 ? 'start' : 'resume' });
}
function settle(position: number): void {
  set({ readyState: 4, paused: false, seeking: false });
  emit('canplay'); emit('playing');
  video.currentTime = position + 0.1; emit('timeupdate');
  video.currentTime = position + 0.3; emit('timeupdate');
}
beforeEach(() => {
  vi.useFakeTimers(); saved = undefined;
  window.history.replaceState(null, '', '/video/BV1Ex411q7SJ/');
  vi.spyOn(window.performance, 'now').mockImplementation(() => Date.now());
  document.body.innerHTML = '<div class="bpx-player-container"></div>';
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true, writable: true });
    this.dispatchEvent(new Event('playing'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true, writable: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(async () => { runtime?.destroy(); await flush(); vi.clearAllTimers(); vi.useRealTimers(); document.body.innerHTML = ''; });

describe('真实播放器与会话的起播接线', () => {
  it.each([0, 567])('元数据迟到且先进入waiting时仍定位到%s，稳定播放后才保存媒体位置', async position => {
    await mount(position, 0);
    video.currentTime = 1570; emit('waiting');
    set({ readyState: 1 }); emit('loadedmetadata');
    expect(video.currentTime).toBe(1570);
    emit('seeking'); emit('waiting');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved?.progress.position).toBe(position);
    settle(position);
    expect(runtime.getState().status).toBe('playing');
    await vi.advanceTimersByTimeAsync(5000);
    expect(saved?.progress.position).toBeCloseTo(position + 0.3);
    expect(runtime.getState().elapsedMs).toBe(5000);
  });

  it.each([0, 567])('目标%s在初始化被旧尾段覆盖时只纠正一次，不把旧ended当作播完', async position => {
    await mount(position, 1);
    set({ readyState: 4 }); emit('canplay');
    await vi.advanceTimersByTimeAsync(4000);
    video.currentTime = 1570; emit('seeking');
    expect(video.currentTime).toBe(position);
    const nativeEnded = vi.fn(); video.addEventListener('ended', nativeEnded);
    video.currentTime = 1600; set({ ended: true }); emit('ended');
    await flush();
    expect(nativeEnded).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({ status: 'blocked', current: { id: 'pig-magic-1' } });
    expect(saved?.progress).toMatchObject({ cursor: 0, position });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.currentTime).toBe(1600);
    expect(runtime.getState().status).toBe('blocked');
  });

  it('一次初始化纠正成功后接受用户拖动和真正片尾', async () => {
    await mount(567, 1);
    set({ readyState: 4 }); emit('canplay');
    video.currentTime = 1570; emit('seeking');
    emit('ended');
    expect(runtime.getState().current?.id).toBe('pig-magic-1');
    settle(567);
    expect(runtime.getState().status).toBe('playing');
    video.currentTime = 1590; emit('seeking'); emit('seeked');
    expect(video.currentTime).toBe(1590);
    expect(runtime.getState().status).toBe('playing');
    // 同页单条循环可以验证真正 ended 已放行调度，避免 jsdom 顶层导航。
    const config = runtime.getState().config;
    await runtime.command({ type: 'exit' });
    config.works = [{ ...config.works[0], entries: [config.works[0].entries[0]] }];
    await runtime.command({ type: 'save-config', config });
    await runtime.command({ type: 'start' }); settle(0);
    video.currentTime = 1600; set({ ended: true }); emit('ended'); await flush();
    expect(saved?.progress.round).toBe(1);
    expect(video.currentTime).toBe(0);
  });

  it('初始化替换媒体后向新媒体定位，不接受旧媒体事件', async () => {
    await mount(567, 1);
    set({ readyState: 4 }); emit('canplay');
    const previous = video;
    video = media(); video.currentTime = 1570; previous.replaceWith(video);
    await vi.advanceTimersByTimeAsync(500);
    expect(video.currentTime).toBe(567);
    previous.currentTime = 1600; previous.dispatchEvent(new Event('ended'));
    settle(567);
    expect(runtime.getState()).toMatchObject({ status: 'playing', current: { id: 'pig-magic-1' } });
  });

  it.each(['pause', 'exit'] as const)('%s取消未完成定位，不被迟到事件或定时刷新自动播放', async action => {
    await mount(567, 0);
    await runtime.command({ type: action });
    vi.mocked(video.play).mockClear();
    video.currentTime = 1570; set({ readyState: 4 }); emit('loadedmetadata'); emit('waiting'); emit('canplay');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play).not.toHaveBeenCalled(); expect(video.currentTime).toBe(1570);
    expect(saved?.progress.position).toBe(567);
    if (action === 'pause') expect(runtime.getState().status).toBe('paused');
  });

  it.each(['pointerdown', 'keydown'])('播放器内%s交还用户控制，初始化不拉回用户拖动或暂停', async input => {
    await mount(567, 1);
    video.dispatchEvent(new Event(input, { bubbles: true }));
    video.currentTime = 900; emit('seeking');
    set({ paused: true, readyState: 4 }); emit('pause'); emit('waiting');
    vi.mocked(video.play).mockClear(); await vi.advanceTimersByTimeAsync(5000);
    expect(video.play).not.toHaveBeenCalled(); expect(video.currentTime).toBe(900);
    expect(runtime.getState().status).toBe('paused');
    expect(saved?.progress.position).toBe(900);
  });

  it('自动播放拒绝终止初始化和自动重试，保留手动继续入口', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    await mount(567, 1);
    expect(runtime.getState().status).toBe('blocked');
    vi.mocked(video.play).mockClear(); set({ readyState: 4 }); emit('waiting'); emit('canplay');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({ status: 'blocked', message: '点击继续播放' });
  });

  it.each(['pause', 'blocked', 'position-conflict'])('%s后点击继续重新定位保存目标并恢复计时', async reason => {
    if (reason === 'blocked') vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    await mount(567, 1);
    if (reason === 'pause') await runtime.command({ type: 'pause' });
    if (reason === 'position-conflict') {
      set({ readyState: 4 }); emit('canplay');
      video.currentTime = 1570; emit('seeking');
      video.currentTime = 1570; emit('seeking');
    }
    expect(runtime.getState().status).toBe(reason === 'pause' ? 'paused' : 'blocked');
    video.currentTime = 1570; set({ readyState: 4 });
    await runtime.command({ type: 'continue' });
    expect(video.currentTime).toBe(567);
    settle(567);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getState()).toMatchObject({ status: 'playing', elapsedMs: 1000 });
  });

  it('主动导航取消旧条目的初始化，不在普通页纠正位置或重试播放', async () => {
    await mount(567, 1);
    vi.mocked(video.play).mockClear();
    window.history.replaceState(null, '', '/video/BV1QJfPYQEYg/');
    video.currentTime = 1570; set({ paused: true, readyState: 4 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(1570);
    expect(runtime.getState().mode).toBe('normal');
    expect(saved?.progress.position).toBe(567);
  });

  it('稳定播放后暂停并拖动，立即点击继续保留用户刚选的位置', async () => {
    await mount(0); settle(0);
    await runtime.command({ type: 'pause' });
    video.currentTime = 500; emit('seeking'); emit('seeked');
    await runtime.command({ type: 'continue' });
    expect(video.currentTime).toBe(500);
    settle(500);
    expect(runtime.getState().status).toBe('playing');
  });

  it.each([0, 567])('目标%s等待可播放且seek结束后才定位，中间加载事件不消耗纠正机会', async position => {
    await mount(position, 1);
    video.currentTime = 30;
    for (let index = 0; index < 3; index++) {
      emit('loadstart'); emit('loadedmetadata');
      set({ seeking: true }); emit('seeking'); emit('waiting');
      await vi.advanceTimersByTimeAsync(500);
      expect(video.currentTime).toBe(30);
      expect(runtime.getState().status).not.toBe('blocked');
    }
    set({ readyState: 4 }); emit('canplay');
    expect(video.currentTime).toBe(30);
    set({ seeking: false }); emit('seeked');
    expect(video.currentTime).toBe(position);
    // 一次已开始的定位在加载阶段收到多个事件，不能当作多次独立冲突。
    video.currentTime = 1570; set({ readyState: 1, seeking: true });
    emit('seeking'); emit('waiting'); emit('timeupdate');
    await vi.advanceTimersByTimeAsync(2000);
    expect(video.currentTime).toBe(1570);
    expect(runtime.getState().status).not.toBe('blocked');
    set({ readyState: 4, seeking: false }); emit('seeked');
    expect(video.currentTime).toBe(position);
    settle(position);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getState().status).toBe('playing');
    expect(runtime.getState().elapsedMs).toBeGreaterThan(0);
  });

  it.each(['pointerdown', 'keydown'])('定位耗尽后仅播放器内明确%s允许原生播放重新接入计时', async input => {
    await mount(0);
    video.currentTime = 30; emit('seeking');
    video.currentTime = 156; emit('seeking');
    expect(runtime.getState().status).toBe('blocked');
    // 没有用户接管的 playing 不应接受错误的初始化位置。
    set({ paused: false }); emit('playing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getState()).toMatchObject({ status: 'blocked', elapsedMs: 0 });
    video.dispatchEvent(new Event(input, { bubbles: true }));
    video.currentTime = 178; emit('playing');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getState()).toMatchObject({ status: 'playing', elapsedMs: 1000 });
    await runtime.command({ type: 'pause' });
    expect(saved?.progress.position).toBe(178);
  });

  it.each(['abort', 'late-pause'])('初始化%s后就绪时只自动恢复一次，迟到waiting不隐藏暂停入口', async reason => {
    if (reason === 'abort') vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('interrupted', 'AbortError'));
    await mount(0, 1);
    video.currentTime = 0.32;
    set({ readyState: 4, paused: true }); emit('pause'); emit('waiting');
    expect(runtime.getState().status).toBe('paused');
    await vi.advanceTimersByTimeAsync(500);
    expect(video.play).toHaveBeenCalledTimes(2);
    settle(0);
    expect(runtime.getState().status).toBe('playing');
    set({ paused: true }); emit('pause'); emit('waiting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(runtime.getState().status).toBe('paused');
  });

  it('播放中止后的唯一重试等待seek完成，不在就绪但仍seeking时消耗', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('interrupted', 'AbortError'));
    await mount(567, 1);
    set({ readyState: 4, paused: true, seeking: true }); emit('seeking');
    await vi.advanceTimersByTimeAsync(2000);
    expect(video.play).toHaveBeenCalledTimes(1);
    set({ seeking: false }); emit('seeked');
    await vi.advanceTimersByTimeAsync(500);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.currentTime).toBe(567);
    set({ paused: true }); emit('pause');
    await vi.advanceTimersByTimeAsync(5000);
    expect(video.play).toHaveBeenCalledTimes(2);
  });
});
