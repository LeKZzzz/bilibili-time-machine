export interface PlaybackEntry { id: string; title: string; url: string }
export interface AnimationWork { id: string; title: string; entries: PlaybackEntry[] }
export interface PlaybackConfig {
  order: 'round-robin' | 'sequential';
  animationAds: boolean;
  normalAds: boolean;
  intervalMinutes: number;
  works: AnimationWork[];
  ads: PlaybackEntry[];
}
export interface PlaybackProgress {
  cursor: number;
  position: number;
  animationElapsedMs: number;
  normalElapsedMs: number;
  round: number;
  failedEntryIds: string[];
  adBagIds?: string[];
  lastAdId?: string;
  pendingAdMode?: 'animation' | 'normal';
  stopReason?: string;
}
export interface PlaybackData { config: PlaybackConfig; progress: PlaybackProgress }

export function normalizePlaybackUrl(input: string): string | null {
  try {
    const value = input.trim();
    const url = new URL(/^(BV[\w]+|av\d+)$/i.test(value)
      ? `https://www.bilibili.com/video/${value}` : value);
    if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname)
      || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const video = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)\/?$/i);
    const episode = url.pathname.match(/^\/bangumi\/play\/(ep\d+)\/?$/);
    if (!video && !episode) return null;
    const result = new URL(`https://www.bilibili.com/${video ? `video/${video[1]}/` : `bangumi/play/${episode![1]}`}`);
    const part = url.searchParams.get('p');
    if (video && part !== null) {
      if (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part))) return null;
      if (Number(part) !== 1) result.searchParams.set('p', String(Number(part)));
    }
    return result.href;
  } catch { return null; }
}

export function createDefaultPlaybackData(): PlaybackData {
  return {
    config: {
      order: 'round-robin', animationAds: true, normalAds: false, intervalMinutes: 20,
      works: [{ id: 'pig-magic', title: '猪猪侠之魔幻猪猡纪', entries: [1, 2].map(part => ({
        id: `pig-magic-${part}`, title: `第 ${part} 集`,
        url: `https://www.bilibili.com/video/BV1Ex411q7SJ/?p=${part}`,
      })) }, { id: 'happy-hero', title: '开心超人', entries: [1, 2].map(part => ({
        id: `happy-hero-${part}`, title: `开心超人的诞生（${part === 1 ? '上' : '下'}）`,
        url: `https://www.bilibili.com/video/BV1QJfPYQEYg/?p=${part}`,
      })) }],
      ads: [
        { id: 'wash-feet', title: '妈妈，洗脚', url: 'https://www.bilibili.com/video/BV13r4y117HE/' },
        { id: 'care-elders', title: '关爱老人，用心开始', url: 'https://www.bilibili.com/video/BV18s41167NT/' },
      ],
    },
    progress: { cursor: 0, position: 0, animationElapsedMs: 0, normalElapsedMs: 0, round: 0, failedEntryIds: [] },
  };
}

export function playbackQueue(config: PlaybackConfig): PlaybackEntry[] {
  if (config.order === 'sequential') return config.works.flatMap(work => work.entries);
  const result: PlaybackEntry[] = [];
  const length = Math.max(0, ...config.works.map(work => work.entries.length));
  for (let index = 0; index < length; index++) {
    for (const work of config.works) if (work.entries[index]) result.push(work.entries[index]);
  }
  return result;
}

export function normalizePlaybackData(input: unknown): PlaybackData {
  const defaults = createDefaultPlaybackData();
  if (!input || typeof input !== 'object') return defaults;
  const raw = input as Partial<PlaybackData>;
  const config = raw.config;
  const entries = (value: unknown): PlaybackEntry[] => Array.isArray(value)
    ? value.flatMap(entry => {
      if (!entry || typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.url !== 'string') return [];
      const url = normalizePlaybackUrl(entry.url);
      return url ? [{ id: entry.id, title: entry.title, url }] : [];
    }) : [];
  if (config && typeof config === 'object') {
    defaults.config = {
      order: config.order === 'sequential' ? 'sequential' : 'round-robin',
      animationAds: typeof config.animationAds === 'boolean' ? config.animationAds : true,
      normalAds: config.normalAds === true,
      intervalMinutes: Number.isFinite(config.intervalMinutes) && config.intervalMinutes > 0 ? config.intervalMinutes : 20,
      works: Array.isArray(config.works) ? config.works.flatMap(work =>
        work && typeof work.id === 'string' && typeof work.title === 'string'
          ? [{ id: work.id, title: work.title, entries: entries(work.entries) }] : []) : defaults.config.works,
      ads: Array.isArray(config.ads) ? entries(config.ads) : defaults.config.ads,
    };
  }
  const progress = raw.progress;
  if (progress && typeof progress === 'object') {
    for (const key of ['cursor', 'position', 'animationElapsedMs', 'normalElapsedMs', 'round'] as const) {
      const value = progress[key];
      if (Number.isFinite(value) && value >= 0) defaults.progress[key] = value;
    }
    defaults.progress.cursor = Math.floor(defaults.progress.cursor) % (playbackQueue(defaults.config).length || 1);
    defaults.progress.round = Math.floor(defaults.progress.round);
    const ids = new Set(playbackQueue(defaults.config).map(entry => entry.id));
    defaults.progress.failedEntryIds = Array.isArray(progress.failedEntryIds)
      ? progress.failedEntryIds.filter(id => typeof id === 'string' && ids.has(id)) : [];
    const adIds = new Set(defaults.config.ads.map(entry => entry.id));
    defaults.progress.adBagIds = Array.isArray(progress.adBagIds)
      ? [...new Set(progress.adBagIds.filter(id => typeof id === 'string' && adIds.has(id)))] : [];
    defaults.progress.lastAdId = typeof progress.lastAdId === 'string' ? progress.lastAdId : '';
    if (progress.pendingAdMode === 'animation' || progress.pendingAdMode === 'normal') defaults.progress.pendingAdMode = progress.pendingAdMode;
    if (typeof progress.stopReason === 'string') defaults.progress.stopReason = progress.stopReason;
  }
  return defaults;
}
