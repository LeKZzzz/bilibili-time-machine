/** 页面提示管理器；只在当前标签页和当前文档生命周期内去重。 */

export interface NoticeOptions {
  document?: Document;
  location?: Location;
  durationMs?: number;
}

export interface NoticeManager {
  show(message: string, reason: string, route?: string): void;
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
  root.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:360px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
  doc.documentElement.append(root);
  const seen = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const closeAll = (): void => {
    root.replaceChildren();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  return {
    show(message: string, reason: string, route = routeKey(options.location)): void {
      const key = `${route}|${reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      const item = doc.createElement('div');
      item.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid rgba(0,0,0,.12);border-radius:7px;background:#fff;color:#18191c;box-shadow:0 3px 12px rgba(0,0,0,.16);';
      const text = doc.createElement('span');
      text.textContent = message;
      const close = doc.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭提示');
      close.style.cssText = 'border:0;background:transparent;color:#6d7579;cursor:pointer;font-size:16px;line-height:1;padding:0;';
      close.addEventListener('click', () => item.remove());
      item.append(text, close);
      root.append(item);
      const duration = options.durationMs ?? 8000;
      if (duration > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          item.remove();
        }, duration);
        timers.add(timer);
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
