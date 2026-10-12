/** 页面内的紧凑设置面板；字段与共享 FilterConfig 保持一致。 */

import type { FilterConfig } from '../core/types';

export type FilterPanelConfig = FilterConfig;

export interface FilterPanelOptions {
  config: FilterPanelConfig;
  document?: Document;
  onChange?: (config: FilterPanelConfig) => void | Promise<void>;
}

export interface FilterPanelController {
  readonly element: HTMLElement;
  update(config: FilterPanelConfig): void;
  destroy(): void;
}

const PANEL_ID = 'bilibili-time-filter-panel';

const panelStyle = `
:host {
  all: initial;
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 13px;
  line-height: 1.4;
}
.shell { position: fixed; z-index: 2147483646; top: 72px; right: 16px; color: #18191c; }
.toggle, .card { box-sizing: border-box; border: 1px solid rgba(0,0,0,.12); border-radius: 8px; background: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.16); }
.toggle { cursor: pointer; padding: 7px 10px; color: #00aeec; font: inherit; font-weight: 600; }
.toggle:hover { background: #f1fbff; }
.card { width: 258px; padding: 12px; margin-top: 6px; }
.title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-weight: 600; }
.close { border: 0; background: transparent; color: #6d7579; cursor: pointer; font-size: 18px; line-height: 1; padding: 0 2px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
label { color: #61666d; }
input[type="date"], input[type="time"], input[type="number"] { width: 100%; box-sizing: border-box; border: 1px solid #ccd0d3; border-radius: 6px; padding: 7px 8px; color: #18191c; background: #fff; font: inherit; }
input:focus { outline: 2px solid rgba(0,174,236,.35); border-color: #00aeec; }
.setting-label { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; white-space: nowrap; }
.help { width: 16px; height: 16px; padding: 0; border: 1px solid #b8c0c8; border-radius: 50%; color: #6d7579; background: #fff; cursor: help; font: inherit; font-size: 11px; line-height: 14px; }
#budget { flex: 0 0 72px; width: 72px; }
.field { flex: 1; }
.cutoff-grid { display: grid; grid-template-columns: 1.35fr .9fr; gap: 7px; }
.field-label { display: block; margin: 0 0 4px; color: #6d7579; font-size: 11px; }
.presets { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.preset { border: 1px solid #d9dfe5; border-radius: 999px; padding: 3px 8px; background: #f6f8fa; color: #61666d; cursor: pointer; font: inherit; font-size: 11px; }
.preset:hover { border-color: #00aeec; color: #00aeec; background: #f1fbff; }
.status { min-height: 18px; margin-top: 7px; color: #00aeec; font-size: 11px; }
.switch { position: relative; width: 35px; height: 20px; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.slider { position: absolute; inset: 0; cursor: pointer; border-radius: 12px; background: #c9ccd0; transition: .15s; }
.slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; border-radius: 50%; background: #fff; transition: .15s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch input:checked + .slider { background: #00aeec; }
.switch input:checked + .slider::before { transform: translateX(15px); }
details { margin-top: 9px; border-top: 1px solid #eee; padding-top: 8px; }
summary { cursor: pointer; color: #61666d; }
.hint { margin-top: 7px; color: #9499a0; font-size: 11px; }
`;

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normaliseConfig(config: FilterPanelConfig): FilterPanelConfig {
  return {
    cutoffMinute: config.cutoffMinute || null,
    enabled: Boolean(config.enabled),
    supplementBudget: clampBudget(config.supplementBudget),
    debug: Boolean(config.debug),
    autoAdvance: config.autoAdvance === true,
    autoAdvanceStartedAt: Number.isFinite(config.autoAdvanceStartedAt) ? config.autoAdvanceStartedAt : null,
    autoAdvanceBaseCutoffMinute: config.autoAdvanceBaseCutoffMinute || null,
  };
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimeValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function localDateTimeMinute(date = new Date()): string {
  return `${localDateValue(date)}T${localTimeValue(date)}`;
}

/** 创建面板；同一文档重复调用时会先移除旧面板，保证入口幂等。 */
export function createFilterPanel(options: FilterPanelOptions): FilterPanelController {
  const doc = options.document ?? document;
  doc.getElementById(PANEL_ID)?.remove();

  const host = doc.createElement('div');
  host.id = PANEL_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${panelStyle}</style>
    <div class="shell">
      <button class="toggle" type="button" aria-expanded="false">时光机</button>
      <section class="card" hidden aria-label="B站时光机设置">
        <div class="title"><span>时光机</span><button class="close" type="button" aria-label="关闭">×</button></div>
        <div class="row"><span>截止时间</span><label class="switch" aria-label="启用时光机"><input id="enabled" type="checkbox"><span class="slider"></span></label></div>
        <input id="cutoff" type="hidden">
        <div class="cutoff-grid"><div><label class="field-label" for="cutoff-date">日期</label><input id="cutoff-date" type="date" aria-label="截止日期"></div><div><label class="field-label" for="cutoff-time">时间</label><input id="cutoff-time" type="time" step="1" aria-label="截止时间（含秒）"></div></div>
        <div class="presets" aria-label="快捷时间"><button class="preset" type="button" data-preset="now">现在</button><button class="preset" type="button" data-preset="today">今天</button><button class="preset" type="button" data-preset="yesterday">昨天</button><button class="preset" type="button" data-preset="week">7 天前</button></div>
        <label class="row" style="justify-content:flex-start"><input id="auto-advance" type="checkbox"> 开始自动推进时间</label>
        <div class="status" role="status" aria-live="polite"></div>
        <details>
          <summary>高级设置</summary>
          <div class="row"><span class="setting-label"><span>补请求数量</span><button class="help" type="button" title="当视频卡片缺少发布时间时，额外请求视频详情接口来获取发布时间。" aria-label="补请求数量说明">?</button></span><input id="budget" type="number" min="0" max="100" step="1" inputmode="numeric" aria-label="每页补请求数量"></div>
        </details>
        <div class="hint">只显示发布时间严格早于截止时间的内容。</div>
      </section>
    </div>`;
  doc.documentElement.append(host);

  const toggle = shadow.querySelector<HTMLButtonElement>('.toggle');
  const card = shadow.querySelector<HTMLElement>('.card');
  const close = shadow.querySelector<HTMLButtonElement>('.close');
  const cutoff = shadow.querySelector<HTMLInputElement>('#cutoff');
  const cutoffDate = shadow.querySelector<HTMLInputElement>('#cutoff-date');
  const cutoffTime = shadow.querySelector<HTMLInputElement>('#cutoff-time');
  const status = shadow.querySelector<HTMLElement>('.status');
  const enabled = shadow.querySelector<HTMLInputElement>('#enabled');
  const budget = shadow.querySelector<HTMLInputElement>('#budget');
  const autoAdvance = shadow.querySelector<HTMLInputElement>('#auto-advance');
  if (!toggle || !card || !close || !cutoff || !cutoffDate || !cutoffTime || !status || !enabled || !budget || !autoAdvance) {
    host.remove();
    throw new Error('无法初始化时间过滤设置面板');
  }

  let current = normaliseConfig(options.config);
  const emit = (resetAutoAnchor = false): void => {
    let nextAutoAdvance = autoAdvance.checked;
    if (nextAutoAdvance && (!cutoffDate.value || !cutoffTime.value)) {
      autoAdvance.checked = false;
      nextAutoAdvance = false;
    }
    const autoAdvanceStartedAt = nextAutoAdvance
      ? (resetAutoAnchor || !current.autoAdvance ? Date.now() : current.autoAdvanceStartedAt)
      : null;
    const autoAdvanceBaseCutoffMinute = nextAutoAdvance
      ? (resetAutoAnchor || !current.autoAdvance ? (cutoffDate.value && cutoffTime.value ? `${cutoffDate.value}T${cutoffTime.value}` : null) : current.autoAdvanceBaseCutoffMinute)
      : null;
    current = normaliseConfig({
      cutoffMinute: cutoffDate.value && cutoffTime.value ? `${cutoffDate.value}T${cutoffTime.value}` : null,
      enabled: enabled.checked,
      supplementBudget: Number(budget.value),
      debug: current.debug,
      autoAdvance: nextAutoAdvance,
      autoAdvanceStartedAt,
      autoAdvanceBaseCutoffMinute,
    });
    budget.value = String(current.supplementBudget);
    status.textContent = current.enabled && current.cutoffMinute
      ? `${current.autoAdvance ? '自动推进中：' : '已启用：'}早于 ${current.cutoffMinute.replace('T', ' ')} 的内容`
      : '过滤未启用';
    void options.onChange?.(current);
  };
  const setOpen = (open: boolean): void => {
    card.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  const sync = (config: FilterPanelConfig): void => {
    current = normaliseConfig(config);
    cutoff.value = current.cutoffMinute ?? '';
    enabled.checked = current.enabled;
    budget.value = String(current.supplementBudget);
    const [date = '', time = ''] = (current.cutoffMinute ?? localDateTimeMinute()).split('T');
    cutoffDate.value = date;
    cutoffTime.value = time;
    cutoff.value = current.cutoffMinute ?? '';
    autoAdvance.checked = current.autoAdvance === true;
    status.textContent = current.enabled && current.cutoffMinute
      ? `${current.autoAdvance ? '自动推进中：' : '已启用：'}早于 ${current.cutoffMinute.replace('T', ' ')} 的内容`
      : '过滤未启用';
  };

  toggle.addEventListener('click', () => setOpen(card.hidden));
  close.addEventListener('click', () => setOpen(false));
  cutoffDate.addEventListener('change', () => emit(true));
  cutoffTime.addEventListener('change', () => emit(true));
  enabled.addEventListener('change', () => emit());
  budget.addEventListener('change', () => emit());
  autoAdvance.addEventListener('change', () => emit(true));
  shadow.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      if (preset === 'now') {
        const date = new Date();
        cutoffDate.value = localDateValue(date);
        cutoffTime.value = localTimeValue(date);
      }
      else {
        const date = new Date();
        if (preset === 'yesterday') date.setDate(date.getDate() - 1);
        if (preset === 'week') date.setDate(date.getDate() - 7);
        cutoffDate.value = localDateValue(date);
        cutoffTime.value = '00:00';
      }
      emit(true);
    });
  });
  sync(current);

  return {
    element: host,
    update: sync,
    destroy: () => host.remove(),
  };
}

export { PANEL_ID };

/** 语义更直观的别名，供运行时入口使用。 */
export const mountSettingsPanel = createFilterPanel;
