import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGMStorage, createChromeStorage, CONFIG_STORAGE_KEY, type ConfigStorage } from '../../src/runtime/config-store';
import { createDefaultPlaybackData, normalizePlaybackUrl, playbackQueue, type PlaybackData } from '../../src/playback/model';
import { createPlaybackRuntime, consumePlaybackNavigation, PLAYBACK_STORAGE_KEY } from '../../src/playback/runtime';
import { createPlaybackPlayer } from '../../src/playback/player';
import { createAdvertisementOverlay } from '../../src/playback/overlay';

vi.mock('../../src/playback/player', () => ({ createPlaybackPlayer: vi.fn() }));
vi.mock('../../src/playback/overlay', () => ({ createAdvertisementOverlay: vi.fn() }));

function page(url: string, name = '', navigation = 'navigate') {
  const events = new EventTarget();
  const document = window.document.implementation.createHTMLDocument();
  let location = new URL(url);
  const assign = vi.fn((next: string) => { location = new URL(next); });
  const target = {
    document, name, navigator: {}, performance: { now: () => Date.now(), getEntriesByType: () => [{ type: navigation }] },
    get location() { return { href: location.href, hostname: location.hostname, pathname: location.pathname, origin: location.origin, assign }; },
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as unknown as Window;
  return { target, assign, move: (url: string) => { location = new URL(url); } };
}

function storageFor(kind: 'GM' | 'Chrome') {
  const values = new Map<string, unknown>([[CONFIG_STORAGE_KEY, { enabled: true, cutoffMinute: '2000-01-01T00:00' }]]);
  const storage: ConfigStorage = kind === 'GM'
    ? createGMStorage({ getValue: key => values.get(key), setValue: (key, value) => { values.set(key, structuredClone(value)); }, deleteValue: key => { values.delete(key); } })
    : createChromeStorage({
      async get(keys) { return Object.fromEntries((keys as string[]).map(key => [key, values.get(key)])); },
      async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    });
  return { storage, values };
}

function mount(data = createDefaultPlaybackData(), storage = storageFor('GM').storage, name = '', initialUrl?: string) {
  const env = page(initialUrl ?? playbackQueue(data.config)[data.progress.cursor].url, name);
  let media = env.target.document.createElement('video');
  Object.defineProperty(media, 'readyState', { value: 4, configurable: true });
  let options: Parameters<typeof createPlaybackPlayer>[0];
  let isPlaying = false;
  let requestedPosition: number | undefined;
  vi.mocked(createPlaybackPlayer).mockImplementation(value => {
    options = value;
    return {
      media: () => media, seek: value => {
        requestedPosition = value;
        options.onEvent({ type: 'positioning' });
      },
      play: async () => {
        if (media.readyState < 3) return;
        if (requestedPosition !== undefined) {
          media.currentTime = requestedPosition; requestedPosition = undefined;
          options.onEvent({ type: 'positioned' });
        }
        isPlaying = true; options.onEvent({ type: 'playing' });
      },
      pause: () => { isPlaying = false; options.onEvent({ type: 'pause' }); },
      refresh() {}, releaseEnded() {}, destroy() {},
    };
  });
  vi.mocked(createAdvertisementOverlay).mockImplementation(value => {
    const overlay = env.target.document.createElement('div'); overlay.id = 'test-ad'; env.target.document.body.append(overlay);
    return { destroy: () => overlay.remove(), resume: async () => {} } as ReturnType<typeof createAdvertisementOverlay>;
  });
  const runtime = createPlaybackRuntime(env.target, data, storage);
  return { ...env, runtime, media: () => media, playing: () => isPlaying,
    end: () => options.shouldHoldEnded(),
    event: (event: Parameters<typeof options.onEvent>[0]) => options.onEvent(event),
    replaceMedia: () => { media = env.target.document.createElement('video'); Object.defineProperty(media, 'readyState', { value: 4 }); options.onEvent({ type: 'media' }); return media; },
  };
}

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('playback runtime', () => {
  it('keeps a resume paused while the target media finishes loading, until the user continues', async () => {
    const data = createDefaultPlaybackData(); data.progress.position = 80;
    const { storage } = storageFor('Chrome');
    const env = mount(data, storage); env.media().currentTime = 345;
    Object.defineProperty(env.media(), 'readyState', { value: 0, configurable: true });
    await env.runtime.command({ type: 'resume' });
    await env.runtime.command({ type: 'pause' });
    Object.defineProperty(env.media(), 'readyState', { value: 4, configurable: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.playing()).toBe(false);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 80 } });
    await env.runtime.command({ type: 'continue' });
    expect(env.playing()).toBe(true); expect(env.media().currentTime).toBe(80);
    env.runtime.destroy();
  });
  it('clears a normal advertisement and its elapsed time before resuming animation on the same page', async () => {
    const { storage } = storageFor('Chrome');
    const data = createDefaultPlaybackData();
    data.config.normalAds = true; data.config.intervalMinutes = 1 / 60;
    data.progress.position = 80;
    await storage.set(PLAYBACK_STORAGE_KEY, data);
    const env = mount(data, storage);
    env.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000);
    env.media().currentTime = 345; env.end(); await flush();
    expect(env.target.document.getElementById('test-ad')).not.toBeNull();
    await env.runtime.command({ type: 'resume' });
    expect(env.target.document.getElementById('test-ad')).toBeNull();
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', status: 'playing', ad: null });
    expect(env.media().currentTime).toBe(80); expect(env.playing()).toBe(true);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 80, normalElapsedMs: 0 } });
    await env.runtime.command({ type: 'exit' });
    expect(env.runtime.getState().elapsedMs).toBe(0);
    env.runtime.destroy();
  });

  it.each(['pause', 'exit', 'pagehide', 'same-page-pause'] as const)('preserves the saved animation position when %s cancels a resume awaiting storage', async action => {
    const base = storageFor('Chrome').storage;
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 80;
    await base.set(PLAYBACK_STORAGE_KEY, data);
    let release: (() => void) | undefined;
    let delay = true;
    const storage: ConfigStorage = { ...base, async get(key) {
      if (delay) { delay = false; await new Promise<void>(resolve => { release = resolve; }); }
      return base.get(key);
    } };
    const env = mount(data, storage, '', action === 'same-page-pause' ? undefined : data.config.works[0].entries[0].url);
    env.media().currentTime = 345;
    const resuming = env.runtime.command({ type: 'resume' }); await flush();
    expect(env.runtime.getState().status).toBe('loading');
    let cancelling: void | Promise<void>;
    if (action === 'pagehide') env.target.dispatchEvent(new Event('pagehide'));
    else cancelling = env.runtime.command({ type: action === 'same-page-pause' ? 'pause' : action });
    release!(); await resuming; await cancelling!; await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.assign).not.toHaveBeenCalled();
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 80 } });
    env.runtime.destroy(); await flush();
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 80 } });
  });
  it('reports an unavailable playlist after Bilibili redirects a system navigation to its error homepage', async () => {
    const data = createDefaultPlaybackData();
    data.config.works = [{ id: 'invalid', title: '失效条目', entries: [{ id: 'invalid', title: '失效', url: 'https://www.bilibili.com/video/BV1xx411c7mF/' }] }];
    const url = 'https://www.bilibili.com/?spm_id_from=333.788.selfDef.errorpage';
    const name = 'bilibili-time-machine:navigate:' + JSON.stringify({ url: data.config.works[0].entries[0].url, previousName: '' });
    const { storage } = storageFor('Chrome');
    const env = mount(data, storage, name, url);
    await flush();
    expect(env.runtime.getState()).toMatchObject({ mode: 'normal', status: 'stopped', message: '整份片单均无法播放，请检查片源' });
    expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy(); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    const redirected = mount(saved, storage, '', url);
    expect(redirected.runtime.getState().message).toBe('整份片单均无法播放，请检查片源');
    expect(redirected.runtime.getState().status).toBe('stopped');
    redirected.runtime.destroy();
    const ordinary = mount(data, undefined, '', url);
    expect(ordinary.runtime.getState().status).toBe('idle');
    ordinary.runtime.destroy();
  });
  it('persists the reset position and resumes the new first entry after deleting the exited current entry', async () => {
    const { storage } = storageFor('GM');
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 55;
    const removedId = playbackQueue(data.config)[1].id;
    const env = mount(data, storage);
    await env.runtime.command({ type: 'resume' }); env.media().currentTime = 88.5;
    await env.runtime.command({ type: 'exit' });
    const config = structuredClone(data.config);
    config.works = config.works.map(work => ({ ...work, entries: work.entries.filter(entry => entry.id !== removedId) }))
      .filter(work => work.entries.length > 0);
    await env.runtime.command({ type: 'save-config', config });
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.progress).toMatchObject({ cursor: 0, position: 0 });
    expect(playbackQueue(saved.config).some(entry => entry.id === removedId)).toBe(false);
    await env.runtime.command({ type: 'resume' });
    expect(env.runtime.getState().current?.id).toBe(playbackQueue(config)[0].id);
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(playbackQueue(config)[0].url));
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 0, position: 0 } });
    env.runtime.destroy();
  });

  it.each(['GM', 'Chrome'] as const)('persists progress through %s without changing cutoff configuration or auto-starting a new tab', async kind => {
    const { storage, values } = storageFor(kind);
    const env = mount(undefined, storage);
    expect(env.runtime.getState().mode).toBe('normal');
    await env.runtime.command({ type: 'start' });
    env.media().currentTime = 73;
    await vi.advanceTimersByTimeAsync(2000);
    await env.runtime.command({ type: 'exit' }); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.progress.position).toBe(73);
    expect(saved.progress.animationElapsedMs).toBeGreaterThanOrEqual(2000);
    expect(values.get(CONFIG_STORAGE_KEY)).toEqual({ enabled: true, cutoffMinute: '2000-01-01T00:00' });
    env.runtime.destroy(); await flush();
    const reopened = mount(saved, storage);
    expect(reopened.runtime.getState().mode).toBe('normal'); expect(reopened.playing()).toBe(false);
    await reopened.runtime.command({ type: 'resume' });
    expect(reopened.media().currentTime).toBe(73); expect(reopened.runtime.getState().mode).toBe('animation');
    reopened.runtime.destroy();
  });

  it('restores the exact animation position after an advertisement and clears it on active navigation', async () => {
    const data = createDefaultPlaybackData(); data.config.intervalMinutes = 1 / 60;
    const env = mount(data);
    await env.runtime.command({ type: 'start' }); env.media().currentTime = 41;
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.runtime.getState().status).toBe('ad'); expect(env.playing()).toBe(false);
    expect(env.target.document.getElementById('test-ad')).not.toBeNull();
    await env.runtime.command({ type: 'skip-ad' });
    expect(env.target.document.getElementById('test-ad')).toBeNull();
    expect(env.media().currentTime).toBe(41); expect(env.playing()).toBe(true);
    expect(env.runtime.getState().elapsedMs).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.runtime.getState().status).toBe('ad');
    env.move('https://www.bilibili.com/'); await vi.advanceTimersByTimeAsync(1000);
    expect(env.runtime.getState().mode).toBe('normal');
    expect(env.target.document.getElementById('test-ad')).toBeNull(); expect(env.assign).not.toHaveBeenCalled();
    expect(env.playing()).toBe(false);
    env.runtime.destroy();
  });

  it('does not restart a replacement video while the user has paused animation', async () => {
    const env = mount(); await env.runtime.command({ type: 'start' }); await env.runtime.command({ type: 'pause' });
    env.replaceMedia(); await flush();
    expect(env.runtime.getState().status).toBe('paused'); expect(env.playing()).toBe(false);
    env.runtime.destroy();
  });

  it('saves the next entry before assigning a one-use navigation ticket and resumes only that window', async () => {
    const { storage } = storageFor('GM'); const env = mount(undefined, storage);
    await env.runtime.command({ type: 'start' });
    expect(env.end()).toBe(true); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.progress.cursor).toBe(1); expect(saved.progress.position).toBe(0);
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(playbackQueue(saved.config)[1].url));
    const ticket = env.target.name;
    expect(ticket).toContain('bilibili-time-machine:navigate:');
    env.target.dispatchEvent(new Event('pagehide')); env.runtime.destroy(); await flush();
    const nextPage = mount(saved, storage, ticket); await flush();
    expect(nextPage.runtime.getState().mode).toBe('animation'); expect(nextPage.playing()).toBe(true);
    expect(nextPage.target.name).toBe('');
    nextPage.runtime.destroy(); await flush();
    const refreshedPage = mount(saved, storage); expect(refreshedPage.runtime.getState().mode).toBe('normal');
    refreshedPage.runtime.destroy();
  });

  it('consumes same-window navigation once and rejects refresh, unrelated destinations and new tabs', () => {
    const url = normalizePlaybackUrl(createDefaultPlaybackData().config.works[0].entries[0].url)!;
    const ticket = 'bilibili-time-machine:navigate:' + JSON.stringify({ url, previousName: 'original-name' });
    const env = page(url, ticket);
    expect(consumePlaybackNavigation(env.target)).toBe(true); expect(env.target.name).toBe('original-name');
    expect(consumePlaybackNavigation(env.target)).toBe(false);
    expect(consumePlaybackNavigation(page(url, ticket, 'reload').target)).toBe(false);
    expect(consumePlaybackNavigation(page(url, ticket, 'back_forward').target)).toBe(false);
    expect(consumePlaybackNavigation(page('https://www.bilibili.com/', ticket).target)).toBe(false);
    expect(consumePlaybackNavigation(page(url).target)).toBe(false);
    expect(consumePlaybackNavigation(page(`${url}?p=1&spm_id_from=333.1007`, ticket).target)).toBe(true);
  });

  it.each(['GM', 'Chrome'] as const)('keeps newer animation progress and configuration when an idle %s tab checkpoints', async kind => {
    const { storage } = storageFor(kind);
    const idle = mount(undefined, storage);
    const newer = createDefaultPlaybackData(); newer.progress.cursor = 1; newer.progress.position = 91.25;
    newer.progress.animationElapsedMs = 45000; newer.config.intervalMinutes = 35;
    await storage.set(PLAYBACK_STORAGE_KEY, newer);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({
      config: { intervalMinutes: 35 }, progress: { cursor: 1, position: 91.25, animationElapsedMs: 45000 },
    });
    idle.runtime.destroy(); await flush();
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 91.25 } });
  });

  it('does not let an idle tab overwrite the animation checkpoint when both timers fire together', async () => {
    const { storage } = storageFor('GM');
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 20;
    const animation = mount(data, storage); await animation.runtime.command({ type: 'resume' });
    const idle = mount(undefined, storage);
    animation.media().currentTime = 92;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 92 } });
    animation.runtime.destroy(); idle.runtime.destroy();
  });

  it('preserves animation progress when cross-tab storage reads overlap asynchronously', async () => {
    const base = storageFor('Chrome').storage;
    let delay = false;
    const pending: (() => void)[] = [];
    const storage: ConfigStorage = { ...base, async get(key) {
      const snapshot = await base.get(key);
      if (!delay) return snapshot;
      return new Promise(resolve => pending.push(() => resolve(snapshot)));
    } };
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 20;
    const animation = mount(data, storage); await animation.runtime.command({ type: 'resume' });
    const idle = mount(undefined, storage); animation.media().currentTime = 92;
    delay = true; await vi.advanceTimersByTimeAsync(5000);
    delay = false; pending.splice(0).forEach(resolve => resolve()); await flush();
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 92 } });
    animation.runtime.destroy(); idle.runtime.destroy();
  });

  it.each(['exit', 'pagehide'])('captures the last fractional media position immediately on %s', async action => {
    const { storage } = storageFor('GM'); const env = mount(undefined, storage);
    await env.runtime.command({ type: 'start' }); env.media().currentTime = 41.75;
    if (action === 'exit') await env.runtime.command({ type: 'exit' });
    else env.target.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 41.75 } });
    env.runtime.destroy();
  });

  it('ignores Bilibili tracking query changes without ending the animation session', async () => {
    const env = mount(); await env.runtime.command({ type: 'start' });
    const url = new URL(env.target.location.href); url.searchParams.set('spm_id_from', '333.1007'); env.move(url.href);
    env.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000);
    expect(env.runtime.getState().mode).toBe('animation'); expect(env.playing()).toBe(true);
    env.runtime.destroy();
  });

  it('keeps the normal advertisement rotation across pages without losing animation progress', async () => {
    const { storage } = storageFor('Chrome'); const data = createDefaultPlaybackData();
    data.config.normalAds = true; data.config.intervalMinutes = 1 / 60;
    data.config.ads = [data.config.ads[0], { ...data.config.ads[0], id: 'second-ad', title: '另一条公益广告' }];
    data.progress.cursor = 1; data.progress.position = 55;
    await storage.set(PLAYBACK_STORAGE_KEY, data);
    const first = mount(data, storage);
    first.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000); first.end(); await flush();
    const firstAd = first.runtime.getState().ad!.id;
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 55, lastAdId: firstAd, pendingAdMode: 'normal' } });
    await first.runtime.command({ type: 'skip-ad' }); first.runtime.destroy(); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.progress.pendingAdMode).toBeUndefined(); expect(saved.progress.normalElapsedMs).toBe(0);
    expect(saved.progress.adBagIds).toHaveLength(1);
    const second = mount(saved, storage);
    second.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000); second.end(); await flush();
    expect(second.runtime.getState().ad?.id).not.toBe(firstAd);
    expect(second.runtime.getState().status).toBe('ad');
    second.runtime.destroy();
  });

  it('serializes playing tabs with the browser lock while keeping both modes progress', async () => {
    const base = storageFor('Chrome').storage;
    let delay = false; const pending: (() => void)[] = [];
    const storage: ConfigStorage = { ...base, async get(key) {
      const snapshot = await base.get(key);
      if (!delay) return snapshot;
      return new Promise(resolve => pending.push(() => resolve(snapshot)));
    } };
    let queue = Promise.resolve();
    const locks = { request(_name: string, write: () => Promise<void>) { const next = queue.then(write); queue = next.catch(() => {}); return next; } };
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 20;
    const animation = mount(data, storage);
    Object.defineProperty(animation.target, 'navigator', { value: { locks } });
    await animation.runtime.command({ type: 'resume' });
    const normal = mount(undefined, storage);
    Object.defineProperty(normal.target, 'navigator', { value: { locks } });
    normal.event({ type: 'playing' }); animation.media().currentTime = 92;
    delay = true; await vi.advanceTimersByTimeAsync(5000);
    delay = false; pending.splice(0).forEach(resolve => resolve()); await flush();
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 1, position: 92, normalElapsedMs: 5000 } });
    animation.runtime.destroy(); normal.runtime.destroy();
  });
});
