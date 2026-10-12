import type { FilterConfig } from '../core/types';
import { devLog, nativeDateLog } from '../core/dev-log';

export interface NativeSearchFilterHandle {
  apply(config: FilterConfig): void;
  destroy(): void;
}

const MIN_DATE = '2009-06-26';

function viewOf(documentRef: Document): Window | null {
  return documentRef.defaultView;
}

function sleep(documentRef: Document, milliseconds: number): Promise<void> {
  const view = viewOf(documentRef);
  return new Promise((resolve) => view?.setTimeout(resolve, milliseconds) ?? resolve());
}

function findText(documentRef: Document, selector: string, text: string): HTMLElement | null {
  return Array.from(documentRef.querySelectorAll<HTMLElement>(selector))
    .find((element) => element.textContent?.trim() === text) ?? null;
}

function click(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  return true;
}

async function waitFor(documentRef: Document, predicate: () => boolean, timeout = 1800): Promise<boolean> {
  if (predicate()) return true;
  const view = viewOf(documentRef);
  if (!view || !documentRef.documentElement) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      if (predicate()) finish(true);
    });
    observer.observe(documentRef.documentElement, { childList: true, subtree: true, attributes: true });
    view.setTimeout(() => finish(predicate()), timeout);
  });
}

function openMoreFilters(documentRef: Document): boolean {
  if (documentRef.querySelector('.search-date-picker')) return true;
  const button = findText(documentRef, 'button', '更多筛选');
  return click(button);
}

async function toggleDateTrigger(documentRef: Document, selector: string): Promise<boolean> {
  const trigger = documentRef.querySelector<HTMLElement>(selector);
  if (!trigger) return false;
  trigger.click();
  await sleep(documentRef, 80);
  if (documentRef.querySelector('[role="dialog"]') && trigger.classList.contains('active')) return true;
  // B 站控件通过 toggleMenu 实现打开/关闭；若第一次点击关闭，第二次才是切换焦点后打开。
  trigger.click();
  return waitFor(documentRef, () => Boolean(documentRef.querySelector('[role="dialog"]')) && trigger.classList.contains('active'), 900);
}

async function chooseYear(documentRef: Document, year: string): Promise<boolean> {
  const picker = documentRef.querySelector<HTMLElement>('.search-date-picker .year-picker');
  if (!click(picker)) return false;
  if (!(await waitFor(documentRef, () => Boolean(findText(documentRef, '.search-date-picker__month-year-overlay .option', year))))) return false;
  return click(findText(documentRef, '.search-date-picker__month-year-overlay .option', year));
}

async function chooseMonth(documentRef: Document, month: number): Promise<boolean> {
  const picker = documentRef.querySelector<HTMLElement>('.search-date-picker .month-picker');
  if (!click(picker)) return false;
  const label = `${month}月`;
  if (!(await waitFor(documentRef, () => Boolean(findText(documentRef, '.search-date-picker__month-year-overlay .option', label))))) return false;
  const option = Array.from(documentRef.querySelectorAll<HTMLElement>('.search-date-picker__month-year-overlay .option'))
    .find((element) => element.textContent?.trim() === label && !element.classList.contains('disabled'));
  return click(option ?? null);
}

async function chooseDate(documentRef: Document, isoDate: string): Promise<boolean> {
  if (!(await chooseYear(documentRef, isoDate.slice(0, 4)))) return false;
  if (!(await chooseMonth(documentRef, Number(isoDate.slice(5, 7))))) return false;
  const selector = `div[role="gridcell"][id="${isoDate}"]`;
  if (!(await waitFor(documentRef, () => Boolean(documentRef.querySelector(selector))))) return false;
  const cell = documentRef.querySelector<HTMLElement>(`${selector} .action-part`)
    ?? documentRef.querySelector<HTMLElement>(selector);
  if (!click(cell)) return false;
  await sleep(documentRef, 120);
  return true;
}

function clearNativeDate(documentRef: Document): void {
  const button = findText(documentRef, 'button', '全部日期');
  click(button);
}

/** 计算截止日当天的 23:59:59 本地时间对应的 Unix 秒（即 B 站 `pubtime_end_s`）。 */
export function cutoffEndSeconds(cutoffMinute: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(cutoffMinute);
  if (!match) return null;
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(23, 59, 59, 0);
  const seconds = Math.trunc(date.getTime() / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

/** B 站日期控件允许的最早日期对应的 Unix 秒。 */
export function nativeStartSeconds(): number {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(2009, 5, 26);
  return Math.trunc(date.getTime() / 1000);
}

function nativeRangeMatches(documentRef: Document, cutoffMinute: string): boolean {
  const location = viewOf(documentRef)?.location;
  if (!location) return false;
  const end = Number(new URL(location.href).searchParams.get('pubtime_end_s'));
  if (!Number.isFinite(end) || end <= 0) return false;
  return cutoffEndSeconds(cutoffMinute) === end;
}

export function createNativeSearchFilter(documentRef: Document = document): NativeSearchFilterHandle {
  let generation = 0;
  let lastKey = '';

  const apply = (config: FilterConfig): void => {
    const key = config.enabled && config.cutoffMinute ? config.cutoffMinute : '';
    if (key === lastKey) return;
    lastKey = key;
    if (__TIME_FILTER_DEV__) {
      const end = key ? cutoffEndSeconds(key) : null;
      devLog.log(nativeDateLog(key || 'none', key ? nativeStartSeconds() : null, end, key ? nativeRangeMatches(documentRef, key) : false));
    }
    const run = ++generation;
    const view = viewOf(documentRef);
    if (!view) return;
    view.setTimeout(async () => {
      if (run !== generation) return;
        if (!(await waitFor(documentRef, () => Boolean(findText(documentRef, 'button', '更多筛选')), 5000))) return;
      if (!key) {
        openMoreFilters(documentRef);
        await sleep(documentRef, 80);
        if (run === generation) clearNativeDate(documentRef);
        return;
      }
      if (nativeRangeMatches(documentRef, key)) return;
      if (!openMoreFilters(documentRef)) return;
      await sleep(documentRef, 80);
      if (run !== generation) return;
      if (!(await toggleDateTrigger(documentRef, '.search-date-picker .date-trigger.start'))) return;
      if (!(await chooseDate(documentRef, MIN_DATE))) return;
      if (run !== generation || !documentRef.querySelector('[role="dialog"]')) return;
      // 第一天选中后控件内部会自动进入结束日期状态；再次点击结束触发器
      // 会把尚未提交的范围重置为 both，导致第二次日期被当作新的开始日期。
      await chooseDate(documentRef, key.slice(0, 10));
    }, 0);
  };

  return { apply, destroy: () => { generation += 1; } };
}

