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
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '时光机提示');
  root.tabIndex = -1;
  root.style.cssText = 'position:fixed;z-index:2147483645;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;max-width:min(360px,calc(100vw - 32px));font:14px/1.55 "Noto Sans SC","Microsoft YaHei",sans-serif;';
  doc.documentElement.append(root);
  const seen = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let searchNotice: ReturnType<typeof createItem> | null = null;

  const activeElement = (): Element | null => {
    let active = doc.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  let outsideFocus = activeElement() as HTMLElement | null;
  const rememberFocus = (event: FocusEvent): void => {
    const from = event.composedPath()[0] as HTMLElement | undefined;
    if (from && !root.contains(from) && root.contains(event.relatedTarget as Node | null)) outsideFocus = from;
  };
  doc.addEventListener('focusout', rememberFocus, true);

  const createItem = (message: string, duration = 0) => {
    let previousFocus = activeElement() as HTMLElement | null;
    let pendingDismiss = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const item = doc.createElement('div');
    item.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border:1px solid #e9edf1;border-radius:10px;background:#fff;color:#20252b;box-shadow:0 6px 24px #26394b1f;overflow-wrap:anywhere;';
    const text = doc.createElement('span');
    text.textContent = message;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭提示');
    close.style.cssText = 'flex-shrink:0;border:0;background:transparent;color:#646e79;cursor:pointer;font:20px/1.1 sans-serif;padding:0 2px;';
    const dismiss = (manual = false): void => {
      const focused = item.contains(activeElement());
      if (focused && !manual) { pendingDismiss = true; return; }
      if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); }
      const adjacent = item.nextElementSibling ?? item.previousElementSibling;
      item.remove();
      if (focused) {
        const next = adjacent?.querySelector<HTMLButtonElement>('button');
        (next ?? (previousFocus?.isConnected ? previousFocus : root)).focus();
      }
    };
    close.addEventListener('click', () => dismiss(true));
    item.addEventListener('focusin', event => {
      const from = event.relatedTarget as HTMLElement | null;
      if (from && !root.contains(from)) previousFocus = outsideFocus ?? from;
    });
    item.addEventListener('focusout', () => {
      queueMicrotask(() => { if (pendingDismiss && !item.contains(activeElement())) dismiss(); });
    });
    item.append(text, close);
    root.append(item);
    if (duration > 0) {
      timer = setTimeout(() => { timers.delete(timer!); dismiss(); }, duration);
      timers.add(timer);
    }
    return { element: item, dismiss };
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
      createItem(message, options.durationMs ?? 8000);
    },
    setSearching(searching) {
      if (searching && !searchNotice) {
        searchNotice = createItem('正在寻找符合截止时间的视频…');
        searchNotice.element.dataset.favoriteSearching = 'true';
        searchNotice.element.setAttribute('role', 'status');
        searchNotice.element.setAttribute('aria-busy', 'true');
      } else if (!searching) {
        searchNotice?.element.removeAttribute('aria-busy');
        searchNotice?.dismiss();
        searchNotice = null;
      }
    },
    closeAll,
    destroy: () => {
      closeAll();
      doc.removeEventListener('focusout', rememberFocus, true);
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
