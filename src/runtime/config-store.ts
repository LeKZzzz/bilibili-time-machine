import { DEFAULT_FILTER_CONFIG, type FilterConfig } from '../core/types';

export const CONFIG_STORAGE_KEY = 'bilibili-time-filter/config';

export interface ConfigStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

function normalizeConfig(value: unknown): FilterConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_FILTER_CONFIG };
  const candidate = value as Partial<FilterConfig>;
  const budget = Number.isFinite(candidate.supplementBudget)
    ? Math.max(0, Math.min(100, Math.trunc(candidate.supplementBudget as number)))
    : DEFAULT_FILTER_CONFIG.supplementBudget;
  const cutoffMinute = candidate.cutoffMinute === null || typeof candidate.cutoffMinute === 'string'
    ? candidate.cutoffMinute ?? null
    : DEFAULT_FILTER_CONFIG.cutoffMinute;
  return {
    cutoffMinute,
    enabled: (typeof candidate.enabled === 'boolean' ? candidate.enabled : DEFAULT_FILTER_CONFIG.enabled)
      && Boolean(cutoffMinute),
    supplementBudget: budget,
    debug: typeof candidate.debug === 'boolean' ? candidate.debug : DEFAULT_FILTER_CONFIG.debug,
    autoAdvance: candidate.autoAdvance === true,
    autoAdvanceStartedAt: Number.isFinite(candidate.autoAdvanceStartedAt) ? candidate.autoAdvanceStartedAt : null,
    autoAdvanceBaseCutoffMinute: typeof candidate.autoAdvanceBaseCutoffMinute === 'string' && candidate.autoAdvanceBaseCutoffMinute
      ? candidate.autoAdvanceBaseCutoffMinute
      : null,
    favoriteHomeFillEnabled: candidate.favoriteHomeFillEnabled === true,
    favoriteFolderIds: Array.isArray(candidate.favoriteFolderIds) ? candidate.favoriteFolderIds.filter((id): id is string => typeof id === 'string').slice(0, 10) : [],
    favoriteFolderLimit: Number.isFinite(candidate.favoriteFolderLimit) ? Math.min(10, Math.max(1, Math.trunc(candidate.favoriteFolderLimit as number))) : 3,
    favoriteVideoLimit: Number.isFinite(candidate.favoriteVideoLimit) ? Math.min(200, Math.max(1, Math.trunc(candidate.favoriteVideoLimit as number))) : 50,
    favoriteRefreshRequestedAt: Number.isFinite(candidate.favoriteRefreshRequestedAt) ? candidate.favoriteRefreshRequestedAt : null,
  };
}

/** 创建存储适配器；调用方可注入 GM、chrome.storage 或测试内存存储。 */
export function createConfigStore(storage: ConfigStorage) {
  return {
    async loadConfig(): Promise<FilterConfig> {
      const value = await storage.get(CONFIG_STORAGE_KEY);
      return normalizeConfig(value);
    },
    async saveConfig(config: FilterConfig): Promise<void> {
      await storage.set(CONFIG_STORAGE_KEY, normalizeConfig(config));
    },
    async clearConfig(): Promise<void> {
      await storage.remove(CONFIG_STORAGE_KEY);
    },
  };
}

export type ConfigStore = ReturnType<typeof createConfigStore>;

let fallbackStorage: ConfigStorage | undefined;

function defaultStorage(): ConfigStorage {
  if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
    try {
      const storage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
      if (storage) return createLocalStorage(storage);
    } catch {
      // 隐私模式或无 DOM 环境下回退到内存存储。
    }
  }
  return fallbackStorage ?? (fallbackStorage = createMemoryConfigStorage());
}

export async function loadConfig(storage?: ConfigStorage): Promise<FilterConfig> {
  return createConfigStore(storage ?? defaultStorage()).loadConfig();
}

export async function saveConfig(config: FilterConfig, storage?: ConfigStorage): Promise<void>;
export async function saveConfig(storage: ConfigStorage, config: FilterConfig): Promise<void>;
export async function saveConfig(
  configOrStorage: FilterConfig | ConfigStorage,
  maybeStorageOrConfig?: ConfigStorage | FilterConfig,
): Promise<void> {
  const isStorage = (value: unknown): value is ConfigStorage => {
    return !!value && typeof value === 'object' && typeof (value as ConfigStorage).get === 'function';
  };
  const storage = isStorage(configOrStorage)
    ? configOrStorage
    : (isStorage(maybeStorageOrConfig) ? maybeStorageOrConfig : defaultStorage());
  const config = (isStorage(configOrStorage) ? maybeStorageOrConfig : configOrStorage) as FilterConfig;
  return createConfigStore(storage).saveConfig(config);
}

export async function clearConfig(storage?: ConfigStorage): Promise<void> {
  return createConfigStore(storage ?? defaultStorage()).clearConfig();
}

export function createMemoryConfigStorage(initial?: unknown): ConfigStorage {
  let value = initial;
  return {
    async get() {
      return value;
    },
    async set(_key, next) {
      value = next;
    },
    async remove() {
      value = undefined;
    },
  };
}

export function createGMStorage(gm: {
  getValue?: (key: string, fallback?: unknown) => unknown | Promise<unknown>;
  setValue?: (key: string, value: unknown) => unknown | Promise<unknown>;
  deleteValue?: (key: string) => unknown | Promise<unknown>;
}): ConfigStorage {
  return {
    async get(key) {
      if (typeof gm.getValue !== 'function') throw new Error('GM_getValue is unavailable');
      return gm.getValue(key);
    },
    async set(key, value) {
      if (typeof gm.setValue !== 'function') throw new Error('GM_setValue is unavailable');
      await gm.setValue(key, value);
    },
    async remove(key) {
      if (typeof gm.deleteValue !== 'function') throw new Error('GM_deleteValue is unavailable');
      await gm.deleteValue(key);
    },
  };
}

export function createChromeStorage(area: {
  get: (keys?: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>> | void;
  set: (items: Record<string, unknown>) => Promise<void> | void;
  remove: (keys: string | string[]) => Promise<void> | void;
}): ConfigStorage {
  return {
    async get(key) {
      const result = await area.get([key]);
      return result?.[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}

/** 浏览器页面内的轻量 localStorage 适配器，油猴/MV3 可显式传入各自适配器。 */
export function createLocalStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ConfigStorage {
  return {
    async get(key) {
      const raw = storage.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      storage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      storage.removeItem(key);
    },
  };
}
