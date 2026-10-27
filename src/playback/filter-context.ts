import { normalizePlaybackUrl } from './model';

/** 仅豁免正在播放的动画主条目，推荐、评论与其他页面仍沿用原过滤。 */
export function isAnimationPlaybackDocument(document: Document | null | undefined): boolean {
  if (!document) return false;
  if (document.documentElement?.hasAttribute('data-time-machine-animation')) return true;
  const page = document.defaultView;
  if (!page?.name.startsWith('bilibili-time-machine:navigate:')) return false;
  try {
    const ticket = JSON.parse(page.name.slice('bilibili-time-machine:navigate:'.length));
    const destination = normalizePlaybackUrl(ticket.url);
    const navigation = page.performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
    return destination !== null && navigation?.type !== 'reload' && navigation?.type !== 'back_forward'
      && destination === normalizePlaybackUrl(page.location.href);
  } catch { return false; }
}

export function isAnimationDetailRequest(url: string, page: Window | undefined): boolean {
  if (!page || !isAnimationPlaybackDocument(page.document)) return false;
  try {
    const request = new URL(url, page.location.href);
    if (!/^\/x\/(?:web-interface\/view|player\/pagelist)$/.test(request.pathname)) return false;
    const id = /\/video\/(BV[\da-z]+|av\d+)/i.exec(page.location.pathname)?.[1];
    if (!id) return false;
    return id.startsWith('av') ? request.searchParams.get('aid') === id.slice(2)
      : request.searchParams.get('bvid')?.toLowerCase() === id.toLowerCase();
  } catch { return false; }
}
