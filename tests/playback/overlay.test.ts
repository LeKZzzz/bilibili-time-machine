import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdvertisementOverlay } from '../../src/playback/overlay';
import type { PlaybackPlayer, PlaybackPlayerEvent } from '../../src/playback/player';

const playback = vi.hoisted(() => ({ createPlaybackPlayer: vi.fn() }));
vi.mock('../../src/playback/player', () => ({ createPlaybackPlayer: playback.createPlaybackPlayer }));

type MediaState = {
  video: HTMLVideoElement;
  setTime(seconds: number): void;
  setPaused(paused: boolean): void;
  setSeeking(seeking: boolean): void;
};

let clockNow = 0;

function advance(milliseconds: number) {
  clockNow += milliseconds;
  vi.advanceTimersByTime(milliseconds);
}

function makeMedia(time = 0): MediaState {
  const video = document.createElement('video');
  let currentTime = time;
  let paused = true;
  let seeking = false;
  Object.defineProperties(video, {
    currentTime: { configurable: true, get: () => currentTime, set: (value: number) => { currentTime = value; } },
    paused: { configurable: true, get: () => paused },
    seeking: { configurable: true, get: () => seeking },
    readyState: { configurable: true, value: 4 },
  });
  return {
    video,
    setTime(seconds) { currentTime = seconds; },
    setPaused(value) { paused = value; },
    setSeeking(value) { seeking = value; },
  };
}

describe('公益广告覆盖层分段与续播', () => {
  let overlay: ReturnType<typeof createAdvertisementOverlay> | undefined;
  let media: MediaState;
  let seekTarget: number | undefined;
  let emit: (event: PlaybackPlayerEvent) => void;
  let onProgress: ReturnType<typeof vi.fn>;
  let onFinish: ReturnType<typeof vi.fn>;
  let adPlayer: PlaybackPlayer;

  function setup(position = 0) {
    document.body.innerHTML = '<div class="bpx-player-container"><video></video></div>';
    const original = document.querySelector('video')!;
    const originalPlayer = {
      media: () => original,
      pause: vi.fn(),
      play: vi.fn(async () => {}),
      seek: vi.fn(),
      releaseEnded: vi.fn(),
      refresh: vi.fn(),
      destroy: vi.fn(),
    } satisfies PlaybackPlayer;
    media = makeMedia();
    seekTarget = undefined;
    onProgress = vi.fn();
    onFinish = vi.fn();
    playback.createPlaybackPlayer.mockImplementation((input: { onEvent(event: PlaybackPlayerEvent): void }) => {
      emit = input.onEvent;
      adPlayer = {
        media: () => media.video,
        play: vi.fn(async () => { media.setPaused(false); }),
        pause: vi.fn(() => media.setPaused(true)),
        seek: vi.fn((seconds: number) => {
          seekTarget = seconds;
          emit({ type: 'positioning' });
        }),
        releaseEnded: vi.fn(),
        refresh: vi.fn(),
        destroy: vi.fn(),
      };
      return adPlayer;
    });
    overlay = createAdvertisementOverlay({
      url: '/video/BV1test12345',
      window,
      player: originalPlayer,
      position,
      onProgress,
      onFinish,
    });
    const frame = document.querySelector('[data-time-machine-ad]')!.shadowRoot!.querySelector('iframe')!;
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: window });
    frame.dispatchEvent(new Event('load'));
    expect(playback.createPlaybackPlayer).toHaveBeenCalled();
    emit({ type: 'media' });
  }

  function confirmSeek() {
    media.setTime(seekTarget ?? 0);
    media.setSeeking(false);
    emit({ type: 'positioned' });
  }

  function startPlaying() {
    confirmSeek();
    media.setPaused(false);
    emit({ type: 'playing' });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clockNow = 0;
    vi.spyOn(window.performance, 'now').mockImplementation(() => clockNow);
    playback.createPlaybackPlayer.mockReset();
  });

  afterEach(() => {
    overlay?.destroy();
    overlay = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('单次插播最多累计实际播放60秒', () => {
    setup();
    startPlaying();
    advance(59_750);
    expect(onFinish).not.toHaveBeenCalled();
    advance(250);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith('segment');
  });

  it('重复playing事件不会重置已累计播放时间', () => {
    setup();
    startPlaying();
    advance(20_000);
    emit({ type: 'playing' });
    advance(39_750);
    expect(onFinish).not.toHaveBeenCalled();
    advance(250);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith('segment');
  });

  it('暂停、缓冲和拖动期间不消耗60秒额度', () => {
    setup();
    startPlaying();
    advance(10_000);
    media.setPaused(true);
    emit({ type: 'pause' });
    advance(10_000);
    media.setPaused(false);
    emit({ type: 'waiting' });
    advance(20_000);
    media.setSeeking(true);
    emit({ type: 'seeking' });
    advance(15_000);
    media.setTime(90);
    media.setSeeking(false);
    emit({ type: 'seeked' });
    media.setPaused(false);
    emit({ type: 'playing' });
    advance(49_750);
    expect(onFinish).not.toHaveBeenCalled();
    advance(250);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith('segment');
  });

  it('自然结束优先于达到分段上限并保存尾段进度', () => {
    setup(12);
    startPlaying();
    media.setTime(59);
    clockNow = 60_001;
    emit({ type: 'ended' });
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith('ended');
    expect(onProgress).toHaveBeenLastCalledWith(59);
  });

  it('确认定位前不写入0，暂停与跳过时报告已确认进度', () => {
    setup(35);
    expect(onProgress).not.toHaveBeenCalled();
    advance(1_000);
    expect(onProgress).not.toHaveBeenCalled();
    startPlaying();
    media.setTime(42);
    media.setPaused(true);
    emit({ type: 'pause' });
    expect(onProgress).toHaveBeenLastCalledWith(42);
    const skip = document.querySelector('[data-time-machine-ad]')!.shadowRoot!.querySelector<HTMLButtonElement>('.skip')!;
    skip.click();
    expect(onProgress).toHaveBeenLastCalledWith(42);
    expect(onFinish).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledWith('skipped');
  });

  it('播放器媒体替换后使用最近保存的进度定位', () => {
    setup(25);
    startPlaying();
    media.setTime(41);
    advance(250);
    const replacement = makeMedia();
    media = replacement;
    emit({ type: 'media' });
    expect(adPlayer.seek).toHaveBeenLastCalledWith(41);
    expect(onProgress).toHaveBeenLastCalledWith(41);
    expect(onProgress).not.toHaveBeenLastCalledWith(0);
  });
});
