/** B 站页面路由识别。这里只判断明确支持的主机和路径，不猜测未知页面。 */

export interface LocationLike {
  hostname?: string;
  host?: string;
  pathname?: string;
  href?: string;
}

export type SupportedRouteKind = 'video' | 'home' | 'partition' | 'search' | 'space-videos' | 'dynamic';

export interface RouteMatch {
  supported: boolean;
  installHook: boolean;
  kind: SupportedRouteKind | 'unsupported';
  host: string;
  path: string;
}

const SUPPORTED_HOSTS = new Set(['www.bilibili.com', 'search.bilibili.com', 'space.bilibili.com', 't.bilibili.com']);
const VIDEO_PATH = /^\/video\/(?:av\d+|bv[0-9a-z]+)(?:\/|$)/i;
const SPACE_VIDEO_PATH = /^\/[^/]+\/video(?:\/|$)/i;
const SPACE_DYNAMIC_PATH = /^\/[^/]+\/dynamic(?:\/|$)/i;
const PARTITION_PATH = /^\/(?:v|channel)(?:\/|$)/i;

function readHost(location: LocationLike): string {
  if (typeof location.hostname === 'string' && location.hostname) return location.hostname.toLowerCase();
  if (typeof location.host === 'string' && location.host) return location.host.split(':')[0].toLowerCase();
  if (typeof location.href === 'string') {
    try {
      return new URL(location.href).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return '';
}

function readPath(location: LocationLike): string {
  if (typeof location.pathname === 'string' && location.pathname) return location.pathname;
  if (typeof location.href === 'string') {
    try {
      return new URL(location.href).pathname;
    } catch {
      return '';
    }
  }
  return '';
}

export function matchSupportedRoute(location: LocationLike): RouteMatch {
  const host = readHost(location);
  const path = readPath(location) || '/';
  if (!SUPPORTED_HOSTS.has(host)) return { supported: false, installHook: false, kind: 'unsupported', host, path };

  let kind: SupportedRouteKind | null = null;
  if (host === 'www.bilibili.com') {
    if (VIDEO_PATH.test(path)) kind = 'video';
    else if (path === '/' || path === '/index.html' || path === '/index.htm') kind = 'home';
    else if (PARTITION_PATH.test(path)) kind = 'partition';
  } else if (host === 'search.bilibili.com') {
    if (path === '/' || path === '/search' || path === '/all') kind = 'search';
  } else if (host === 'space.bilibili.com' && SPACE_VIDEO_PATH.test(path)) {
    kind = 'space-videos';
  } else if (host === 'space.bilibili.com' && SPACE_DYNAMIC_PATH.test(path)) {
    kind = 'dynamic';
  } else if (host === 't.bilibili.com' && (path === '/' || path === '/dynamic' || path.startsWith('/dynamic/'))) {
    kind = 'dynamic';
  }

  if (!kind) return { supported: false, installHook: false, kind: 'unsupported', host, path };
  return { supported: true, installHook: true, kind, host, path };
}

export const isSupportedRoute = (location: LocationLike): boolean => matchSupportedRoute(location).supported;

