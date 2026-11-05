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
  const navigationEvents = new EventTarget();
  const document = window.document.implementation.createHTMLDocument();
  let location = new URL(url);
  const assign = vi.fn((next: string) => { location = new URL(next); });
  const target = {
    document, name, navigator: {}, navigation: navigationEvents, performance: { now: () => Date.now(), getEntriesByType: () => [{ type: navigation }] },
    get location() { return { href: location.href, hostname: location.hostname, pathname: location.pathname, origin: location.origin, assign }; },
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as unknown as Window;
  return { target, assign, navigationEvents, move: (url: string) => { location = new URL(url); },
    navigate: (url: string, sameDocument = false, navigationType = 'push') => {
      const controller = new AbortController();
      navigationEvents.dispatchEvent(Object.assign(new Event('navigate'), {
        destination: { url, sameDocument }, navigationType, signal: controller.signal,
      }));
      return controller;
    },
  };
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

function mount(data = createDefaultPlaybackData(), storage = storageFor('GM').storage, name = '', initialUrl?: string, navigation = 'navigate') {
  const env = page(initialUrl ?? playbackQueue(data.config)[data.progress.cursor].url, name, navigation);
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
  it.each([
    ['GM', 'round-robin'], ['GM', 'sequential'], ['Chrome', 'round-robin'], ['Chrome', 'sequential'],
  ] as const)('%s 连播中手动切集自动接入，%s 后继正确，旧媒体不污染新断点', async (kind, order) => {
    const data = createDefaultPlaybackData(); data.config.order = order; data.config.animationAds = false;
    const { storage } = storageFor(kind); const env = mount(data, storage);
    await env.runtime.command({ type: 'start' }); env.media().currentTime = 800;
    await vi.advanceTimersByTimeAsync(2000);
    const selected = data.config.works[0].entries[2]; const queue = playbackQueue(data.config);
    const index = queue.findIndex(entry => entry.id === selected.id);
    env.move(`${selected.url}&vd_source=test`); env.event({ type: 'playing' });
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', status: 'loading', current: { id: selected.id }, elapsedMs: 2000 });
    expect(env.end()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: index, position: 0, animationElapsedMs: 2000 } });
    expect(env.media().currentTime).toBe(800);
    Object.defineProperty(env.media(), 'currentSrc', { value: 'blob:selected', configurable: true });
    env.media().currentTime = 2.5; env.event({ type: 'playing' }); await flush();
    expect(env.runtime.getState()).toMatchObject({ status: 'playing', current: { id: selected.id }, next: { id: queue[index + 1].id } });
    expect(env.assign).not.toHaveBeenCalled(); expect(env.media().currentTime).toBe(2.5);
    env.end(); await flush();
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(queue[index + 1].url));
    env.runtime.destroy();
  });

  it('同一媒体和地址源被复用时，等待新加载事件后自动接入', async () => {
    const env = mount(); await env.runtime.command({ type: 'start' });
    const selected = env.runtime.getState().config.works[0].entries[2];
    env.media().currentTime = 800; env.move(selected.url);
    Object.defineProperty(env.media(), 'readyState', { value: 0, configurable: true });
    env.event({ type: 'loadstart' }); await flush();
    expect(env.media().currentTime).toBe(800);
    env.media().currentTime = 1; Object.defineProperty(env.media(), 'readyState', { value: 4, configurable: true });
    env.event({ type: 'loadedmetadata' }); await flush();
    expect(env.runtime.getState()).toMatchObject({ status: 'playing', current: { id: selected.id } });
    expect(env.media().currentTime).toBe(1); expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy();
  });

  it.each(['pause', 'exit'] as const)('手动切集等待媒体时 %s 取消接入，迟到的媒体不重新起播', async action => {
    const env = mount(); await env.runtime.command({ type: 'start' });
    env.move(env.runtime.getState().config.works[0].entries[2].url); env.event({ type: 'waiting' });
    await env.runtime.command({ type: action });
    env.replaceMedia(); env.event({ type: 'loadedmetadata' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(env.playing()).toBe(false); expect(env.assign).not.toHaveBeenCalled();
    expect(env.runtime.getState().mode).toBe(action === 'exit' ? 'normal' : 'animation');
    if (action === 'pause') expect(env.runtime.getState().status).toBe('paused');
    env.runtime.destroy();
  });

  it.each(['GM', 'Chrome'] as const)('%s 原生整页选集只给当前窗口一次许可，目标页自动从所选集接入', async kind => {
    const { storage } = storageFor(kind); const env = mount(undefined, storage, 'original-name');
    await env.runtime.command({ type: 'start' }); env.media().currentTime = 88;
    const selected = env.runtime.getState().config.works[0].entries[2];
    env.navigate(selected.url);
    const ticket = env.target.name;
    expect(ticket).toContain('"manual":true'); expect(env.assign).not.toHaveBeenCalled();
    env.target.dispatchEvent(new Event('pagehide')); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    env.runtime.destroy(); await flush();
    const next = mount(saved, storage, ticket, selected.url); await flush();
    expect(next.runtime.getState()).toMatchObject({ mode: 'animation', status: 'playing', current: { id: selected.id } });
    expect(next.target.name).toBe('original-name'); expect(next.media().currentTime).toBe(0);
    expect(next.assign).not.toHaveBeenCalled(); next.runtime.destroy();
    const reloaded = mount(saved, storage, ticket, selected.url, 'reload');
    expect(reloaded.runtime.getState().mode).toBe('normal'); reloaded.runtime.destroy();
    const newTab = mount(saved, storage, '', selected.url);
    expect(newTab.runtime.getState().mode).toBe('normal'); newTab.runtime.destroy();
  });

  it('导航取消、失败或退出时撤销手动续播许可，片单外和刷新不授予许可', async () => {
    const env = mount(undefined, undefined, 'original-name'); await env.runtime.command({ type: 'start' });
    const selected = env.runtime.getState().config.works[0].entries[2];
    env.navigate(selected.url).abort(); expect(env.target.name).toBe('original-name');
    env.navigate(selected.url); env.navigationEvents.dispatchEvent(new Event('navigateerror'));
    expect(env.target.name).toBe('original-name');
    env.navigate('https://www.bilibili.com/'); expect(env.target.name).toBe('original-name');
    env.navigate(selected.url, false, 'reload'); expect(env.target.name).toBe('original-name');
    env.navigate(selected.url); await env.runtime.command({ type: 'exit' });
    expect(env.target.name).toBe('original-name');
    env.navigate(selected.url); env.move(selected.url); env.event({ type: 'playing' });
    expect(env.target.name).toBe('original-name'); expect(env.runtime.getState().mode).toBe('normal');
    env.runtime.destroy();
  });

  it('原生导航被页面改成 SPA 时清理许可，并保持片单接入', async () => {
    const env = mount(undefined, undefined, 'original-name'); await env.runtime.command({ type: 'start' });
    const selected = env.runtime.getState().config.works[0].entries[2];
    env.navigate(selected.url); env.move(selected.url); env.navigationEvents.dispatchEvent(new Event('navigatesuccess'));
    expect(env.target.name).toBe('original-name');
    const media = env.replaceMedia(); media.currentTime = 3; env.event({ type: 'playing' }); await flush();
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', status: 'playing', current: { id: selected.id } });
    expect(env.assign).not.toHaveBeenCalled(); env.runtime.destroy();
  });

  it('连续选集且保存延迟时，旧接入不导航或把中间集位置写入最终选择', async () => {
    const base = storageFor('GM').storage; let release: (() => void) | undefined; let delay = false;
    const storage: ConfigStorage = { ...base, async get(key) {
      if (delay) { delay = false; await new Promise<void>(resolve => { release = resolve; }); }
      return base.get(key);
    } };
    const env = mount(undefined, storage); await env.runtime.command({ type: 'start' });
    const entries = env.runtime.getState().config.works[0].entries;
    delay = true;
    env.move(entries[1].url); env.event({ type: 'waiting' }); await flush();
    Object.defineProperty(env.media(), 'currentSrc', { value: 'blob:second', configurable: true });
    env.media().currentTime = 20; env.event({ type: 'playing' });
    env.move(entries[2].url); env.event({ type: 'playing' });
    release!(); await vi.advanceTimersByTimeAsync(0);
    expect(env.runtime.getState()).toMatchObject({ status: 'loading', current: { id: entries[2].id } });
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 0 } });
    Object.defineProperty(env.media(), 'currentSrc', { value: 'blob:third', configurable: true });
    env.media().currentTime = 3; env.event({ type: 'playing' }); await flush();
    expect(env.runtime.getState()).toMatchObject({ status: 'playing', current: { id: entries[2].id } });
    expect(await base.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 3 } });
    expect(env.assign).not.toHaveBeenCalled(); env.runtime.destroy();
  });

  it('手动整页跳转的目标已从片单移除时不跳回旧存档', async () => {
    const data = createDefaultPlaybackData();
    const url = 'https://www.bilibili.com/video/BV1AA411x7AB/';
    const ticket = 'bilibili-time-machine:navigate:' + JSON.stringify({ url, previousName: '', manual: true });
    const env = mount(data, undefined, ticket, url); await flush();
    expect(env.runtime.getState().mode).toBe('normal'); expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy();
  });

  it('手动整页切入失效视频时记录所选条目失败，而不是误伤原存档', async () => {
    const data = createDefaultPlaybackData(); const selected = data.config.works[0].entries[2];
    const url = normalizePlaybackUrl(selected.url)!;
    const ticket = 'bilibili-time-machine:navigate:' + JSON.stringify({ url, previousName: '', manual: true });
    const { storage } = storageFor('GM');
    const env = mount(data, storage, ticket, 'https://www.bilibili.com/?spm_id_from=333.788.selfDef.errorpage');
    await flush();
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { failedEntryIds: [selected.id] } });
    const queue = playbackQueue(data.config); const index = queue.findIndex(entry => entry.id === selected.id);
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(queue[index + 1].url));
    env.runtime.destroy();
  });

  it('广告期间手动选片单内集数会清除旧广告，加载新媒体后继续所选集', async () => {
    const data = createDefaultPlaybackData(); data.config.intervalMinutes = 1 / 60;
    const env = mount(data); await env.runtime.command({ type: 'start' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.target.document.getElementById('test-ad')).not.toBeNull();
    const selected = data.config.works[0].entries[2];
    env.move(selected.url); env.event({ type: 'waiting' });
    expect(env.target.document.getElementById('test-ad')).toBeNull();
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', current: { id: selected.id }, elapsedMs: 0 });
    env.replaceMedia(); await flush();
    expect(env.playing()).toBe(true); expect(env.assign).not.toHaveBeenCalled(); env.runtime.destroy();
  });

  it.each([
    ['GM', 'round-robin'], ['GM', 'sequential'], ['Chrome', 'round-robin'], ['Chrome', 'sequential'],
  ] as const)('%s 按 %s 从手动打开的分 P 和当前位置接入，再播放队列下一集', async (kind, order) => {
    const data = createDefaultPlaybackData(); data.config.order = order; data.config.animationAds = false;
    data.progress.position = 80; data.progress.animationElapsedMs = 5000;
    const queue = playbackQueue(data.config);
    const selected = data.config.works[0].entries[2];
    const index = queue.findIndex(entry => entry.id === selected.id);
    const { storage } = storageFor(kind);
    const env = mount(data, storage, '', `${selected.url}&vd_source=test`);
    env.media().currentTime = 123.5;
    await env.runtime.command({ type: 'resume' });
    expect(env.assign).not.toHaveBeenCalled();
    expect(env.media().currentTime).toBe(123.5);
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', current: { id: selected.id }, next: { id: queue[index + 1].id }, elapsedMs: 5000 });
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: index, position: 123.5 } });
    env.end(); await flush();
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(queue[index + 1].url));
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: index + 1, position: 0 } });
    env.runtime.destroy();
  });

  it('番剧 ep 链接也从当前集接入，忽略跟踪参数', async () => {
    const data = createDefaultPlaybackData();
    data.config.works = [{ id: 'season', title: '番剧', entries: [123, 124, 125].map(ep => ({ id: `ep${ep}`, title: `${ep}`, url: `https://www.bilibili.com/bangumi/play/ep${ep}` })) }];
    data.progress.position = 80;
    const env = mount(data, undefined, '', 'https://www.bilibili.com/bangumi/play/ep124?spm_id_from=test');
    env.media().currentTime = 24;
    await env.runtime.command({ type: 'resume' });
    expect(env.assign).not.toHaveBeenCalled();
    expect(env.runtime.getState()).toMatchObject({ current: { id: 'ep124' }, next: { id: 'ep125' } });
    expect(env.media().currentTime).toBe(24);
    env.runtime.destroy();
  });

  it.each([0, 32])('当前存档集已经观看时优先使用页面位置 %s，包括手动拖回开头', async position => {
    const data = createDefaultPlaybackData(); data.progress.position = 80;
    const env = mount(data, undefined, '', `${data.config.works[0].entries[0].url}&vd_source=test`);
    env.media().currentTime = position;
    Object.defineProperty(env.media(), 'played', { value: { length: 1 } });
    await env.runtime.command({ type: 'resume' });
    expect(env.media().currentTime).toBe(position);
    expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy();
  });

  it('新选中的集数尚未加载时从零开始，不使用另一集的断点或旧媒体时间', async () => {
    const data = createDefaultPlaybackData(); data.progress.position = 80;
    const selected = data.config.works[0].entries[2];
    const { storage } = storageFor('GM'); const env = mount(data, storage, '', selected.url);
    env.media().currentTime = 345;
    Object.defineProperty(env.media(), 'readyState', { value: 0, configurable: true });
    await env.runtime.command({ type: 'resume' });
    expect(env.runtime.getState().current?.id).toBe(selected.id);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 0 } });
    expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy();
  });

  it('片单之外的页面仍恢复原存档', async () => {
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 80;
    const env = mount(data, undefined, '', 'https://www.bilibili.com/video/BV1AA411x7AB/');
    env.media().currentTime = 345;
    await env.runtime.command({ type: 'resume' });
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(playbackQueue(data.config)[1].url));
    expect(env.runtime.getState().current?.id).toBe(playbackQueue(data.config)[1].id);
    env.runtime.destroy();
  });

  it('从头播放不受手动打开的片单集数影响', async () => {
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 80;
    const { storage } = storageFor('GM'); const env = mount(data, storage, '', data.config.works[0].entries[2].url);
    env.media().currentTime = 345;
    await env.runtime.command({ type: 'start' });
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(playbackQueue(data.config)[0].url));
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { cursor: 0, position: 0 } });
    env.runtime.destroy();
  });

  it('手动切集后立即继续观看，不等路由轮询也能接入新一集', async () => {
    const data = createDefaultPlaybackData(); const env = mount(data);
    await env.runtime.command({ type: 'resume' });
    const selected = data.config.works[0].entries[2];
    env.move(selected.url); env.media().currentTime = 42;
    await env.runtime.command({ type: 'resume' });
    expect(env.runtime.getState().current?.id).toBe(selected.id);
    expect(env.media().currentTime).toBe(42);
    expect(env.assign).not.toHaveBeenCalled();
    env.runtime.destroy();
  });

  it.each(['GM', 'Chrome'] as const)('%s 播放中保存新顺序保留媒体位置和计时，片尾才切到新队列下一集', async kind => {
    const data = createDefaultPlaybackData(); data.progress.cursor = 1; data.progress.position = 55;
    const { storage } = storageFor(kind); const env = mount(data, storage);
    await env.runtime.command({ type: 'resume' });
    await vi.advanceTimersByTimeAsync(2000);
    env.media().currentTime = 88.5;
    const current = env.runtime.getState().current!;
    const config = { ...env.runtime.getState().config, order: 'sequential' as const };
    await env.runtime.command({ type: 'save-config', config });
    expect(env.playing()).toBe(true); expect(env.media().currentTime).toBe(88.5);
    expect(env.assign).not.toHaveBeenCalled();
    expect(env.runtime.getState()).toMatchObject({ mode: 'animation', status: 'playing', current: { id: current.id }, elapsedMs: 2000 });
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.config.order).toBe('sequential');
    expect(saved.progress).toMatchObject({ position: 88.5, animationElapsedMs: 2000 });
    expect(playbackQueue(saved.config)[saved.progress.cursor].id).toBe(current.id);
    const next = env.runtime.getState().next!;
    expect(next.id).toBe(data.config.works[1].entries[1].id);
    env.end(); await flush();
    expect(env.assign).toHaveBeenCalledWith(normalizePlaybackUrl(next.url));
    env.runtime.destroy();
  });

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
    expect(env.media().currentTime).toBe(345); expect(env.playing()).toBe(true);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ progress: { position: 345, normalElapsedMs: 0 } });
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
    const env = mount(data, storage, '', action === 'same-page-pause' ? undefined : 'https://www.bilibili.com/video/BV1AA411x7AB/');
    env.media().currentTime = 345;
    if (action === 'same-page-pause') Object.defineProperty(env.media(), 'readyState', { value: 0, configurable: true });
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
    expect(consumePlaybackNavigation(env.target)).toEqual({ kind: 'system', url }); expect(env.target.name).toBe('original-name');
    expect(consumePlaybackNavigation(env.target)).toBe(false);
    expect(consumePlaybackNavigation(page(url, ticket, 'reload').target)).toBe(false);
    expect(consumePlaybackNavigation(page(url, ticket, 'back_forward').target)).toBe(false);
    expect(consumePlaybackNavigation(page('https://www.bilibili.com/', ticket).target)).toBe(false);
    expect(consumePlaybackNavigation(page(url).target)).toBe(false);
    expect(consumePlaybackNavigation(page(`${url}?p=1&spm_id_from=333.1007`, ticket).target)).toEqual({ kind: 'system', url });
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

  it.each(['GM', 'Chrome'] as const)('%s 保存广告分段断点，下一页续播同一广告且不覆盖动画进度', async kind => {
    const { storage } = storageFor(kind); const data = createDefaultPlaybackData();
    data.config.normalAds = true; data.config.intervalMinutes = 1 / 60;
    data.progress.cursor = 1; data.progress.position = 55;
    await storage.set(PLAYBACK_STORAGE_KEY, data);
    const first = mount(data, storage);
    first.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000); first.end(); await flush();
    const overlay = vi.mocked(createAdvertisementOverlay).mock.calls.at(-1)![0];
    overlay.onProgress?.(60); overlay.onFinish('segment');
    first.runtime.destroy(); await flush();
    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(saved.progress).toMatchObject({ cursor: 1, position: 55, adResume: { url: overlay.url, position: 60 } });
    const second = mount(saved, storage);
    second.event({ type: 'playing' }); await vi.advanceTimersByTimeAsync(1000); second.end(); await flush();
    const resumed = vi.mocked(createAdvertisementOverlay).mock.calls.at(-1)![0];
    expect(resumed).toMatchObject({ url: overlay.url, position: 60 });
    resumed.onProgress?.(72); resumed.onFinish('ended'); await flush();
    expect((await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData).progress.adResume).toBeUndefined();
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
