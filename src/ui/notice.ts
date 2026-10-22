/** 页面提示管理器；只在当前标签页和当前文档生命周期内去重。 */

export interface NoticeOptions {
  document?: Document;
  location?: Location;
  durationMs?: number;
}

export interface NoticeManager {
  show(message: string, reason: string, route?: string): void;
  setSearching(searching: boolean): void;
  closeAll(): void;
  destroy(): void;
}

const NOTICE_ROOT_ID = 'bilibili-time-filter-notices';
const managers = new WeakMap<Document, NoticeManager>();

function routeKey(location: Location | undefined): string {
  const current = location ?? (typeof window === 'undefined' ? undefined : window.location);
  if (!current) return 'unknown';
  return `${current.host}${current.pathname}`;
}

/** 创建一组不会重复刷屏的非阻塞提示。 */
export function createNoticeManager(options: NoticeOptions = {}): NoticeManager {
  const doc = options.document ?? document;
  const root = doc.createElement('div');
  root.id = NOTICE_ROOT_ID;
  root.setAttribute('aria-live', 'polite');
  root.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 32px));font:14px/1.55 "Noto Sans SC","Microsoft YaHei",sans-serif;';
  doc.documentElement.append(root);
  const seen = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let searchNotice: HTMLElement | null = null;

  const createItem = (message: string): HTMLElement => {
    const item = doc.createElement('div');
    item.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border:1px solid #e9edf1;border-radius:10px;background:#fff;color:#20252b;box-shadow:0 6px 24px #26394b1f;overflow-wrap:anywhere;';
    const text = doc.createElement('span');
    text.textContent = message;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭提示');
    close.style.cssText = 'flex-shrink:0;border:0;background:transparent;color:#646e79;cursor:pointer;font:20px/1.1 sans-serif;padding:0 2px;';
    close.addEventListener('click', () => item.remove());
    item.append(text, close);
    root.append(item);
    return item;
  };

  const closeAll = (): void => {
    root.replaceChildren();
    searchNotice = null;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  return {
    show(message: string, reason: string, route = routeKey(options.location)): void {
      const key = `${route}|${reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      const item = createItem(message);
      const duration = options.durationMs ?? 8000;
      if (duration > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          item.remove();
        }, duration);
        timers.add(timer);
      }
    },
    setSearching(searching) {
      if (searching && !searchNotice) {
        searchNotice = createItem('正在搜索补位视频…');
        searchNotice.dataset.favoriteSearching = 'true';
        searchNotice.setAttribute('role', 'status');
        searchNotice.setAttribute('aria-busy', 'true');
      } else if (!searching) {
        searchNotice?.remove();
        searchNotice = null;
      }
    },
    closeAll,
    destroy: () => {
      closeAll();
      root.remove();
      seen.clear();
    },
  };
}

export function showNotice(message: string, reason: string, options?: NoticeOptions): void {
  const doc = options?.document ?? document;
  let manager = managers.get(doc);
  if (!manager) {
    manager = createNoticeManager(options);
    managers.set(doc, manager);
  }
  manager.show(message, reason);
}

export { NOTICE_ROOT_ID };
