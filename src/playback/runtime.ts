import type { ConfigStorage } from '../runtime/config-store';
import { createDefaultPlaybackData, normalizePlaybackData, normalizePlaybackUrl, playbackQueue, type AnimationWork, type PlaybackData } from './model';
import { resolveCatalogWork, sameCatalogWork } from './catalog-resolver';
import type { ResolvedPlaybackSource } from './source';
import { PlaybackSession, type PlaybackState } from './session';
import { createPlaybackPlayer } from './player';
import { createAdvertisementOverlay } from './overlay';
import type { PlaybackPanelClient, PlaybackPanelCommand } from '../ui/playback-panel';

export const PLAYBACK_STORAGE_KEY = 'bilibili-time-machine.playback.v1';
const NAVIGATION_PREFIX = 'bilibili-time-machine:navigate:';

type PlaybackNavigateEvent = Event & {
  destination: { url: string; sameDocument: boolean };
  navigationType: string;
  signal: AbortSignal;
};

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

/**
 * 系统／手动切集许可只保存在当前窗口，避免共享存储或 opener 复制导致跨标签自动接管。
 * 许可只消费一次；刷新和历史返回不自动恢复连播。
 */
export function consumePlaybackNavigation(target: Window): { kind: 'system' | 'manual'; url: string } | false {
  if (!target.name.startsWith(NAVIGATION_PREFIX)) return false;
  const raw = target.name.slice(NAVIGATION_PREFIX.length);
  target.name = '';
  try {
    const ticket = JSON.parse(raw) as { url: string; previousName: string; manual?: boolean };
    target.name = typeof ticket.previousName === 'string' ? ticket.previousName : '';
    const navigation = target.performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    const allowed = navigation?.type !== 'reload' && navigation?.type !== 'back_forward'
      && (normalizePlaybackUrl(target.location.href) === ticket.url
        || (normalizePlaybackUrl(ticket.url) !== null && isUnavailableRedirect(target)));
    return allowed ? { kind: ticket.manual ? 'manual' : 'system', url: ticket.url } : false;
  } catch {
    return false;
  }
}

export interface PlaybackRuntime extends PlaybackPanelClient {
  destroy(): void;
}

export function createPlaybackRuntime(target: Window, data: PlaybackData, storage: ConfigStorage,
  resolveSource?: (url: string) => Promise<ResolvedPlaybackSource>): PlaybackRuntime {
  const listeners = new Set<(state: PlaybackState) => void>();
  let overlay: ReturnType<typeof createAdvertisementOverlay> | undefined;
  let destroyed = false;
  let systemNavigation = false;
  let pendingPosition: number | undefined;
  let animationPositionReady = false;
  let animationMedia: HTMLVideoElement | null = null;
  let animationSource = '';
  let followingPage: { media: HTMLVideoElement | null; source: string; loaded: boolean } | undefined;
  let ownsAnimationProgress = false;
  let savingConfig = false;
  let savingAnimationConfig = false;
  let normalAdActive = false;
  let applyingCatalog = false;
  let catalogGeneration = 0;
  let catalogResolving = false;
  let catalogMessage = '';
  let catalogWrite: Promise<void> | undefined;
  const initialNormalElapsed = normalizePlaybackData(data).progress.normalElapsedMs;
  const routeIdentity = (): string => normalizePlaybackUrl(target.location.href) ?? target.location.href;
  let lastUrl = routeIdentity();
  const checkRoute = (): void => {
    if (routeIdentity() === lastUrl) return;
    cancelCatalog();
    lastUrl = routeIdentity();
    if (!systemNavigation) {
      pendingPosition = undefined;
      animationPositionReady = false;
      followingPage = undefined;
      if (session.getState().mode === 'animation' && isUnavailableRedirect(target)) {
        session.mediaFailed('当前视频已失效，B 站返回错误页面');
      } else if (session.getState().mode === 'animation') {
        followingPage = { media: animationMedia, source: animationSource, loaded: false };
        if (!session.followPage(lastUrl)) {
          followingPage = undefined; session.leave(); ownsAnimationProgress = false;
        }
      } else { session.leave(); ownsAnimationProgress = false; }
    }
  };
  let writeQueue = Promise.resolve();
  const enqueueWrite = (write: () => Promise<void>): Promise<void> => {
    const next = writeQueue.catch(() => undefined).then(async () => {
      if (target.navigator.locks) await target.navigator.locks.request(PLAYBACK_STORAGE_KEY, write);
      else await write();
    });
    writeQueue = next;
    return next;
  };
  const persist = (value: PlaybackData): Promise<void> => {
    if (applyingCatalog) return Promise.resolve();
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
            progress.adResume = snapshot.progress.adResume;
          }
          snapshot.progress = progress;
        }
      }
      if (config) snapshot.progress.adResume = normalizePlaybackData(snapshot).progress.adResume;
      await storage.set(PLAYBACK_STORAGE_KEY, snapshot);
    };
    // 同源标签页的读改写串行执行，普通观看不能覆盖另一页刚保存的动画断点。
    return enqueueWrite(write);
  };
  const withCatalogState = (state: PlaybackState): PlaybackState => ({ ...state, catalogResolving, catalogMessage });
  const notify = (state: PlaybackState): void => {
    if (catalogResolving && (state.mode !== 'normal' || state.ad)) {
      catalogGeneration++; catalogResolving = false;
      catalogMessage = '已停止自动补全，保留现有片单。';
    }
    target.document.documentElement?.toggleAttribute('data-time-machine-animation', state.mode === 'animation');
    for (const listener of listeners) listener(withCatalogState(state));
  };
  const session = new PlaybackSession(data, {
    navigate: async (entry, position) => {
      if (destroyed) return;
      if (routeIdentity() !== lastUrl && !systemNavigation) { checkRoute(); return; }
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
    showAd: (entry, position) => {
      overlay = createAdvertisementOverlay({
        window: target, url: entry.url, player, position,
        onProgress: position => session.adPosition(position),
        onFinish: reason => { overlay = undefined; session.finishAd(reason); },
        onBlocked: () => session.autoplayBlocked(),
        onPlaying: () => session.adPlaying(),
      });
    },
    closeAd: () => { overlay?.destroy(); overlay = undefined; },
    releaseEnded: () => player.releaseEnded(),
    save: persist,
    state: notify,
  }, { now: () => target.performance.now() });
  function cancelCatalog(): void {
    if (!catalogResolving) return;
    catalogGeneration++; catalogResolving = false;
    catalogMessage = '已取消自动补全，现有片单可继续使用。';
    notify(session.getState());
  }
  async function resolveCatalog(): Promise<void> {
    const state = session.getState();
    if (!resolveSource || catalogResolving || state.mode !== 'normal' || state.ad || destroyed) return;
    const seeds = state.config.works.filter(work => work.sourceStatus === 'pending');
    if (!seeds.length) return;
    const generation = ++catalogGeneration;
    const current = (): boolean => generation === catalogGeneration && !destroyed;
    catalogResolving = true;
    catalogMessage = `正在补全内置片单（0/${seeds.length}）…`;
    notify(session.getState());
    let cursor = 0;
    let completed = 0;
    const patches = new Map<string, AnimationWork>();
    const worker = async (): Promise<void> => {
      while (current() && cursor < seeds.length) {
        const seed = seeds[cursor++];
        const work = await resolveCatalogWork(seed, resolveSource);
        if (!current()) return;
        patches.set(seed.id, work);
        catalogMessage = `正在补全内置片单（${++completed}/${seeds.length}）…`;
        notify(session.getState());
      }
    };
    try {
      await Promise.all([worker(), worker()]);
      if (!current()) return;
      const write = enqueueWrite(async () => {
        const stored = await storage.get(PLAYBACK_STORAGE_KEY);
        if (!current()) return;
        const latest = stored ? normalizePlaybackData(stored) : session.getData();
        const oldEntry = playbackQueue(latest.config)[latest.progress.cursor];
        let applied = 0;
        latest.config.works = latest.config.works.map(work => {
          const seed = seeds.find(seed => seed.id === work.id);
          const patch = patches.get(work.id);
          if (!seed || !patch || !sameCatalogWork(seed, work)) return work;
          applied++;
          return patch;
        });
        if (!applied) return;
        const nextIndex = playbackQueue(latest.config).findIndex(entry => entry.id === oldEntry?.id);
        latest.progress.cursor = Math.max(0, nextIndex);
        await storage.set(PLAYBACK_STORAGE_KEY, latest);
        // 写入期间的用户命令先等待本次提交；界面草稿仍由面板自己保留。
        if (!destroyed && session.getState().mode === 'normal' && !session.getState().ad) {
          applyingCatalog = true;
          try { session.configure(latest.config, latest.progress); } finally { applyingCatalog = false; }
        }
      });
      catalogWrite = write;
      try { await write; } finally { if (catalogWrite === write) catalogWrite = undefined; }
      if (!current()) return;
      const failed = [...patches.values()].filter(work => work.sourceStatus === 'failed').length;
      catalogMessage = failed ? `片单补全完成，${failed} 部解析失败，已保留原有条目。` : '内置片单已自动补全并保存。';
    } catch {
      if (current()) catalogMessage = '自动补全保存失败，现有片单保持不变，请重新打开频道重试。';
    } finally {
      if (current()) { catalogResolving = false; notify(session.getState()); }
    }
  }
  const player = createPlaybackPlayer({
    window: target,
    managed: () => session.getState().mode === 'animation' && !systemNavigation,
    shouldHoldEnded: () => {
      if (destroyed) return false;
      if (systemNavigation) return true;
      if (routeIdentity() !== lastUrl) { checkRoute(); return session.getState().mode === 'animation'; }
      checkRoute();
      if (session.getState().mode === 'animation' && !animationPositionReady) return true;
      if (session.getState().mode === 'animation') animationPositionReady = false;
      return session.mediaEnded();
    },
    onEvent: (event) => {
      if (destroyed || systemNavigation) return;
      checkRoute();
      if (followingPage && event.type !== 'unavailable') {
        if (event.type === 'loadstart' || event.type === 'loadedmetadata') followingPage.loaded = true;
        followReadyMedia();
        return;
      }
      if (event.type === 'positioning') animationPositionReady = false;
      else if (event.type === 'positioned') {
        animationPositionReady = session.getState().mode === 'animation';
        rememberAnimationMedia();
      }
      else if (event.type === 'playing') {
        if (session.getState().mode !== 'animation' || animationPositionReady) session.mediaPlaying();
      }
      else if (event.type === 'pause') session.mediaPaused();
      else if (event.type === 'waiting' || event.type === 'seeking') session.mediaWaiting();
      else if (event.type === 'unavailable') {
        followingPage = undefined;
        session.mediaFailed(event.reason ?? '当前片源无法完整播放');
      }
      else if (event.type === 'blocked') session.autoplayBlocked();
      else if (event.type === 'media' && session.getState().mode === 'animation'
        && session.getState().status === 'loading') void playAtPosition();
      else if (event.type === 'media' && session.getState().mode === 'normal') {
        const media = player.media();
        if (media && !media.paused && !media.ended && media.readyState >= 3) session.mediaPlaying();
      }
    },
  });
  function rememberAnimationMedia(): void {
    animationMedia = player.media();
    animationSource = animationMedia?.currentSrc ?? '';
  }
  function followReadyMedia(): void {
    const pending = followingPage;
    const media = player.media();
    if (!pending || !media || media.readyState < 3 || media.seeking || media.ended) return;
    // B 站先改地址再换媒体；旧集的尾段和 playing 不能成为新集断点。
    if (!pending.loaded && media === pending.media && media.currentSrc === pending.source) return;
    rememberAnimationMedia();
    followingPage = undefined;
    void session.resume({ url: target.location.href, position: media.currentTime });
  }
  function captureAnimationPosition(): void {
    const media = player.media();
    // 定位或手动切集接入完成前，媒体可能仍属于切换前的视频，不能写入新条目的断点。
    if (animationPositionReady && !systemNavigation && media && session.getState().mode === 'animation') {
      rememberAnimationMedia();
      session.mediaPosition(media.currentTime);
    }
  }
  async function playAtPosition(): Promise<void> {
    const media = player.media();
    if (!media || destroyed || systemNavigation || followingPage) return;
    if (session.getState().mode === 'animation') rememberAnimationMedia();
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
    followReadyMedia();
    if (session.getState().status !== 'loading') captureAnimationPosition();
    const media = player.media();
    if (session.getState().status === 'waiting' && media?.paused && media.readyState >= 3) session.mediaPaused();
    session.tick();
    if (++checkpoint % 5 === 0) session.checkpoint();
    if (pendingPosition !== undefined && session.getState().mode === 'animation'
      && session.getState().status === 'loading') void playAtPosition();
  }, 1_000);
  const pagehide = (): void => {
    cancelCatalog();
    captureAnimationPosition();
    followingPage = undefined;
    if (!systemNavigation) session.leave();
    overlay?.destroy();
    void persist(session.getData()).catch(() => undefined);
  };
  target.addEventListener('pagehide', pagehide);
  const navigation = (target as Window & { navigation?: EventTarget }).navigation;
  let manualTicket: { name: string; previousName: string } | undefined;
  const clearManualTicket = (): void => {
    if (manualTicket && target.name === manualTicket.name) target.name = manualTicket.previousName;
    manualTicket = undefined;
  };
  const onNavigate = (event: Event): void => {
    clearManualTicket();
    const intent = event as PlaybackNavigateEvent;
    if (destroyed || systemNavigation || session.getState().mode !== 'animation'
      || intent.destination.sameDocument || !['push', 'replace'].includes(intent.navigationType)) return;
    const url = normalizePlaybackUrl(intent.destination.url);
    if (!url || url === routeIdentity() || !playbackQueue(session.getState().config).some(entry => entry.url === url)) return;
    // 只给当前窗口这一次原生跳转续播许可，不拦截导航，也不把开关写入共享存储。
    const ticket = { previousName: target.name, name: NAVIGATION_PREFIX + JSON.stringify({ url, previousName: target.name, manual: true }) };
    manualTicket = ticket; target.name = ticket.name;
    intent.signal.addEventListener('abort', () => { if (manualTicket === ticket) clearManualTicket(); }, { once: true });
  };
  const onNavigated = (): void => { clearManualTicket(); checkRoute(); player.refresh(); };
  navigation?.addEventListener('navigate', onNavigate);
  navigation?.addEventListener('navigatesuccess', onNavigated);
  navigation?.addEventListener('navigateerror', clearManualTicket);
  const command = async (action: PlaybackPanelCommand): Promise<void> => {
    if (action.type === 'resolve-catalog') { void resolveCatalog(); return; }
    if (action.type === 'cancel-catalog-resolution') { cancelCatalog(); return; }
    if (['save-config', 'start', 'resume', 'exit'].includes(action.type)) {
      cancelCatalog();
      if (catalogWrite && action.type !== 'exit') await catalogWrite.catch(() => undefined);
    }
    if (action.type === 'save-config') {
      captureAnimationPosition();
      savingConfig = true;
      const previous = session.getState().config;
      savingAnimationConfig = previous.order !== action.config.order
        || JSON.stringify(previous.works) !== JSON.stringify(action.config.works);
      try { session.configure(action.config); } finally { savingConfig = false; savingAnimationConfig = false; }
    }
    else if (action.type === 'start') { followingPage = undefined; clearManualTicket(); animationPositionReady = false; pendingPosition = undefined; ownsAnimationProgress = true; await session.start(); }
    else if (action.type === 'resume') {
      checkRoute();
      let currentPage: { url: string; position?: number } | undefined;
      if (session.getState().mode === 'normal' || followingPage) {
        player.refresh();
        const media = player.media();
        // 尚未起播的同一集仍可恢复存档；已经观看或手动拖回开头时使用页面位置。
        const position = media && media.readyState >= 1 && (media.currentTime > 0 || !media.paused || media.played.length > 0)
          ? media.currentTime : undefined;
        currentPage = { url: target.location.href, position };
      }
      followingPage = undefined; clearManualTicket();
      animationPositionReady = false; pendingPosition = undefined; ownsAnimationProgress = true;
      await session.resume(currentPage);
    }
    else if (action.type === 'pause') { followingPage = undefined; clearManualTicket(); session.pause(); }
    else if (action.type === 'exit') { followingPage = undefined; clearManualTicket(); session.exit(); ownsAnimationProgress = false; }
    else if (action.type === 'continue') {
      if (overlay) await overlay.resume();
      else { captureAnimationPosition(); session.continuePlayback(); }
    } else if (action.type === 'skip-ad') session.finishAd('skipped');
    await writeQueue;
  };
  const navigationKind = consumePlaybackNavigation(target);
  if (navigationKind) {
    ownsAnimationProgress = true;
    if (navigationKind.kind === 'manual') {
      player.refresh();
      if (session.followPage(navigationKind.url)) {
        if (isUnavailableRedirect(target)) session.mediaFailed('当前视频已失效，B 站返回错误页面');
        else {
          const media = player.media();
          void session.resume({ url: target.location.href, position: media && media.readyState >= 1 ? media.currentTime : 0 });
        }
      } else ownsAnimationProgress = false;
    } else void session.resumeNavigation(isUnavailableRedirect(target) ? '当前视频已失效，B 站返回错误页面' : undefined);
  }
  notify(session.getState());
  return {
    getState: () => withCatalogState(session.getState()), command,
    resolveSource: url => resolveSource ? resolveSource(url) : Promise.reject(new Error('片源解析尚未就绪')),
    subscribe(listener) { listeners.add(listener); listener(withCatalogState(session.getState())); return () => listeners.delete(listener); },
    destroy() {
      if (destroyed) return;
      pagehide(); destroyed = true;
      target.clearInterval(timer);
      target.removeEventListener('pagehide', pagehide);
      clearManualTicket();
      navigation?.removeEventListener('navigate', onNavigate);
      navigation?.removeEventListener('navigatesuccess', onNavigated);
      navigation?.removeEventListener('navigateerror', clearManualTicket);
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
