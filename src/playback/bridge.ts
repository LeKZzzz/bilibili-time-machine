import type { ConfigStorage } from '../runtime/config-store';
import type { PlaybackData } from './model';
import { createDefaultPlaybackData } from './model';
import type { PlaybackState } from './session';
import { createPlaybackRuntime, defaultPlaybackState, PLAYBACK_STORAGE_KEY, type PlaybackRuntime } from './runtime';
import type { PlaybackPanelClient } from '../ui/playback-panel';

const CHANNEL = 'bilibili-time-machine/playback';
function send(target: Window, payload: Record<string, unknown>): void {
  target.postMessage({ channel: CHANNEL, ...payload }, target.location.origin);
}

/** 隔离世界负责存储和界面，页面世界只接收本功能的配置与播放命令。 */
export function createPlaybackBridgeClient(target: Window, storage: ConfigStorage): PlaybackPanelClient {
  let state: PlaybackState = { ...defaultPlaybackState(), status: 'loading', message: '正在读取播放设置' };
  const listeners = new Set<(state: PlaybackState) => void>();
  let data: unknown;
  let loaded = false;
  let stoppedNotice = '';
  let commandId = 0;
  const commands = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const initialize = (): void => { if (loaded) send(target, { type: 'init', data }); };
  target.addEventListener('message', (event) => {
    if (event.source !== target || event.origin !== target.location.origin || event.data?.channel !== CHANNEL) return;
    const message = event.data;
    if (message.type === 'command-result') {
      const command = commands.get(message.id);
      commands.delete(message.id);
      if (message.error) command?.reject(new Error('播放操作或保存失败，请重试'));
      else command?.resolve();
    }
    if (message.type === 'ready') initialize();
    if (message.type === 'state' && message.state) {
      state = message.state as PlaybackState;
      for (const listener of listeners) listener(state);
      if (state.status === 'stopped' && state.message && stoppedNotice !== state.message) {
        stoppedNotice = state.message;
        target.postMessage({ type: 'time-filter/notice', reason: 'playback-stopped', message: state.message }, target.location.origin);
      } else if (state.status !== 'stopped') stoppedNotice = '';
    }
    if (message.type === 'save' && Number.isInteger(message.id)) {
      void storage.set(PLAYBACK_STORAGE_KEY, message.data).then(
        () => send(target, { type: 'saved', id: message.id }),
        () => send(target, { type: 'saved', id: message.id, error: true }),
      );
    }
    if (message.type === 'read' && Number.isInteger(message.id)) {
      void storage.get(PLAYBACK_STORAGE_KEY).then(
        (data) => send(target, { type: 'read-result', id: message.id, data }),
        () => send(target, { type: 'read-result', id: message.id, error: true }),
      );
    }
  });
  void storage.get(PLAYBACK_STORAGE_KEY).then((value) => {
    data = value ?? createDefaultPlaybackData(); loaded = true; initialize();
  }).catch(() => {
    state = { ...state, message: '播放配置读取失败，请刷新后重试。' };
    for (const listener of listeners) listener(state);
  });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    command(command) {
      if (!loaded) throw new Error('播放设置尚未就绪');
      return new Promise<void>((resolve, reject) => {
        const id = ++commandId;
        const timer = target.setTimeout(() => {
          commands.delete(id); reject(new Error('播放控制器未响应，请刷新后重试'));
        }, 10_000);
        commands.set(id, {
          resolve() { target.clearTimeout(timer); resolve(); },
          reject(error) { target.clearTimeout(timer); reject(error); },
        });
        send(target, { type: 'command', command, id });
      });
    },
  };
}

export function installPlaybackBridgeHost(target: Window): void {
  let runtime: PlaybackRuntime | undefined;
  let initializing = false;
  let id = 0;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const reads = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const storage: ConfigStorage = {
    get() {
      return new Promise<unknown>((resolve, reject) => {
        const requestId = ++id;
        const timer = target.setTimeout(() => { reads.delete(requestId); reject(new Error('播放进度读取超时')); }, 5_000);
        reads.set(requestId, {
          resolve(value) { target.clearTimeout(timer); resolve(value); },
          reject(error) { target.clearTimeout(timer); reject(error); },
        });
        send(target, { type: 'read', id: requestId });
      });
    },
    set(_key, data) {
      return new Promise<void>((resolve, reject) => {
        const requestId = ++id;
        const timer = target.setTimeout(() => {
          pending.delete(requestId); reject(new Error('播放进度保存超时'));
        }, 5_000);
        pending.set(requestId, {
          resolve() { target.clearTimeout(timer); resolve(); },
          reject(error) { target.clearTimeout(timer); reject(error); },
        });
        send(target, { type: 'save', id: requestId, data });
      });
    },
    async remove() {},
  };
  target.addEventListener('message', (event) => {
    if (event.source !== target || event.origin !== target.location.origin || event.data?.channel !== CHANNEL) return;
    const message = event.data;
    if (message.type === 'init' && !runtime && !initializing) {
      initializing = true;
      const mount = (): void => {
        runtime = createPlaybackRuntime(target, message.data as PlaybackData, storage);
        runtime.subscribe((state) => send(target, { type: 'state', state }));
      };
      if (target.document.documentElement) mount();
      else target.document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else if (message.type === 'command' && runtime) {
      void Promise.resolve(runtime.command(message.command)).then(
        () => send(target, { type: 'command-result', id: message.id }),
        () => send(target, { type: 'command-result', id: message.id, error: true }),
      );
    } else if (message.type === 'saved') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error('播放进度保存失败'));
      else request?.resolve();
    } else if (message.type === 'read-result') {
      const request = reads.get(message.id);
      reads.delete(message.id);
      if (message.error) request?.reject(new Error('播放进度读取失败'));
      else request?.resolve(message.data);
    }
  });
  send(target, { type: 'ready' });
}
