import type { ConfigStorage } from '../runtime/config-store';
import type { PlaybackData } from './model';
import { createDefaultPlaybackData } from './model';
import type { PlaybackState } from './session';
import { createPlaybackRuntime, defaultPlaybackState, PLAYBACK_STORAGE_KEY, type PlaybackRuntime } from './runtime';
import type { PlaybackPanelClient } from '../ui/playback-panel';
import { resolvePlaybackSource, type ResolvedPlaybackSource } from './source';

const CHANNEL = 'bilibili-time-machine/playback';
const SOURCE_FETCH_TIMEOUT_MS = 10_000;
const SOURCE_RPC_TIMEOUT_MS = 15_000;
function send(target: Window, payload: Record<string, unknown>): void {
  target.postMessage({ channel: CHANNEL, ...payload }, target.location.origin);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isResolvedSource(value: unknown): value is ResolvedPlaybackSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<ResolvedPlaybackSource>;
  return typeof source.title === 'string'
    && ['parts', 'collection', 'season', 'single'].includes(String(source.kind))
    && Array.isArray(source.entries)
    && source.entries.every(entry => Boolean(entry)
      && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.url === 'string');
}

function createSourceResolver(target: Window, fetcher?: typeof fetch): (url: string) => Promise<ResolvedPlaybackSource> {
  // 在 Hook 安装前捕获页面 fetch，避免元数据请求经过后装的过滤包装器。
  const request = fetcher ?? target.fetch?.bind(target);
  const requestJson = async (url: string): Promise<unknown> => {
    if (!request) throw new Error('当前无法获取视频信息，请刷新页面后重试。');
    const controller = new AbortController();
    const timer = target.setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
    try {
      const response = await request(url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`暂时无法获取视频信息（错误代码：HTTP ${response.status}），请稍后重试。`);
      return await response.json() as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('获取视频信息超时，请稍后重试。');
      if (error instanceof Error && error.message.startsWith('暂时无法获取视频信息（错误代码：HTTP ')) throw error;
      throw new Error('暂时无法获取视频信息，请检查网络后重试。');
    } finally {
      target.clearTimeout(timer);
    }
  };
  return input => resolvePlaybackSource(input, requestJson);
}

/** 客户端连接界面、GM／Chrome 存储与片源解析；页面侧通过桥读写进度、接收命令并回传状态。 */
export function createPlaybackBridgeClient(target: Window, storage: ConfigStorage, fetcher?: typeof fetch): PlaybackPanelClient {
  let state: PlaybackState = { ...defaultPlaybackState(), status: 'loading', message: '正在读取播放设置' };
  const listeners = new Set<(state: PlaybackState) => void>();
  const resolveSource = createSourceResolver(target, fetcher);
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
      if (message.error) command?.reject(new Error('操作未完成，请重试。'));
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
    if (message.type === 'resolve-source' && Number.isInteger(message.id) && typeof message.url === 'string') {
      void resolveSource(message.url).then(
        result => send(target, { type: 'source-result', id: message.id, result }),
        error => send(target, { type: 'source-result', id: message.id, error: errorMessage(error, '未能获取视频信息，请稍后重试。') }),
      );
    }
  });
  void storage.get(PLAYBACK_STORAGE_KEY).then((value) => {
    data = value ?? createDefaultPlaybackData(); loaded = true; initialize();
  }).catch(() => {
    state = { ...state, message: '无法读取播放设置，请刷新页面后重试。' };
    for (const listener of listeners) listener(state);
  });
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    command(command) {
      if (!loaded) throw new Error('正在读取播放设置，请稍候再试。');
      return new Promise<void>((resolve, reject) => {
        const id = ++commandId;
        const timer = target.setTimeout(() => {
          commands.delete(id); reject(new Error('播放操作未响应，请刷新页面后重试。'));
        }, 10_000);
        commands.set(id, {
          resolve() { target.clearTimeout(timer); resolve(); },
          reject(error) { target.clearTimeout(timer); reject(error); },
        });
        send(target, { type: 'command', command, id });
      });
    },
    resolveSource,
  };
}

export function installPlaybackBridgeHost(target: Window): void {
  let runtime: PlaybackRuntime | undefined;
  let initializing = false;
  let id = 0;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const reads = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const sourceRequests = new Map<number, {
    resolve(value: ResolvedPlaybackSource): void;
    reject(error: Error): void;
    timer: number;
  }>();
  const resolveSource = (url: string): Promise<ResolvedPlaybackSource> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = target.setTimeout(() => {
      sourceRequests.delete(requestId);
      reject(new Error('获取视频信息超时，请稍后重试。'));
    }, SOURCE_RPC_TIMEOUT_MS);
    sourceRequests.set(requestId, { resolve, reject, timer });
    try {
      send(target, { type: 'resolve-source', id: requestId, url });
    } catch {
      target.clearTimeout(timer);
      sourceRequests.delete(requestId);
      reject(new Error('无法获取视频信息，请刷新页面后重试。'));
    }
  });
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
        runtime = createPlaybackRuntime(target, message.data as PlaybackData, storage, resolveSource);
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
    } else if (message.type === 'source-result' && Number.isInteger(message.id)) {
      const request = sourceRequests.get(message.id);
      if (!request) return;
      sourceRequests.delete(message.id);
      target.clearTimeout(request.timer);
      if (typeof message.error === 'string') request.reject(new Error(message.error));
      else if (isResolvedSource(message.result)) request.resolve(message.result);
      else request.reject(new Error('未能获取视频信息，请稍后重试。'));
    }
  });
  send(target, { type: 'ready' });
}
