import { getCutoffSeconds, parseValidatedUnixSeconds, type TimeValidationOptions } from './time';
import type { DanmakuFilterResult, DanmakuRecord } from './types';

export interface DanmakuFilterOptions extends TimeValidationOptions {
  enabled?: boolean;
}

interface ParsedTag {
  full: string;
  attributes: string;
  body: string;
  start: number;
  end: number;
}

function readAttribute(attributes: string, name: string): string | null {
  const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = expression.exec(attributes);
  return match ? match[1] ?? match[2] ?? null : null;
}

function extractTags(xml: string): { tags: ParsedTag[]; valid: boolean } {
  const tags: ParsedTag[] = [];
  const expression = /<d\b([^>]*)>([\s\S]*?)<\/d\s*>|<d\b([^>]*)\/>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(xml))) {
    tags.push({
      full: match[0],
      attributes: match[1] ?? match[3] ?? '',
      body: match[2] ?? '',
      start: match.index,
      end: expression.lastIndex,
    });
  }
  // 任意未闭合的 d 标签都使当前响应不可验证，不能放行原始 XML。
  const starts = (xml.match(/<d\b/gi) ?? []).length;
  const closes = (xml.match(/<\/d\s*>/gi) ?? []).length;
  const selfClosing = (xml.match(/<d\b[^>]*\/\s*>/gi) ?? []).length;
  const valid = starts === tags.length + (selfClosing - tags.filter((tag) => /\/\s*>$/.test(tag.full)).length)
    && closes === tags.filter((tag) => !/\/\s*>$/.test(tag.full)).length;
  return { tags, valid };
}

function hasMalformedMarkup(xml: string): boolean {
  const trimmed = xml.trim();
  if (!trimmed) return true;
  // 允许带或不带 XML 声明；声明本身只用于格式检查。
  const withoutDeclaration = trimmed.replace(/^<\?xml\s+[\s\S]*?\?>\s*/i, '');
  if (!/^<i\b[^>]*>/i.test(withoutDeclaration)) return true;
  if (!/<\/i\s*>$/i.test(withoutDeclaration)) return true;
  if (/<(?:d|i)\b[^>]*</i.test(withoutDeclaration)) return true;
  let quote: string | null = null;
  // 只检查标签文本中的引号；弹幕正文可以合法包含撇号或引号。
  const tagTexts = withoutDeclaration.match(/<[^>]*>/g) ?? [];
  for (const text of tagTexts) {
    for (const char of text) {
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
    }
  }
  return quote !== null;
}

/** 读取 XML 中所有 `<d>` 记录；任何一条结构或时间字段异常均判定为失败。 */
export function parseDanmakuXml(
  xml: unknown,
  options: TimeValidationOptions = {},
): { ok: true; records: DanmakuRecord[] } | { ok: false; records: []; reason: 'invalid-xml' | 'invalid-time' | 'empty' } {
  if (typeof xml !== 'string' || xml.trim() === '') return { ok: false, records: [], reason: 'empty' };
  if (hasMalformedMarkup(xml)) return { ok: false, records: [], reason: 'invalid-xml' };
  const extracted = extractTags(xml);
  if (!extracted.valid || extracted.tags.length === 0) {
    return { ok: false, records: [], reason: extracted.valid ? 'empty' : 'invalid-xml' };
  }
  const records: DanmakuRecord[] = [];
  for (const tag of extracted.tags) {
    const value = readAttribute(tag.attributes, 'p');
    const fields = value?.split(',') ?? [];
    if (!value || fields.length < 5) return { ok: false, records: [], reason: 'invalid-time' };
    const timestamp = parseValidatedUnixSeconds(fields[4], options);
    if (timestamp === null) return { ok: false, records: [], reason: 'invalid-time' };
    records.push({ raw: tag.body, attributes: tag.attributes, fields, timestamp });
  }
  return { ok: true, records };
}

/**
 * 过滤 XML 弹幕。解析失败时 xml 为空，调用方必须把该响应当作丢弃，
 * 不得把输入 XML 原样交给播放器。
 */
export function filterDanmakuXml(
  xml: unknown,
  cutoff: number | string | null | undefined,
  options: DanmakuFilterOptions = {},
): DanmakuFilterResult {
  if (options.enabled === false || cutoff === null || cutoff === undefined || cutoff === '') {
    // 未启用时是完全旁路：不解析、不重编码，也不因当前数据形态改变页面行为。
    return { ok: true, xml: typeof xml === 'string' ? xml : '', records: [], hiddenCount: 0 };
  }
  const parsed = parseDanmakuXml(xml, options);
  if (!parsed.ok) return { ok: false, xml: '', records: [], hiddenCount: 0, reason: parsed.reason };
  const cutoffSeconds = getCutoffSeconds(cutoff);
  if (cutoffSeconds === null) return { ok: false, xml: '', records: [], hiddenCount: parsed.records.length, reason: 'invalid-time' };

  const extracted = extractTags(String(xml)).tags;
  const kept: DanmakuRecord[] = [];
  let hiddenCount = 0;
  let cursor = 0;
  let output = '';
  for (let i = 0; i < extracted.length; i += 1) {
    const tag = extracted[i];
    output += String(xml).slice(cursor, tag.start);
    const record = parsed.records[i];
    if (record.timestamp !== null && record.timestamp < cutoffSeconds) {
      output += tag.full;
      kept.push(record);
    } else {
      hiddenCount += 1;
    }
    cursor = tag.end;
  }
  output += String(xml).slice(cursor);
  return { ok: true, xml: output, records: kept, hiddenCount };
}

export const filterDanmaku = filterDanmakuXml;
export const filterXmlDanmaku = filterDanmakuXml;
export const parseAndFilterDanmakuXml = filterDanmakuXml;
