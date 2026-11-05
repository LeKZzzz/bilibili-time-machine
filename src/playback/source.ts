import { normalizePlaybackUrl, type PlaybackEntry } from './model';

export interface ResolvedPlaybackSource {
  title: string;
  kind: 'parts' | 'collection' | 'season' | 'single';
  entries: PlaybackEntry[];
}

type JsonRecord = Record<string, unknown>;
type RequestJson = (url: string) => Promise<unknown>;

const VIDEO_API = 'https://api.bilibili.com/x/web-interface/view';
const SEASON_API = 'https://api.bilibili.com/pgc/view/web/season';
const BILI_HOSTS = new Set(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com']);

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function videoId(value: unknown): string | null {
  const id = text(value);
  return /^(?:BV[\w]{10}|av\d+)$/i.test(id) ? id : null;
}

function sourceInput(input: string): { videoId: string } | { epId: number } | { seasonId: number } {
  const normalized = normalizePlaybackUrl(input);
  if (normalized) {
    const url = new URL(normalized);
    const videoMatch = url.pathname.match(/^\/video\/(BV[\w]{10}|av\d+)\/$/i);
    if (videoMatch) return { videoId: videoMatch[1] };
    const episodeMatch = url.pathname.match(/^\/bangumi\/play\/ep(\d+)$/);
    if (episodeMatch) {
      const epId = positiveInteger(episodeMatch[1]);
      if (epId) return { epId };
    }
  }

  const value = input.trim();
  const bareSeason = value.match(/^ss(\d+)$/i);
  if (bareSeason) {
    const seasonId = positiveInteger(bareSeason[1]);
    if (seasonId) return { seasonId };
  }

  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && BILI_HOSTS.has(url.hostname)
      && !url.username && !url.password) {
      const seasonMatch = url.pathname.match(/^\/bangumi\/play\/ss(\d+)\/?$/i);
      if (seasonMatch) {
        const seasonId = positiveInteger(seasonMatch[1]);
        if (seasonId) return { seasonId };
      }
    }
  } catch {
    // 无效链接统一由下方错误提示处理。
  }

  throw new Error('请输入有效的 B 站视频、番剧或合集链接');
}

function assertApiSuccess(value: unknown, label: string): JsonRecord {
  const response = record(value);
  if (!response || response.code !== 0) {
    const code = response?.code;
    const message = text(response?.message) || text(response?.msg);
    throw new Error(`B站${label}接口返回错误（${String(code ?? '未知')}）${message ? `：${message}` : ''}`);
  }
  return response;
}

function canonicalEntry(id: string, title: string, url: string): PlaybackEntry | null {
  const normalizedUrl = normalizePlaybackUrl(url);
  const normalizedTitle = title.trim();
  if (!normalizedUrl || !normalizedTitle) return null;
  return { id, title: normalizedTitle, url: normalizedUrl };
}

function uniqueEntries(entries: Array<PlaybackEntry | null>): PlaybackEntry[] {
  const seen = new Set<string>();
  const result: PlaybackEntry[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    result.push(entry);
  }
  return result;
}

function requireTitle(value: unknown, message: string): string {
  const title = text(value);
  if (!title) throw new Error(message);
  return title;
}

function apiUrl(endpoint: string, key: string, value: string | number): string {
  const url = new URL(endpoint);
  url.searchParams.set(key, String(value));
  return url.href;
}

async function resolveVideo(
  sourceId: string,
  requestJson: RequestJson,
): Promise<ResolvedPlaybackSource> {
  const isBvid = /^BV/i.test(sourceId);
  const response = assertApiSuccess(
    await requestJson(apiUrl(VIDEO_API, isBvid ? 'bvid' : 'aid', isBvid ? sourceId : sourceId.slice(2))),
    '视频',
  );
  const data = record(response.data);
  if (!data) throw new Error('B站视频接口未返回视频数据');

  const title = requireTitle(data.title, 'B站视频接口未返回作品标题');
  const pages = Array.isArray(data.pages)
    ? data.pages.map(record).filter((page): page is JsonRecord => page !== null)
    : [];
  if (!pages.length) throw new Error('B站视频详情未包含有效分P');

  const responseId = videoId(data.bvid)
    ?? (positiveInteger(data.aid) ? `av${positiveInteger(data.aid)}` : null);
  const stableVideoId = responseId ?? sourceId;
  const pageRecords = pages
    .map(page => ({ page, number: positiveInteger(page.page) }))
    .filter((item): item is { page: JsonRecord; number: number } => item.number !== null)
    .sort((a, b) => a.number - b.number);

  if (pageRecords.length > 1) {
    const entries = uniqueEntries(pageRecords.map(({ page, number }) => {
      const partTitle = text(page.part);
      const url = `https://www.bilibili.com/video/${stableVideoId}/${number === 1 ? '' : `?p=${number}`}`;
      return canonicalEntry(`${stableVideoId}-p${number}`, partTitle, url);
    }));
    if (!entries.length) throw new Error('B站视频分P中没有有效条目');
    return { title, kind: 'parts', entries };
  }

  const ugcSeason = record(data.ugc_season);
  const sections = Array.isArray(ugcSeason?.sections) ? ugcSeason.sections : [];
  if (sections.length) {
    const collectionEntries: Array<PlaybackEntry | null> = [];
    for (const sectionValue of sections) {
      const section = record(sectionValue);
      const episodes = Array.isArray(section?.episodes) ? section.episodes : [];
      for (const episodeValue of episodes) {
        const episode = record(episodeValue);
        if (!episode) continue;
        const arc = record(episode.arc);
        const page = record(episode.page);
        const episodeAid = positiveInteger(episode.aid);
        const arcAid = positiveInteger(arc?.aid);
        const episodeId = videoId(episode.bvid) ?? videoId(arc?.bvid)
          ?? (episodeAid ? `av${episodeAid}` : null)
          ?? (arcAid ? `av${arcAid}` : null);
        if (!episodeId) continue;
        const episodeTitle = text(episode.title) || text(page?.part) || text(arc?.title);
        collectionEntries.push(canonicalEntry(
          episodeId,
          episodeTitle,
          `https://www.bilibili.com/video/${episodeId}/`,
        ));
      }
    }
    const entries = uniqueEntries(collectionEntries);
    if (!entries.length) throw new Error('B站合集没有有效分集');
    return {
      title: text(ugcSeason?.title) || title,
      kind: 'collection',
      entries,
    };
  }

  const page = pageRecords[0];
  if (!page) throw new Error('B站视频详情未包含有效分P');
  const pageTitle = text(page.page.part) || title;
  const url = `https://www.bilibili.com/video/${stableVideoId}/`;
  const entry = canonicalEntry(`${stableVideoId}-p${page.number}`, pageTitle, url);
  if (!entry) throw new Error('B站视频没有有效播放条目');
  return { title, kind: 'single', entries: [entry] };
}

async function resolveSeason(
  parameter: 'ep_id' | 'season_id',
  id: number,
  requestJson: RequestJson,
): Promise<ResolvedPlaybackSource> {
  const response = assertApiSuccess(
    await requestJson(apiUrl(SEASON_API, parameter, id)),
    '番剧',
  );
  const result = record(response.result);
  if (!result) throw new Error('B站番剧接口未返回剧集数据');
  const title = requireTitle(result.title, 'B站番剧接口未返回作品标题');
  const episodes = Array.isArray(result.episodes) ? result.episodes : [];
  const entries = uniqueEntries(episodes.map(value => {
    const episode = record(value);
    const episodeId = positiveInteger(episode?.id) ?? positiveInteger(episode?.ep_id);
    if (!episode || !episodeId) return null;
    const episodeTitle = text(episode.long_title) || text(episode.title);
    return canonicalEntry(`ep${episodeId}`, episodeTitle, `https://www.bilibili.com/bangumi/play/ep${episodeId}`);
  }));
  if (!entries.length) throw new Error('B站番剧没有有效正片分集');
  return { title, kind: 'season', entries };
}

/** 用户导入与内置补全共用的 BV／av 分 P、UGC 合集及 ep／ss 正片分集元数据解析。 */
export async function resolvePlaybackSource(
  input: string,
  requestJson: RequestJson,
): Promise<ResolvedPlaybackSource> {
  const source = sourceInput(input);
  if ('videoId' in source) return resolveVideo(source.videoId, requestJson);
  if ('epId' in source) return resolveSeason('ep_id', source.epId, requestJson);
  return resolveSeason('season_id', source.seasonId, requestJson);
}
