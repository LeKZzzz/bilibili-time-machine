import {
  normalizePlaybackUrl,
  type AnimationWork,
  type PlaybackEntry,
} from './model';
import type { ResolvedPlaybackSource } from './source';

interface SeedSource {
  url: string;
  seedUrls: Set<string>;
}

function normalizedSeedUrl(url: string): string | null {
  return normalizePlaybackUrl(url);
}

function sourceFor(url: string): { key: string; url: string } | null {
  const normalized = normalizedSeedUrl(url);
  if (!normalized) return null;
  const source = new URL(normalized);
  source.searchParams.delete('p');
  return { key: source.href, url: source.href };
}

function resolvedEntryId(workId: string, sourceEntryId: string, usedIds: Set<string>): string {
  const base = `${workId}-resolved-${sourceEntryId}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) id = `${base}-${suffix++}`;
  usedIds.add(id);
  return id;
}

export function sameCatalogWork(left: AnimationWork, right: AnimationWork): boolean {
  if (left.id !== right.id || left.title !== right.title || left.sourceStatus !== right.sourceStatus
    || left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    const url = normalizedSeedUrl(entry.url);
    return entry.id === other.id && entry.title === other.title && url !== null && url === normalizedSeedUrl(other.url);
  });
}

export async function resolveCatalogWork(
  work: AnimationWork,
  resolveSource: (url: string) => Promise<ResolvedPlaybackSource>,
): Promise<AnimationWork> {
  if (work.sourceStatus === 'resolved' || work.sourceStatus === 'failed' || work.sourceStatus === 'manual') return work;

  try {
    const sources = new Map<string, SeedSource>();
    for (const entry of work.entries) {
      const source = sourceFor(entry.url);
      if (!source) throw new Error('作品条目包含无效片源');
      const normalizedUrl = normalizedSeedUrl(entry.url)!;
      const group = sources.get(source.key) ?? { url: source.url, seedUrls: new Set<string>() };
      group.seedUrls.add(normalizedUrl);
      sources.set(source.key, group);
    }
    if (!sources.size) throw new Error('作品没有可解析的片源');

    const resolvedUrls = new Set<string>();
    const resolvedEntries: Array<{ id: string; title: string; url: string }> = [];
    for (const source of sources.values()) {
      if ([...source.seedUrls].every(url => resolvedUrls.has(url))) continue;
      const result = await resolveSource(source.url);
      if (!result.entries.length) {
        throw new Error('片源解析结果为空');
      }
      for (const entry of result.entries) {
        const url = normalizePlaybackUrl(entry.url);
        if (!url) throw new Error('片源解析结果包含无效链接');
        resolvedUrls.add(url);
        resolvedEntries.push({ id: entry.id, title: entry.title, url });
      }
    }

    const usedIds = new Set(work.entries.map(entry => entry.id));
    const seedByUrl = new Map<string, PlaybackEntry>();
    for (const entry of work.entries) {
      const url = normalizedSeedUrl(entry.url);
      if (!url) throw new Error('作品条目包含无效片源');
      if (!seedByUrl.has(url)) seedByUrl.set(url, entry);
    }
    const output: PlaybackEntry[] = [];
    const outputUrls = new Set<string>();
    for (const entry of resolvedEntries) {
      if (outputUrls.has(entry.url)) continue;
      outputUrls.add(entry.url);
      const seed = seedByUrl.get(entry.url);
      output.push(seed ?? {
        id: resolvedEntryId(work.id, entry.id, usedIds),
        title: entry.title,
        url: entry.url,
      });
    }
    for (const [url, entry] of seedByUrl) {
      if (outputUrls.has(url)) continue;
      outputUrls.add(url);
      output.push(entry);
    }
    return { ...work, entries: output, sourceStatus: 'resolved' };
  } catch {
    return { ...work, sourceStatus: 'failed' };
  }
}
