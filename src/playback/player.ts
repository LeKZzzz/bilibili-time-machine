import { normalizePlaybackUrl } from './model';

export type PlaybackPlayerEvent = {
  type: 'media' | 'positioning' | 'positioned' | 'playing' | 'pause' | 'waiting' | 'seeking' | 'seeked' | 'ended' | 'unavailable' | 'blocked';
  reason?: string;
};

export interface PlaybackPlayer {
  media(): HTMLVideoElement | null;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  releaseEnded(): void;
  refresh(): void;
  destroy(): void;
}

type PageWindow = Window & { __playinfo__?: unknown; __INITIAL_STATE__?: unknown };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export function findPlaybackMedia(document: Document): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>(
    '.bpx-player-container video, .bilibili-player-video video, #bilibili-player video, #bilibiliPlayer video',
  );
}

export function playbackUnavailableReason(page: Window): string | null {
  const initialError = record(record((page as PageWindow).__INITIAL_STATE__).error);
  if (initialError.code === 404 || initialError.trueCode === -404) return '当前视频已失效';
  const info = record((page as PageWindow).__playinfo__);
  const result = record(info.result ?? info.data);
  const videoInfo = record(result.video_info);
  const detail = record(result.play_check).play_detail;
  // 只看当前条目的明确播放判定，季级会员标识不代表当前账号无权观看。
  const decision = JSON.stringify(detail ?? '');
  if (videoInfo.is_preview === true || result.is_preview === true || decision.includes('PLAY_PREVIEW')) {
    return '当前条目仅可试看，已跳过';
  }
  if (/PLAY_(?:PAY|BUY|FORBIDDEN|DENIED|AREA_LIMIT)/.test(decision)) return '当前条目需要购买或无完整观看权限';
  if (typeof info.code === 'number' && info.code !== 0) {
    return typeof info.message === 'string' ? info.message : '当前条目无法播放';
  }
  const document = page.document;
  const blocking = document.querySelector(
    '.bpx-player-ending-panel, .bpx-player-toast-wrap, .bpx-player-dialog-wrap, .bilibili-player-video-toast, .error-container, .error-panel',
  )?.textContent ?? '';
  if (/试看已结束|仅可试看|应版权方要求|所在地区.*无法|视频已失效|视频已被删除|视频不见了/.test(blocking)) {
    return '当前条目已受播放限制或失效';
  }
  if (/视频去哪了|视频不见了/.test(document.title)) return '当前视频已失效';
  return null;
}

export function createPlaybackPlayer(options: {
  window?: Window;
  managed?(): boolean;
  onEvent(event: PlaybackPlayerEvent): void;
  shouldHoldEnded(): boolean;
}): PlaybackPlayer {
  const page = options.window ?? window;
  const document = page.document;
  let media: HTMLVideoElement | null = null;
  let held: HTMLVideoElement | null = null;
  let replaying = false;
  let destroyed = false;
  let lastFailure: string | null = null;
  let pendingSeek: {
    position: number; media: HTMLVideoElement | null; attempts: number;
    appliedAt: number; sample: number | null; playRequested: boolean; retryUsed: boolean;
  } | null = null;
  let unconfirmedPosition = false;
  let playGeneration = 0;
  let playingRequest = false;
  const routeIdentity = () => normalizePlaybackUrl(page.location.href) ?? page.location.href;
  let lastUrl = routeIdentity();
  let lastPlayinfo = (page as PageWindow).__playinfo__;
  let stalePlayinfo: unknown;
  const failedMedia = new WeakSet<HTMLVideoElement>();
  const managed = () => options.managed?.() ?? true;
  const currentFailure = () => {
    const info = (page as PageWindow).__playinfo__;
    if (lastUrl !== routeIdentity()) {
      lastUrl = routeIdentity();
      stalePlayinfo = info === lastPlayinfo ? info : undefined;
      lastFailure = null;
      held = null;
      cancelPosition();
      unconfirmedPosition = false;
    }
    lastPlayinfo = info;
    // SPA 路由先变而页面播放判定尚未替换时，不拿上一集的权限拒绝新条目。
    if (stalePlayinfo !== undefined && info === stalePlayinfo) return null;
    return playbackUnavailableReason(page);
  };
  const reportFailure = () => {
    const reason = currentFailure();
    if (!managed()) { lastFailure = null; return null; }
    if (reason && reason !== lastFailure) {
      lastFailure = reason;
      media?.pause();
      options.onEvent({ type: 'unavailable', reason });
    } else if (!reason) lastFailure = null;
    return reason;
  };
  const cancelPosition = () => { pendingSeek = null; playGeneration++; playingRequest = false; };
  const finishPosition = () => {
    pendingSeek = null;
    unconfirmedPosition = false;
    options.onEvent({ type: 'positioned' });
  };
  const applySeek = (): boolean => {
    const request = pendingSeek;
    if (!managed()) { cancelPosition(); return false; }
    // 元数据到达不代表媒体已经能完成定位，正在进行的 seek 也不算新的冲突。
    if (!media || !request || media.readyState < 3 || media.seeking) return false;
    // 初始化只允许一次纠正；持续争抢位置时交还用户，不循环拖动或跳过条目。
    if (request.attempts >= 2) {
      cancelPosition(); media.pause();
      options.onEvent({ type: 'blocked', reason: '起播位置被改变，请点击继续播放' });
      return false;
    }
    request.media = media; request.attempts++; request.sample = null;
    request.appliedAt = page.performance.now();
    media.currentTime = request.position;
    return true;
  };
  const checkPosition = (): boolean => {
    const request = pendingSeek;
    if (!request || !media) return true;
    if (media.readyState < 3 || media.seeking) return false;
    if (request.media !== media) { applySeek(); return false; }
    // 首帧可能有时间戳偏移；只接受目标附近按真实经过时间推进的位置。
    const elapsed = Math.max(0, page.performance.now() - request.appliedAt) / 1000;
    if (media.currentTime < request.position - 1
      || media.currentTime > request.position + elapsed * Math.max(1, media.playbackRate) + 1) {
      applySeek(); return false;
    }
    return true;
  };
  const playMedia = async () => {
    if (!media || reportFailure()) return;
    if (pendingSeek) pendingSeek.playRequested = true;
    const target = media;
    const generation = ++playGeneration;
    playingRequest = true;
    try { await target.play(); } catch (error) {
      if (destroyed || generation !== playGeneration || target !== media) return;
      if ((error as { name?: string }).name === 'NotAllowedError') {
        cancelPosition();
        options.onEvent({ type: 'blocked', reason: '点击继续播放' });
      } else if ((error as { name?: string }).name === 'AbortError') {
        options.onEvent({ type: 'pause' });
      } else if (managed() && !failedMedia.has(target)) {
        cancelPosition(); failedMedia.add(target);
        options.onEvent({ type: 'unavailable', reason: '无法开始播放当前条目' });
      }
    } finally { if (generation === playGeneration) playingRequest = false; }
  };
  const refresh = () => {
    if (destroyed) return;
    currentFailure();
    if (!managed() && unconfirmedPosition) { cancelPosition(); unconfirmedPosition = false; }
    const next = findPlaybackMedia(document);
    if (media !== next) {
      media = next;
      held = null;
      playGeneration++; playingRequest = false;
      if (pendingSeek) options.onEvent({ type: 'positioning' });
      options.onEvent({ type: 'media' });
    }
    reportFailure();
    if (pendingSeek && pendingSeek.media !== media) applySeek();
    const request = pendingSeek;
    if (request && media && media.readyState >= 3 && !media.seeking && media.paused && request.playRequested
      && !playingRequest && !request.retryUsed) {
      request.retryUsed = true;
      void playMedia();
    }
  };
  const onMediaEvent = (event: Event) => {
    if (destroyed || replaying) return;
    if (event.target !== media) {
      if (event.target !== findPlaybackMedia(document)) return;
      refresh();
    }
    if (event.type === 'loadedmetadata') { if (pendingSeek?.media !== media) applySeek(); return; }
    if (event.type === 'loadstart') { if (media) failedMedia.delete(media); return; }
    if (pendingSeek && ['seeking', 'seeked', 'canplay', 'playing', 'timeupdate', 'ended'].includes(event.type)) {
      if (!checkPosition()) {
        if (event.type === 'ended') event.stopImmediatePropagation();
        return;
      }
      if (event.type === 'ended') {
        if (!media?.ended || !Number.isFinite(media.duration) || media.currentTime < media.duration - 1) {
          event.stopImmediatePropagation(); return;
        }
        finishPosition();
      }
      else if (event.type === 'timeupdate' && media && !media.paused && !media.seeking && media.readyState >= 3) {
        const previous = pendingSeek.sample;
        pendingSeek.sample = media.currentTime;
        if (previous !== null && media.currentTime > previous) {
          finishPosition(); options.onEvent({ type: 'playing' });
        }
      }
      if (pendingSeek && event.type === 'playing') return;
    }
    if (event.type === 'timeupdate' || event.type === 'canplay') return;
    if (event.type === 'ended') {
      if (!managed() && (currentFailure() || (media && failedMedia.has(media)))) return;
      if (reportFailure()) { event.stopImmediatePropagation(); return; }
      held = media;
      if (options.shouldHoldEnded()) {
        event.stopImmediatePropagation();
      } else held = null;
      options.onEvent({ type: 'ended' });
    } else if (event.type === 'error') {
      if (media && !failedMedia.has(media)) {
        failedMedia.add(media);
        if (managed()) options.onEvent({ type: 'unavailable', reason: '媒体加载或解码失败' });
      }
    } else {
      options.onEvent({ type: event.type as PlaybackPlayerEvent['type'] });
      if (event.type === 'seeked' && !pendingSeek && media && !media.paused && !media.ended && media.readyState >= 3) {
        options.onEvent({ type: 'playing' });
      }
    }
  };
  const events = ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error', 'loadstart', 'loadedmetadata', 'canplay', 'timeupdate'];
  for (const name of events) document.addEventListener(name, onMediaEvent, true);
  const onPlayerInput = (event: Event) => {
    if (!unconfirmedPosition || !managed() || !media) return;
    const container = media.closest('.bpx-player-container, .bilibili-player-video, #bilibili-player, #bilibiliPlayer');
    if (!event.composedPath().some(node => node === container || node === media)) return;
    // 定位失败后也允许用户明确接管原生播放器；普通 playing 事件不能自行放开门控。
    cancelPosition(); finishPosition();
  };
  document.addEventListener('pointerdown', onPlayerInput, true);
  document.addEventListener('keydown', onPlayerInput, true);
  // 页面对象可能晚于 DOM 更新；复用轮询检查权限及一次起播恢复，不把缓冲超时当作失效。
  const timer = page.setInterval(refresh, 500);
  queueMicrotask(refresh);
  return {
    media: () => media,
    refresh,
    async play() { refresh(); await playMedia(); },
    pause() { cancelPosition(); media?.pause(); },
    seek(seconds) {
      unconfirmedPosition = true;
      pendingSeek = { position: Math.max(0, seconds), media: null, attempts: 0,
        appliedAt: page.performance.now(), sample: null, playRequested: false, retryUsed: false };
      options.onEvent({ type: 'positioning' });
      applySeek();
    },
    releaseEnded() {
      const target = held;
      held = null;
      if (!target || !target.isConnected) return;
      // 重放给原生监听器，保留用户的“播完暂停”与自动连播设置。
      replaying = true;
      try { target.dispatchEvent(new Event('ended')); } finally { replaying = false; }
    },
    destroy() {
      destroyed = true;
      page.clearInterval(timer);
      for (const name of events) document.removeEventListener(name, onMediaEvent, true);
      document.removeEventListener('pointerdown', onPlayerInput, true);
      document.removeEventListener('keydown', onPlayerInput, true);
      cancelPosition();
      held = null;
    },
  };
}
