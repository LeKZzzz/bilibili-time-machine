import type { ConfigStorage } from '../runtime/config-store';
import { createDefaultPlaybackData, normalizePlaybackData, normalizePlaybackUrl, type PlaybackData } from './model';
import { PlaybackSession, type PlaybackState } from './session';
import { createPlaybackPlayer } from './player';
import { createAdvertisementOverlay } from './overlay';
import type { PlaybackPanelClient, PlaybackPanelCommand } from '../ui/playback-panel';

export const PLAYBACK_STORAGE_KEY = 'bilibili-time-machine.playback.v1';
const NAVIGATION_PREFIX = 'bilibili-time-machine:navigate:';

function isUnavailableRedirect(target: Window): boolean {
  return target.location.hostname === 'www.bilibili.com' && target.location.pathname === '/'
    && new URL(target.location.href).searchParams.get('spm_id_from') === '333.788.selfDef.errorpage';
}

export function isPlaybackPage(location: Location): boolean {
  return location.hostname === 'www.bilibili.com'
    && /^\/(?:video\/(?:BV[\da-z]+|av\d+)|bangumi\/play\/(?:ep|ss)\d+)(?:\/|$)/i.test(location.pathname);
}

export function isControlledPlaybackFrame(target: Window): boolean {
  return target.top !== target && target.name === 'bilibili-time-machine-ad';
}

/** 导航许可只放在当前窗口，不能随共享配置或 opener 的 sessionStorage 复制。 */
export function consumePlaybackNavigation(target: Window): boolean {
  if (!target.name.startsWith(NAVIGATION_PREFIX)) return false;
  const raw = target.name.slice(NAVIGATION_PREFIX.length);
  target.name = '';
  try {
    const ticket = JSON.parse(raw) as { url: string; previousName: string };
    target.name = typeof ticket.previousName === 'string' ? ticket.previousName : '';
    const navigation = target.performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    return navigation?.type !== 'reload' && navigation?.type !== 'back_forward'
      && (normalizePlaybackUrl(target.location.href) === ticket.url
        || (normalizePlaybackUrl(ticket.url) !== null && isUnavailableRedirect(target)));
  } catch {
    return false;
  }
}

export interface PlaybackRuntime extends PlaybackPanelClient {
  destroy(): void;
}

export function createPlaybackRuntime(target: Window, data: PlaybackData, storage: ConfigStorage): PlaybackRuntime {
  const listeners = new Set<(state: PlaybackState) => void>();
  let overlay: ReturnType<typeof createAdvertisementOverlay> | undefined;
  let destroyed = false;
  let systemNavigation = false;
  let pendingPosition: number | undefined;
  let animationPositionReady = false;
  let ownsAnimationProgress = false;
  let savingConfig = false;
  let savingAnimationConfig = false;
  let normalAdActive = false;
  const initialNormalElapsed = normalizePlaybackData(data).progress.normalElapsedMs;
  const routeIdentity = (): string => normalizePlaybackUrl(target.location.href) ?? target.location.href;
  let lastUrl = routeIdentity();
  const checkRoute = (): void => {
    if (routeIdentity() === lastUrl) return;
    lastUrl = routeIdentity();
    if (!systemNavigation) {
      pendingPosition = undefined;
      if (session.getState().mode === 'animation' && isUnavailableRedirect(target)) {
        session.mediaFailed('当前视频已失效，B 站返回错误页面');
      } else { session.leave(); ownsAnimationProgress = false; }
    }
  };
  let writeQueue = Promise.resolve();
  const persist = (value: PlaybackData): Promise<void> => {
    const snapshot = structuredClone(value);
    const animation = ownsAnimationProgress || savingAnimationConfig;
    const config = savingConfig;
    const resetNormalAd = normalAdActive && snapshot.progress.pendingAdMode !== 'normal';
    const updateNormalAd = !animation && (normalAdActive || snapshot.progress.pendingAdMode === 'normal');
    normalAdActive = snapshot.progress.pendingAdMode === 'normal';
    if (!animation && !config && !updateNormalAd && snapshot.progress.normalElapsedMs === initialNormalElapsed) return writeQueue;
    const write = async (): Promise<void> => {
      const stored = await storage.get(PLAYBACK_STORAGE_KEY);
      if (stored) {
        const latest = normalizePlaybackData(stored);
        if (!config) snapshot.config = latest.config;
        if (animation) {
          if (!resetNormalAd) snapshot.progress.normalElapsedMs = latest.progress.normalElapsedMs;
        } else {
          const progress = { ...latest.progress, normalElapsedMs: snapshot.progress.normalElapsedMs };
          if (updateNormalAd) {
            progress.adBagIds = snapshot.progress.adBagIds;
            progress.lastAdId = snapshot.progress.lastAdId;
            progress.pendingAdMode = snapshot.progress.pendingAdMode;
          }
          snapshot.progress = progress;
        }
      }
      await storage.set(PLAYBACK_STORAGE_KEY, snapshot);
    };
    // 同源标签页的读改写串行执行，普通观看不能覆盖另一页刚保存的动画断点。
    const next = writeQueue.catch(() => undefined).then(async () => {
      if (target.navigator.locks) await target.navigator.locks.request(PLAYBACK_STORAGE_KEY, write);
      else await write();
    });
    writeQueue = next;
    return next;
  };
  const notify = (state: PlaybackState): void => {
    target.document.documentElement?.toggleAttribute('data-time-machine-animation', state.mode === 'animation');
    for (const listener of listeners) listener(state);
  };
  const session = new PlaybackSession(data, {
    navigate: async (entry, position) => {
      if (destroyed) return;
      animationPositionReady = false;
      const url = normalizePlaybackUrl(entry.url);
      if (!url) return;
      if (normalizePlaybackUrl(target.location.href) === url) {
        pendingPosition = position;
        player.refresh();
        await playAtPosition();
        return;
      }
      if (destroyed || session.getState().mode !== 'animation') return;
      systemNavigation = true;
      const previousName = target.name;
      target.name = NAVIGATION_PREFIX + JSON.stringify({ url, previousName });
      try { target.location.assign(url); } catch (error) {
        target.name = previousName; systemNavigation = false; throw error;
      }
    },
    play: async (position) => {
      if (position !== undefined) pendingPosition = position;
      if (overlay) { await overlay.resume(); return; }
      await playAtPosition();
    },
    pause: () => {
      captureAnimationPosition();
      player.pause();
    },
    showAd: (entry) => {
      overlay = createAdvertisementOverlay({
        window: target, url: entry.url, player,
        onFinish: () => { overlay = undefined; session.finishAd(); },
        onBlocked: () => session.autoplayBlocked(),
        onPlaying: () => session.adPlaying(),
      });
    },
    closeAd: () => { overlay?.destroy(); overlay = undefined; },
    releaseEnded: () => player.releaseEnded(),
    save: persist,
    state: notify,
  }, { now: () => target.performance.now() });
  const player = createPlaybackPlayer({
    window: target,
    managed: () => session.getState().mode === 'animation' && !systemNavigation,
    shouldHoldEnded: () => {
      if (destroyed) return false;
      if (systemNavigation) return true;
      if (routeIdentity() !== lastUrl) { checkRoute(); return false; }
      checkRoute();
      if (session.getState().mode === 'animation' && !animationPositionReady) return true;
      if (session.getState().mode === 'animation') animationPositionReady = false;
      return session.mediaEnded();
    },
    onEvent: (event) => {
      if (destroyed || systemNavigation) return;
      checkRoute();
      if (event.type === 'positioning') animationPositionReady = false;
      else if (event.type === 'positioned') animationPositionReady = session.getState().mode === 'animation';
      else if (event.type === 'playing') {
        if (session.getState().mode !== 'animation' || animationPositionReady) session.mediaPlaying();
      }
      else if (event.type === 'pause') session.mediaPaused();
      else if (event.type === 'waiting' || event.type === 'seeking') session.mediaWaiting();
      else if (event.type === 'unavailable') session.mediaFailed(event.reason ?? '当前片源无法完整播放');
      else if (event.type === 'blocked') session.autoplayBlocked();
      else if (event.type === 'media' && session.getState().mode === 'animation'
        && session.getState().status === 'loading') void playAtPosition();
      else if (event.type === 'media' && session.getState().mode === 'normal') {
        const media = player.media();
        if (media && !media.paused && !media.ended && media.readyState >= 3) session.mediaPlaying();
      }
    },
  });
  function captureAnimationPosition(): void {
    const media = player.media();
    // 续播定位完成前，页面上的媒体仍可能属于上一条普通视频。
    if (animationPositionReady && !systemNavigation && media && session.getState().mode === 'animation') {
      session.mediaPosition(media.currentTime);
    }
  }
  async function playAtPosition(): Promise<void> {
    const media = player.media();
    if (!media || destroyed || systemNavigation) return;
    if (pendingPosition !== undefined) {
      player.seek(pendingPosition);
      pendingPosition = undefined;
    }
    try { await player.play(); } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') session.autoplayBlocked();
    }
  }
  let checkpoint = 0;
  const timer = target.setInterval(() => {
    if (routeIdentity() !== lastUrl) {
      checkRoute();
      player.refresh();
    }
    if (session.getState().status !== 'loading') captureAnimationPosition();
    const media = player.media();
    if (session.getState().status === 'waiting' && media?.paused && media.readyState >= 3) session.mediaPaused();
    session.tick();
    if (++checkpoint % 5 === 0) session.checkpoint();
    if (pendingPosition !== undefined && session.getState().mode === 'animation'
      && session.getState().status === 'loading') void playAtPosition();
  }, 1_000);
  const pagehide = (): void => {
    captureAnimationPosition();
    if (!systemNavigation) session.leave();
    overlay?.destroy();
    void persist(session.getData()).catch(() => undefined);
  };
  target.addEventListener('pagehide', pagehide);
  const command = async (action: PlaybackPanelCommand): Promise<void> => {
    if (action.type === 'save-config') {
      savingConfig = true;
      const previous = session.getState().config;
      savingAnimationConfig = previous.order !== action.config.order
        || JSON.stringify(previous.works) !== JSON.stringify(action.config.works);
      try { session.configure(action.config); } finally { savingConfig = false; savingAnimationConfig = false; }
    }
    else if (action.type === 'start') { animationPositionReady = false; pendingPosition = undefined; ownsAnimationProgress = true; await session.start(); }
    else if (action.type === 'resume') { animationPositionReady = false; pendingPosition = undefined; ownsAnimationProgress = true; await session.resume(); }
    else if (action.type === 'pause') session.pause();
    else if (action.type === 'exit') { session.exit(); ownsAnimationProgress = false; }
    else if (action.type === 'continue') {
      if (overlay) await overlay.resume();
      else { captureAnimationPosition(); session.continuePlayback(); }
    } else if (action.type === 'skip-ad') session.finishAd();
    await writeQueue;
  };
  if (consumePlaybackNavigation(target)) {
    ownsAnimationProgress = true;
    void session.resumeNavigation(isUnavailableRedirect(target) ? '当前视频已失效，B 站返回错误页面' : undefined);
  }
  notify(session.getState());
  return {
    getState: () => session.getState(), command,
    subscribe(listener) { listeners.add(listener); listener(session.getState()); return () => listeners.delete(listener); },
    destroy() {
      if (destroyed) return;
      pagehide(); destroyed = true;
      target.clearInterval(timer);
      target.removeEventListener('pagehide', pagehide);
      player.destroy(); listeners.clear();
      target.document.documentElement?.removeAttribute('data-time-machine-animation');
    },
  };
}

export function defaultPlaybackState(): PlaybackState {
  return new PlaybackSession(createDefaultPlaybackData(), {
    async navigate() {}, play() {}, pause() {}, showAd() {}, closeAd() {}, releaseEnded() {}, save() {}, state() {},
  }).getState();
}
