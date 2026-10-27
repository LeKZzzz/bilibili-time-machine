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
  vi.mocked(createPlaybackRuntime).mockImplementation((_target, initial, storage) => {
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
    };
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('playback bridge', () => {
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
