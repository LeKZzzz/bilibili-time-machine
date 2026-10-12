/** 解析搜索卡片展示的日期；只作为补请求失败时的日期级兜底。 */
export function parseDisplayedCardDate(text: string | null | undefined, now = new Date()): { timestamp: number; dateOnly: true } | null {
  if (!text) return null;
  const value = text.replace(/^\s*[·•]\s*/, '').trim();
  let date: Date | null = null;
  let dateOnly = true;
  let match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
  if (match) date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!date) {
    match = /^(\d{1,2})月(\d{1,2})日$/.exec(value);
    if (match) {
      date = new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
      if (date.getTime() > now.getTime() + 86400000) date.setFullYear(date.getFullYear() - 1);
    }
  }
  if (!date) {
    match = /^(\d+)天前$/.exec(value);
    if (match) { date = new Date(now.getTime() - Number(match[1]) * 86400000); dateOnly = true; }
  }
  if (!date) {
    match = /^(\d+)小时前$/.exec(value);
    if (match) { date = new Date(now.getTime() - Number(match[1]) * 3600000); dateOnly = true; }
  }
  if (!date && value === '昨天') { date = new Date(now.getTime() - 86400000); dateOnly = true; }
  if (!date && value === '今天') { date = new Date(now); dateOnly = true; }
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return { timestamp: Math.trunc(date.getTime() / 1000), dateOnly };
}
