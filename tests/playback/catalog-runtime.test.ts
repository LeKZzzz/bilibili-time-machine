import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPlaybackData, normalizePlaybackData, playbackQueue, type PlaybackData } from '../../src/playback/model';
import { PLAYBACK_STORAGE_KEY, createPlaybackRuntime } from '../../src/playback/runtime';
import { createPlaybackPlayer } from '../../src/playback/player';
import { createAdvertisementOverlay } from '../../src/playback/overlay';
import type { ConfigStorage } from '../../src/runtime/config-store';
import type { ResolvedPlaybackSource } from '../../src/playback/source';

vi.mock('../../src/playback/player', () => ({ createPlaybackPlayer: vi.fn() }));
vi.mock('../../src/playback/overlay', () => ({ createAdvertisementOverlay: vi.fn() }));

function memoryStorage(initial?: PlaybackData) {
  const values = new Map<string, unknown>();
  if (initial) values.set(PLAYBACK_STORAGE_KEY, structuredClone(initial));
  const storage: ConfigStorage = {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
  };
  return { storage, values };
}

function page(url: string) {
  const events = new EventTarget();
  const document = window.document.implementation.createHTMLDocument();
  let location = new URL(url);
  const assign = vi.fn((next: string) => { location = new URL(next); });
  const target = {
    document, name: '', navigator: {}, performance: { now: () => Date.now(), getEntriesByType: () => [] },
    get location() { return { href: location.href, hostname: location.hostname, pathname: location.pathname, origin: location.origin, assign }; },
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;
  return { target, assign };
}

function responseFor(url: string): ResolvedPlaybackSource {
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map(index => {
    const part = new URL(url);
    part.searchParams.set('p', String(index));
    return { id: `api-${index}`, title: `第${index}集`, url: part.href };
  });
  return { title: '解析结果', kind: 'parts', entries };
}

function mount(data: PlaybackData, resolveSource?: (url: string) => Promise<ResolvedPlaybackSource>, storage = memoryStorage(data).storage) {
  const queue = playbackQueue(data.config);
  const env = page(queue[data.progress.cursor]?.url ?? data.config.works[0].entries[0].url);
  let media = env.target.document.createElement('video');
  Object.defineProperty(media, 'readyState', { value: 4, configurable: true });
  let options: Parameters<typeof createPlaybackPlayer>[0];
  vi.mocked(createPlaybackPlayer).mockImplementation(value => {
    options = value;
    return {
      media: () => media,
      seek() { options.onEvent({ type: 'positioning' }); },
      play: async () => { options.onEvent({ type: 'playing' }); },
      pause: () => options.onEvent({ type: 'pause' }),
      refresh() {}, releaseEnded() {}, destroy() {},
    };
  });
  vi.mocked(createAdvertisementOverlay).mockImplementation(() => ({
    destroy() {}, resume: async () => {},
  } as ReturnType<typeof createAdvertisementOverlay>));
  const runtime = createPlaybackRuntime(env.target, data, storage, resolveSource);
  return {
    ...env, runtime, storage,
    event: (event: Parameters<typeof options.onEvent>[0]) => options.onEvent(event),
    end: () => options.shouldHoldEnded(),
    media: () => media,
  };
}

const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
async function waitForCatalogDone(runtime: ReturnType<typeof createPlaybackRuntime>) {
  for (let index = 0; index < 100 && runtime.getState().catalogResolving; index++) await Promise.resolve();
}
function defaultData(workCount = 1): PlaybackData {
  const data = createDefaultPlaybackData();
  data.config.works = data.config.works.slice(0, workCount);
  return data;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.clearAllMocks();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('playback catalog runtime', () => {
  it('不会在创建 runtime 时联网；只响应显式补全命令，保存后重开不重复解析', async () => {
    const data = defaultData();
    const resolveSource = vi.fn(async (url: string) => responseFor(url));
    const first = mount(data, resolveSource);

    expect(first.runtime.getState().config.works[0].sourceStatus).toBe('pending');
    expect(resolveSource).not.toHaveBeenCalled();
    await first.runtime.command({ type: 'resolve-catalog' });
    await waitForCatalogDone(first.runtime);

    expect(resolveSource).toHaveBeenCalledTimes(1);
    const stored = await first.storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(stored.config.works[0]).toMatchObject({ sourceStatus: 'resolved' });
    expect(stored.config.works[0].entries).toHaveLength(data.config.works[0].entries.length + 1);
    first.runtime.destroy();

    const reopened = mount(stored, resolveSource, first.storage);
    await reopened.runtime.command({ type: 'resolve-catalog' });
    await flush();
    expect(resolveSource).toHaveBeenCalledTimes(1);
    reopened.runtime.destroy();
  });

  it('默认片源解析最多并行两个作品，并把结果写回片单', async () => {
    const data = defaultData(4);
    const pending: Array<{ url: string; result: ReturnType<typeof deferred<ResolvedPlaybackSource>> }> = [];
    let active = 0;
    let maxActive = 0;
    const resolveSource = vi.fn((url: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const result = deferred<ResolvedPlaybackSource>();
      pending.push({ url, result });
      return result.promise.finally(() => { active--; });
    });
    const { runtime, storage } = mount(data, resolveSource);
    await runtime.command({ type: 'resolve-catalog' });
    await flush();
    expect(resolveSource).toHaveBeenCalledTimes(2);

    for (let completed = 0; completed < data.config.works.length; completed++) {
      const request = pending.shift();
      expect(request).toBeDefined();
      request!.result.resolve(responseFor(request!.url));
      await flush();
    }
    await waitForCatalogDone(runtime);
    expect(maxActive).toBe(2);
    expect(resolveSource).toHaveBeenCalledTimes(data.config.works.length);
    expect(runtime.getState().config.works.every(work => work.sourceStatus === 'resolved')).toBe(true);
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ config: { works: data.config.works.map(work => ({ id: work.id, sourceStatus: 'resolved' })) } });
    runtime.destroy();
  });

  it('解析失败时保留 seed 条目并标记 failed', async () => {
    const data = defaultData();
    const seed = normalizePlaybackData(data).config.works[0];
    const { storage } = memoryStorage(data);
    const { runtime } = mount(data, async () => { throw new Error('offline'); }, storage);
    await runtime.command({ type: 'resolve-catalog' });
    await waitForCatalogDone(runtime);

    expect(runtime.getState().config.works[0]).toMatchObject({ sourceStatus: 'failed', entries: seed.entries });
    expect(await storage.get(PLAYBACK_STORAGE_KEY)).toMatchObject({ config: { works: [{ sourceStatus: 'failed', entries: seed.entries }] } });
    runtime.destroy();
  });

  it('只合并仍匹配的 seed，保留最新用户设置和进度并按旧 entry ID 重映射位置', async () => {
    const data = defaultData(2);
    data.config.order = 'sequential';
    data.progress.cursor = data.config.works[0].entries.length;
    data.progress.position = 43;
    data.progress.animationElapsedMs = 5000;
    data.progress.normalElapsedMs = 9000;
    data.progress.round = 3;
    data.progress.failedEntryIds = [data.config.works[1].entries[1].id];
    const { storage } = memoryStorage(data);
    const requests = new Map<string, ReturnType<typeof deferred<ResolvedPlaybackSource>>>();
    const resolveSource = vi.fn((url: string) => {
      const task = deferred<ResolvedPlaybackSource>();
      requests.set(url, task);
      return task.promise;
    });
    const { runtime } = mount(data, resolveSource, storage);
    await runtime.command({ type: 'resolve-catalog' });
    await flush();
    expect(resolveSource).toHaveBeenCalledTimes(2);

    const latest = structuredClone(data);
    latest.config.intervalMinutes = 7;
    latest.config.normalAds = true;
    latest.config.ads = [{ id: 'user-ad', title: '用户新增广告', url: 'https://www.bilibili.com/video/BV1xK4y1r7BD/' }];
    latest.config.works[1].title = '用户修改的作品名';
    latest.config.works[1].sourceStatus = 'manual';
    await storage.set(PLAYBACK_STORAGE_KEY, latest);
    for (const [url, task] of requests) task.resolve(responseFor(url));
    await waitForCatalogDone(runtime);

    const saved = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    const originalCurrentId = data.config.works[1].entries[0].id;
    expect(saved.config.works[0]).toMatchObject({ sourceStatus: 'resolved' });
    expect(saved.config.works[0].entries).toHaveLength(data.config.works[0].entries.length + 1);
    expect(saved.config.works[1]).toMatchObject({ title: '用户修改的作品名', sourceStatus: 'manual' });
    expect(saved.config).toMatchObject({ intervalMinutes: 7, normalAds: true, ads: latest.config.ads });
    expect(playbackQueue(saved.config)[saved.progress.cursor].id).toBe(originalCurrentId);
    expect(saved.progress).toMatchObject({ position: 43, animationElapsedMs: 5000, normalElapsedMs: 9000, round: 3, failedEntryIds: [data.config.works[1].entries[1].id] });
    expect(runtime.getState().config.works[1].title).toBe('用户修改的作品名');
    runtime.destroy();
  });

  it.each(['cancel', 'save', 'start'] as const)('用户执行 %s 后，迟到的解析结果不会覆盖现有状态', async action => {
    const data = defaultData();
    const task = deferred<ResolvedPlaybackSource>();
    const { storage } = memoryStorage(data);
    const { runtime } = mount(data, () => task.promise, storage);
    await runtime.command({ type: 'resolve-catalog' });
    await flush();
    expect(runtime.getState().catalogResolving).toBe(true);

    if (action === 'cancel') await runtime.command({ type: 'cancel-catalog-resolution' });
    else if (action === 'save') {
      const config = structuredClone(runtime.getState().config);
      config.intervalMinutes = 9;
      await runtime.command({ type: 'save-config', config });
    } else await runtime.command({ type: 'start' });

    const beforeLateResult = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    task.resolve(responseFor(resolveUrl(data.config.works[0].entries[0].url)));
    await flush();
    const afterLateResult = await storage.get(PLAYBACK_STORAGE_KEY) as PlaybackData;
    expect(afterLateResult.config.works[0].sourceStatus).toBe(beforeLateResult.config.works[0].sourceStatus);
    expect(afterLateResult.config.works[0].entries).toEqual(beforeLateResult.config.works[0].entries);
    if (action === 'save') expect(afterLateResult.config.intervalMinutes).toBe(9);
    if (action === 'start') expect(runtime.getState().mode).toBe('animation');
    runtime.destroy();
  });

  it('动画运行或广告播放期间不启动默认片单解析', async () => {
    const animationData = defaultData();
    const animationResolver = vi.fn(async (url: string) => responseFor(url));
    const animation = mount(animationData, animationResolver);
    await animation.runtime.command({ type: 'start' });
    await animation.runtime.command({ type: 'resolve-catalog' });
    expect(animation.runtime.getState().mode).toBe('animation');
    expect(animationResolver).not.toHaveBeenCalled();
    animation.runtime.destroy();

    const adData = defaultData();
    adData.config.normalAds = true;
    adData.config.intervalMinutes = 1 / 60;
    const adResolver = vi.fn(async (url: string) => responseFor(url));
    const ad = mount(adData, adResolver);
    ad.event({ type: 'playing' });
    await vi.advanceTimersByTimeAsync(1000);
    ad.end();
    expect(ad.runtime.getState().ad).not.toBeNull();
    await ad.runtime.command({ type: 'resolve-catalog' });
    expect(adResolver).not.toHaveBeenCalled();
    ad.runtime.destroy();
  });
});

function resolveUrl(url: string): string {
  const value = new URL(url);
  value.search = '';
  return value.href;
}
