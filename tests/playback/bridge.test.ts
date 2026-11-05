import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackBridgeClient, installPlaybackBridgeHost } from '../../src/playback/bridge';
import { createPlaybackRuntime, PLAYBACK_STORAGE_KEY } from '../../src/playback/runtime';
import { createDefaultPlaybackData } from '../../src/playback/model';
import type { PlaybackState } from '../../src/playback/session';
import type { ConfigStorage } from '../../src/runtime/config-store';

vi.mock('../../src/playback/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/playback/runtime')>();
  return { ...original, createPlaybackRuntime: vi.fn() };
});

const CHANNEL = 'bilibili-time-machine/playback';
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

function bridgeWindow() {
  const events = new EventTarget();
  const messages: Record<string, unknown>[] = [];
  const emit = (data: unknown, origin = 'https://www.bilibili.com', source: unknown = target) => {
    const event = new Event('message'); Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
    events.dispatchEvent(event);
  };
  const target = {
    document: document.implementation.createHTMLDocument(), location: { origin: 'https://www.bilibili.com' },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    postMessage(message: Record<string, unknown>) { messages.push(message); void Promise.resolve().then(() => emit(message)); },
  } as unknown as Window;
  return { target, messages, emit };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.mocked(createPlaybackRuntime).mockImplementation((_target, initial, storage, resolveSource) => {
    let data = structuredClone(initial);
    let state: PlaybackState = { config: data.config, mode: 'normal', status: 'idle', current: null, next: null, ad: null, elapsedMs: 0, message: '', canResume: true };
    const listeners = new Set<(state: PlaybackState) => void>();
    const publish = (patch: Partial<PlaybackState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };
    return {
      getState: () => state, destroy() {}, subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
      async command(command) {
        if (command.type === 'save-config') data = { ...data, config: command.config };
        publish({ status: 'loading' });
        try {
          await storage.set(PLAYBACK_STORAGE_KEY, data);
          publish({ config: data.config, status: 'playing', mode: 'animation' });
        } catch (error) { publish({ status: 'blocked', message: '保存失败' }); throw error; }
      },
      resolveSource(url) { return resolveSource ? resolveSource(url) : Promise.reject(new Error('resolver missing')); },
    };
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function videoApiResponse(code = 0, message = 'OK'): Response {
  return new Response(JSON.stringify({
    code,
    message,
    data: {
      bvid: 'BV1Ex411q7SJ',
      title: '桥接测试片源',
      pages: [
        { page: 1, part: '第 1 集', duration: 600 },
        { page: 2, part: '第 2 集', duration: 620 },
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function storage(): ConfigStorage {
  return { async get() { return undefined; }, async set() {}, async remove() {} };
}

describe('playback bridge', () => {
  it('resolves an input link directly with authenticated, bounded API requests', async () => {
    const env = bridgeWindow();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => videoApiResponse());
    const client = createPlaybackBridgeClient(env.target, storage(), fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await client.resolveSource('BV1Ex411q7SJ');
    expect(result).toMatchObject({
      title: '桥接测试片源', kind: 'parts',
      entries: [
        { title: '第 1 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/' },
        { title: '第 2 集', url: 'https://www.bilibili.com/video/BV1Ex411q7SJ/?p=2' },
      ],
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.bilibili.com/x/web-interface/view?bvid=BV1Ex411q7SJ',
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
    );
  });

  it('uses the fetch implementation captured before a later page Hook replaces it', async () => {
    const env = bridgeWindow();
    const originalFetch = vi.fn(async () => videoApiResponse());
    const laterHookFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    (env.target as Window & { fetch: typeof fetch }).fetch = originalFetch as unknown as typeof fetch;
    const client = createPlaybackBridgeClient(env.target, storage());
    (env.target as Window & { fetch: typeof fetch }).fetch = laterHookFetch as unknown as typeof fetch;
    await client.resolveSource('BV1Ex411q7SJ');
    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(laterHookFetch).not.toHaveBeenCalled();
  });

  it('turns HTTP failures and fetch timeouts into readable Chinese errors', async () => {
    const httpEnv = bridgeWindow();
    const httpClient = createPlaybackBridgeClient(httpEnv.target, storage(), vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch);
    await expect(httpClient.resolveSource('BV1Ex411q7SJ')).rejects.toThrow('HTTP 503');

    const timeoutEnv = bridgeWindow();
    const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const timeoutClient = createPlaybackBridgeClient(timeoutEnv.target, storage(), pendingFetch as unknown as typeof fetch);
    const rejected = expect(timeoutClient.resolveSource('BV1Ex411q7SJ')).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(pendingFetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('relays successful source resolution from the host runtime through the client RPC', async () => {
    const env = bridgeWindow();
    const fetcher = vi.fn(async () => videoApiResponse());
    installPlaybackBridgeHost(env.target);
    createPlaybackBridgeClient(env.target, storage(), fetcher as unknown as typeof fetch);
    await flush();
    const runtime = vi.mocked(createPlaybackRuntime).mock.results[0].value;
    const result = runtime.resolveSource('BV1Ex411q7SJ');
    await flush();
    await expect(result).resolves.toMatchObject({ title: '桥接测试片源', kind: 'parts' });
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'resolve-source', url: 'BV1Ex411q7SJ' }));
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'source-result', result: expect.objectContaining({ kind: 'parts' }) }));
  });

  it('preserves the source resolver error message across the host RPC', async () => {
    const env = bridgeWindow();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: -403, message: '无权访问' }), { status: 200 }));
    installPlaybackBridgeHost(env.target);
    createPlaybackBridgeClient(env.target, storage(), fetcher as unknown as typeof fetch);
    await flush();
    const runtime = vi.mocked(createPlaybackRuntime).mock.results[0].value;
    const result = runtime.resolveSource('BV1Ex411q7SJ');
    await flush();
    await expect(result).rejects.toThrow('B站视频接口返回错误（-403）：无权访问');
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'source-result', error: 'B站视频接口返回错误（-403）：无权访问' }));
  });

  it('times out a host source RPC when the isolated client does not respond', async () => {
    const env = bridgeWindow();
    installPlaybackBridgeHost(env.target);
    env.emit({ channel: CHANNEL, type: 'init', data: createDefaultPlaybackData() });
    await flush();
    const runtime = vi.mocked(createPlaybackRuntime).mock.results[0].value;
    const result = expect(runtime.resolveSource('BV1Ex411q7SJ')).rejects.toThrow('片源解析等待超时');
    await flush();
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'resolve-source', url: 'BV1Ex411q7SJ' }));
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });

  it('surfaces a stopped playlist through the existing notice channel without repeating every tick', async () => {
    const env = bridgeWindow();
    const client = createPlaybackBridgeClient(env.target, { async get() { return undefined; }, async set() {}, async remove() {} });
    await flush();
    const state = { ...client.getState(), status: 'stopped', message: '整份片单均无法播放，请检查片源' };
    env.emit({ channel: CHANNEL, type: 'state', state });
    env.emit({ channel: CHANNEL, type: 'state', state });
    await flush();
    expect(env.messages.filter(message => message.type === 'time-filter/notice')).toEqual([
      { type: 'time-filter/notice', reason: 'playback-stopped', message: state.message },
    ]);
  });
  it.each(['client-first', 'host-first'])('handshakes in %s order and waits for persistent save acknowledgment', async order => {
    const env = bridgeWindow(); const data = createDefaultPlaybackData(); data.config.intervalMinutes = 35;
    let commit: (() => void) | undefined;
    const saved = new Map<string, unknown>();
    const storage: ConfigStorage = {
      async get() { return data; }, async remove() {},
      set(key, value) { return new Promise<void>(resolve => { commit = () => { saved.set(key, value); resolve(); }; }); },
    };
    if (order === 'host-first') installPlaybackBridgeHost(env.target);
    const client = createPlaybackBridgeClient(env.target, storage);
    expect(client.getState().status).toBe('loading');
    if (order === 'client-first') { await flush(); installPlaybackBridgeHost(env.target); }
    await flush();
    expect(client.getState().config.intervalMinutes).toBe(35);
    let acknowledged = false;
    const command = Promise.resolve(client.command({ type: 'start' })).then(() => { acknowledged = true; }); await flush();
    expect(client.getState().status).toBe('loading'); expect(saved.has(PLAYBACK_STORAGE_KEY)).toBe(false);
    expect(acknowledged).toBe(false);
    commit!(); await flush();
    await command; expect(acknowledged).toBe(true);
    expect(saved.get(PLAYBACK_STORAGE_KEY)).toEqual(data);
    expect(client.getState()).toMatchObject({ mode: 'animation', status: 'playing' });
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'saved', id: expect.any(Number) }));
  });

  it('relays failed storage writes to the host instead of acknowledging successful playback', async () => {
    const env = bridgeWindow(); installPlaybackBridgeHost(env.target);
    const client = createPlaybackBridgeClient(env.target, { async get() { return undefined; }, async set() { throw new Error('disk full'); }, async remove() {} });
    await flush(); const failed = expect(client.command({ type: 'start' })).rejects.toThrow('保存失败'); await flush(); await failed;
    expect(client.getState()).toMatchObject({ status: 'blocked', message: '保存失败' });
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'saved', error: true }));
  });

  it('ignores state and storage messages from another origin or window', async () => {
    const env = bridgeWindow(); const set = vi.fn(async () => {});
    const client = createPlaybackBridgeClient(env.target, { async get() { return undefined; }, set, async remove() {} });
    await flush(); const before = client.getState();
    env.emit({ channel: CHANNEL, type: 'state', state: { status: 'playing' } }, 'https://example.com');
    env.emit({ channel: CHANNEL, type: 'state', state: { status: 'playing' } }, undefined, {});
    env.emit({ channel: CHANNEL, type: 'save', id: 1, data: 'unexpected' }, 'https://example.com');
    expect(client.getState()).toEqual(before); expect(set).not.toHaveBeenCalled();
  });

  it('shows a readable failure when stored configuration cannot be loaded', async () => {
    const env = bridgeWindow();
    const client = createPlaybackBridgeClient(env.target, { async get() { throw new Error('unavailable'); }, async set() {}, async remove() {} });
    await flush();
    expect(client.getState().message).toContain('读取失败');
    expect(env.messages.some(message => message.type === 'init')).toBe(false);
  });

  it('rejects the command if the page controller never answers instead of claiming settings were saved', async () => {
    const env = bridgeWindow();
    const client = createPlaybackBridgeClient(env.target, { async get() { return undefined; }, async set() {}, async remove() {} });
    await flush();
    const failed = expect(client.command({ type: 'save-config', config: createDefaultPlaybackData().config })).rejects.toThrow('未响应');
    await vi.advanceTimersByTimeAsync(10000); await failed;
  });

  it('reads the latest persisted progress through the host storage port rather than reusing initialization data', async () => {
    const env = bridgeWindow(); let latest = createDefaultPlaybackData();
    installPlaybackBridgeHost(env.target);
    createPlaybackBridgeClient(env.target, { async get() { return structuredClone(latest); }, async set() {}, async remove() {} });
    await flush();
    const hostStorage = vi.mocked(createPlaybackRuntime).mock.calls[0][2];
    latest = structuredClone(latest); latest.progress.cursor = 1; latest.progress.position = 88;
    const result = hostStorage.get(PLAYBACK_STORAGE_KEY); await flush();
    expect(await result).toMatchObject({ progress: { cursor: 1, position: 88 } });
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'read-result', data: latest }));
  });

  it('rejects host reads when the isolated storage adapter fails', async () => {
    const env = bridgeWindow(); let fail = false;
    installPlaybackBridgeHost(env.target);
    createPlaybackBridgeClient(env.target, { async get() { if (fail) throw new Error('storage failed'); return undefined; }, async set() {}, async remove() {} });
    await flush(); fail = true;
    const hostStorage = vi.mocked(createPlaybackRuntime).mock.calls[0][2];
    const result = expect(hostStorage.get(PLAYBACK_STORAGE_KEY)).rejects.toThrow('读取失败');
    await flush(); await result;
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'read-result', error: true }));
  });
});
