/** 页面内的紧凑设置面板；字段与共享 FilterConfig 保持一致。 */

import type { FavoriteFolderOption, FilterConfig } from '../core/types';
import type { FavoriteTagScore } from '../core/favorite-home-fill';
import { parseLocalMinute } from '../core/time';
import type { FavoriteHomeFillState } from '../runtime/favorite-home-fill-controller';
import panelStyle from './panel.css?inline';

export type FilterPanelConfig = FilterConfig;

export interface FilterPanelOptions {
  config: FilterPanelConfig;
  document?: Document;
  onChange?: (config: FilterPanelConfig) => void | Promise<void>;
  onFavoriteFoldersRefresh?: (force?: boolean, isActive?: () => boolean) => Promise<FavoriteFolderOption[]>;
  onFavoriteContinue?: () => void | Promise<void>;
  onFavoriteTagsLoad?: () => Promise<FavoriteTagScore[]>;
}

export interface FilterPanelController {
  readonly element: HTMLElement;
  update(config: FilterPanelConfig): void;
  updateFavoriteState(state: FavoriteHomeFillState): void;
  destroy(): void;
}

const PANEL_ID = 'bilibili-time-filter-panel';

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
    favoriteHomeFillEnabled: config.favoriteHomeFillEnabled === true,
    favoriteFolderIds: Array.isArray(config.favoriteFolderIds) ? config.favoriteFolderIds.filter(Boolean).slice(0, 10) : [],
    favoriteFolderLimit: Math.min(10, Math.max(1, Math.round(config.favoriteFolderLimit ?? 3))),
    favoriteVideoLimit: Math.min(200, Math.max(1, Math.round(config.favoriteVideoLimit ?? 50))),
    favoriteRefreshRequestedAt: Number.isFinite(config.favoriteRefreshRequestedAt) ? config.favoriteRefreshRequestedAt : null,
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
      <button class="toggle ui-btn ui-btn-sm" type="button" aria-expanded="false">时光机</button>
      <section class="card" hidden aria-label="B站时光机设置">
        <div id="main-view" class="panel-view">
          <header class="title">
            <div><div class="brand">时光机</div><div class="subtitle">只看截止时间之前的内容</div></div>
            <div class="heading-actions"><span id="filter-state" class="state ui-badge" role="status"></span><button class="close ui-btn ui-btn-ghost ui-btn-xs" type="button" aria-label="关闭设置面板">×</button></div>
          </header>
          <div class="panel-body">
            <section class="section" aria-label="时间设置">
              <div class="row"><span class="section-label">截止时间<span class="description">本地时间 · 精确到秒</span></span><input id="enabled" type="checkbox" hidden><button id="filter-control" class="filter-control ui-btn ui-btn-sm" type="button"></button></div>
              <input id="cutoff" type="hidden">
              <div class="cutoff-grid">
                <div class="field"><label class="field-label" for="cutoff-date">日期</label><input id="cutoff-date" class="ui-input ui-input-sm" type="date" aria-label="截止日期"></div>
                <div class="field"><label class="field-label" for="cutoff-time">时间</label><input id="cutoff-time" class="ui-input ui-input-sm" type="time" step="1" aria-label="截止时间（含秒）"></div>
              </div>
              <div class="presets" aria-label="快捷时间"><button class="preset ui-btn ui-btn-xs" type="button" data-preset="now">现在</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="today">今天</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="yesterday">昨天</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="week">7 天前</button><button id="fill-current-time" class="time-fill preset ui-btn ui-btn-xs" type="button" aria-label="填入当前时分秒，保留已选日期">填入当前时间</button></div>
              <div class="time-actions"><span id="time-draft-status" role="status" aria-live="polite"></span><button id="time-cancel" class="ui-btn ui-btn-ghost ui-btn-sm" type="button">取消</button><button id="time-apply" class="ui-btn ui-btn-primary ui-btn-sm" type="button">应用时间</button></div>
              <label class="row"><span>自动推进时间<span class="description" style="display:block">每经过 1 分钟，截止时间推进 1 分钟</span></span><input id="auto-advance" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
            </section>
            <section class="favorite section" aria-label="收藏标签补位">
              <div class="row"><span class="setting-label section-label"><label for="favorite-enabled">收藏偏好补充首页</label><button class="help" type="button" data-help="favorite-enabled" aria-label="收藏补位说明">?</button></span><input id="favorite-enabled" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox" aria-label="启用收藏标签首页补位"></div>
              <div class="description favorite-description">根据收藏偏好，填补首页被过滤的空位</div>
              <div id="favorite-content" hidden>
                <div class="favorite-summary row"><span id="favorite-selection-summary" class="favorite-folder-status"></span><span class="setting-label"><button id="favorite-folders-open" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">选择收藏夹</button><button class="help" type="button" data-help="favorite-selection" aria-label="收藏夹选择说明">?</button></span></div>
                <div id="favorite-work-status" class="work-status" role="status" aria-live="polite"></div>
                <div id="favorite-snapshot" class="favorite-snapshot description"><span id="favorite-counts"></span><time id="favorite-updated"></time></div>
                <button id="favorite-next" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm" hidden></button>
                <div class="favorite-actions">
                  <span id="favorite-continue-action" class="setting-label"><button id="favorite-continue" type="button" class="ui-btn ui-btn-sm">继续寻找</button><button class="help" type="button" data-help="favorite-continue" aria-label="继续寻找的用途">?</button></span>
                  <span class="setting-label"><button id="favorite-tags" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">查看兴趣标签</button><button class="help" type="button" data-help="favorite-tags" aria-label="当前收藏标签说明">?</button></span>
                  <span class="setting-label favorite-refresh-action"><button id="favorite-refresh" type="button" class="ui-btn ui-btn-sm">更新收藏偏好</button><button class="help" type="button" data-help="favorite-refresh" aria-label="更新收藏偏好说明">?</button></span>
                </div>
              </div>
            </section>
            <details class="advanced section">
              <summary>高级设置</summary>
              <div class="row"><label for="budget">补请求数量上限<span class="description" style="display:block">卡片缺少发布时间时，补查视频详情</span></label><input id="budget" class="ui-input ui-input-sm" type="number" min="0" max="100" step="1" inputmode="numeric" aria-label="每页补请求数量"></div>
            </details>
          </div>
          <footer class="panel-footer"><div class="status" role="status" aria-live="polite"></div><div class="hint">仅保留严格早于截止时间的内容</div></footer>
        </div>
        <section id="favorite-folders-dialog" class="tag-dialog panel-view" role="region" aria-labelledby="favorite-folders-title" hidden>
          <header class="tag-dialog-title"><div><div id="favorite-folders-title" class="brand">管理收藏夹</div><div class="subtitle">保存后生效；返回不保存本次调整</div></div><button id="favorite-folders-close" class="text-button ui-btn ui-btn-ghost ui-btn-sm" type="button" aria-label="取消并返回设置">返回</button></header>
          <div class="dialog-body">
            <div class="row"><span id="favorite-folders-count" class="tag-dialog-status" role="status" aria-live="polite"></span><button class="help" type="button" data-help="favorite-selection" aria-label="收藏夹选择数量说明">?</button></div>
            <div id="favorite-folders" class="folder-list" role="group" aria-label="可选收藏夹"></div>
            <div class="setting-label"><button id="favorite-folders-refresh" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">同步收藏夹名称</button><button class="help" type="button" data-help="favorite-list-cache" aria-label="收藏夹列表缓存与刷新说明">?</button></div>
            <div class="description">新建、删除或重命名收藏夹后，同步名称列表。</div>
            <div class="favorite-folder-status" id="favorite-folder-status" role="status" aria-live="polite"></div>
            <div class="folder-controls">
              <div class="row"><span class="setting-label"><label for="favorite-folder-limit">收藏夹数量上限</label><button class="help" type="button" data-help="favorite-folder-limit" aria-label="收藏夹数量上限说明">?</button></span><input id="favorite-folder-limit" class="ui-input ui-input-sm" type="number" min="1" max="10" step="1" aria-label="收藏夹数量上限"></div>
              <div class="row"><span class="setting-label"><label for="favorite-video-limit">每夹视频上限</label><button class="help" type="button" data-help="favorite-video-limit" aria-label="每夹视频上限说明">?</button></span><input id="favorite-video-limit" class="ui-input ui-input-sm" type="number" min="1" max="200" step="1" aria-label="每夹视频上限"></div>
            </div>
            <div id="favorite-folders-validation" class="validation" role="status" aria-live="polite"></div>
          </div>
          <footer class="dialog-actions"><button id="favorite-folders-cancel" type="button" class="ui-btn ui-btn-sm">取消</button><button id="favorite-folders-save" type="button" class="ui-btn ui-btn-primary ui-btn-sm">保存</button></footer>
        </section>
        <section id="favorite-tags-dialog" class="tag-dialog panel-view" role="region" aria-labelledby="favorite-tags-title" hidden>
          <header class="tag-dialog-title"><span id="favorite-tags-title" class="brand">当前收藏标签</span><button id="favorite-tags-close" class="text-button ui-btn ui-btn-ghost ui-btn-sm" type="button" aria-label="返回设置">返回</button></header>
          <div class="dialog-body"><div id="favorite-tags-status" class="tag-dialog-status" role="status" aria-live="polite"></div><ol id="favorite-tags-list" class="tag-list"></ol></div>
        </section>
      </section>
      <div id="setting-tooltip" class="tooltip" role="tooltip" hidden></div>
    </div>`;
  doc.documentElement.append(host);

  const toggle = shadow.querySelector<HTMLButtonElement>('.toggle');
  const card = shadow.querySelector<HTMLElement>('.card');
  const close = shadow.querySelector<HTMLButtonElement>('.close');
  const mainView = shadow.querySelector<HTMLElement>('#main-view');
  const filterState = shadow.querySelector<HTMLElement>('#filter-state');
  const cutoff = shadow.querySelector<HTMLInputElement>('#cutoff');
  const cutoffDate = shadow.querySelector<HTMLInputElement>('#cutoff-date');
  const cutoffTime = shadow.querySelector<HTMLInputElement>('#cutoff-time');
  const fillCurrentTime = shadow.querySelector<HTMLButtonElement>('#fill-current-time');
  const status = shadow.querySelector<HTMLElement>('.status');
  const hint = shadow.querySelector<HTMLElement>('.panel-footer .hint');
  const favoriteFolderStatus = shadow.querySelector<HTMLElement>('#favorite-folder-status');
  const enabled = shadow.querySelector<HTMLInputElement>('#enabled');
  const budget = shadow.querySelector<HTMLInputElement>('#budget');
  const autoAdvance = shadow.querySelector<HTMLInputElement>('#auto-advance');
  const favoriteEnabled = shadow.querySelector<HTMLInputElement>('#favorite-enabled');
  const favoriteContent = shadow.querySelector<HTMLElement>('#favorite-content');
  const favoriteFolders = shadow.querySelector<HTMLElement>('#favorite-folders');
  const favoriteFoldersOpen = shadow.querySelector<HTMLButtonElement>('#favorite-folders-open');
  const favoriteFoldersDialog = shadow.querySelector<HTMLElement>('#favorite-folders-dialog');
  const favoriteFoldersClose = shadow.querySelector<HTMLButtonElement>('#favorite-folders-close');
  const favoriteFoldersCancel = shadow.querySelector<HTMLButtonElement>('#favorite-folders-cancel');
  const favoriteFoldersSave = shadow.querySelector<HTMLButtonElement>('#favorite-folders-save');
  const favoriteFoldersCount = shadow.querySelector<HTMLElement>('#favorite-folders-count');
  const favoriteFoldersValidation = shadow.querySelector<HTMLElement>('#favorite-folders-validation');
  const favoriteSelectionSummary = shadow.querySelector<HTMLElement>('#favorite-selection-summary');
  const favoriteFoldersRefresh = shadow.querySelector<HTMLButtonElement>('#favorite-folders-refresh');
  const favoriteFolderLimit = shadow.querySelector<HTMLInputElement>('#favorite-folder-limit');
  const favoriteVideoLimit = shadow.querySelector<HTMLInputElement>('#favorite-video-limit');
  const favoriteRefresh = shadow.querySelector<HTMLButtonElement>('#favorite-refresh');
  const favoriteTags = shadow.querySelector<HTMLButtonElement>('#favorite-tags');
  const favoriteTagsDialog = shadow.querySelector<HTMLElement>('#favorite-tags-dialog');
  const favoriteTagsClose = shadow.querySelector<HTMLButtonElement>('#favorite-tags-close');
  const favoriteTagsStatus = shadow.querySelector<HTMLElement>('#favorite-tags-status');
  const favoriteTagsList = shadow.querySelector<HTMLOListElement>('#favorite-tags-list');
  const tooltip = shadow.querySelector<HTMLElement>('#setting-tooltip');
  if (!toggle || !card || !close || !mainView || !filterState || !cutoff || !cutoffDate || !cutoffTime || !fillCurrentTime || !status || !hint || !favoriteFolderStatus || !enabled || !budget || !autoAdvance || !favoriteEnabled || !favoriteContent || !favoriteFolders || !favoriteFoldersOpen || !favoriteFoldersDialog || !favoriteFoldersClose || !favoriteFoldersCancel || !favoriteFoldersSave || !favoriteFoldersCount || !favoriteFoldersValidation || !favoriteSelectionSummary || !favoriteFoldersRefresh || !favoriteFolderLimit || !favoriteVideoLimit || !favoriteRefresh || !favoriteTags || !favoriteTagsDialog || !favoriteTagsClose || !favoriteTagsStatus || !favoriteTagsList || !tooltip) {
    host.remove();
    throw new Error('无法初始化时间过滤设置面板');
  }

  const filterControl = shadow.querySelector<HTMLButtonElement>('#filter-control')!;
  const timeApply = shadow.querySelector<HTMLButtonElement>('#time-apply')!;
  const timeCancel = shadow.querySelector<HTMLButtonElement>('#time-cancel')!;
  const timeDraftStatus = shadow.querySelector<HTMLElement>('#time-draft-status')!;
  const favoriteWorkStatus = shadow.querySelector<HTMLElement>('#favorite-work-status')!;
  const favoriteSnapshot = shadow.querySelector<HTMLElement>('#favorite-snapshot')!;
  const favoriteCounts = shadow.querySelector<HTMLElement>('#favorite-counts')!;
  const favoriteUpdated = shadow.querySelector<HTMLTimeElement>('#favorite-updated')!;
  const favoriteContinue = shadow.querySelector<HTMLButtonElement>('#favorite-continue')!;
  const favoriteContinueAction = shadow.querySelector<HTMLElement>('#favorite-continue-action')!;
  const favoriteNext = shadow.querySelector<HTMLButtonElement>('#favorite-next')!;
  let current = normaliseConfig(options.config);
  let timeDirty = false;
  let pendingEnable = false;
  let tagGeneration = 0;
  let workState: FavoriteHomeFillState = { phase: 'idle' };
  let continuePending = false;
  let favoriteFolderOptions: FavoriteFolderOption[] = [];
  let favoriteFoldersLoaded = false;
  let favoriteFolderLoading: Promise<void> | null = null;
  let disposed = false;
  let draftFolderIds = new Set<string>();
  let activeDialog: HTMLElement | null = null;
  let dialogOpener: HTMLElement | null = null;
  const helpText: Record<string, string> = {
    'favorite-enabled': '首次开启会先引导选择收藏夹，保存后才启用。根据所选收藏视频的标签搜索旧视频，仅填补首页被时间过滤留下的空位；关闭开关可停止更新和搜索。',
    'favorite-selection': '选择来源时读取收藏夹列表。点击名称切换选中状态，蓝色表示已选；达到数量上限后仍可取消选择。保存后自动更新收藏偏好，取消不启用补位。',
    'favorite-list-cache': '收藏夹列表按账号缓存，打开时优先使用缓存。新建、删除或重命名收藏夹后，请手动刷新列表；刷新列表不会刷新收藏视频标签。',
    'favorite-folder-limit': '最多同时选择 1–10 个收藏夹，所有选中项都参与读取。降低上限后若已选数量超限，需先取消部分选择才能保存。',
    'favorite-video-limit': '每个选中收藏夹最多读取 1–200 条最近收藏的视频，用于提取内容标签，不会读取夹内全部视频。数量越大，请求越多。',
    'favorite-refresh': '重新读取所选收藏视频及其标签，不刷新收藏夹名称列表。页面会显示实际更新进度与结果，关闭补位开关可停止任务。',
    'favorite-continue': '首页还有空位时，再寻找一轮符合截止时间的视频。只填空位，不会替换已显示的视频；没有合适结果时仍会留空。',
    'favorite-tags': '查看所选收藏视频生成的当前标签及命中视频数；不是收藏夹名称，也不是搜索推荐词。需先开启收藏补位并选择收藏夹。',
  };
  for (const help of shadow.querySelectorAll<HTMLElement>('[data-help]')) {
    help.dataset.tooltip = helpText[help.dataset.help ?? ''];
  }
  let tooltipTarget: HTMLElement | null = null;
  const hideTooltip = (): void => {
    tooltip.hidden = true;
    tooltipTarget?.removeAttribute('aria-describedby');
    tooltipTarget = null;
  };
  const showTooltip = (target: HTMLElement): void => {
    if (!target.dataset.tooltip) return;
    hideTooltip();
    tooltipTarget = target;
    tooltip.textContent = target.dataset.tooltip;
    target.setAttribute('aria-describedby', tooltip.id);
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const width = doc.documentElement.clientWidth || doc.defaultView?.innerWidth || 1024;
    const height = doc.documentElement.clientHeight || doc.defaultView?.innerHeight || 768;
    const tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(rect.right - tip.width, width - tip.width - 12))}px`;
    tooltip.style.top = `${Math.max(12, Math.min(rect.top - tip.height - 8, height - tip.height - 12))}px`;
  };
  for (const help of shadow.querySelectorAll<HTMLElement>('[data-tooltip]')) {
    help.addEventListener('mouseenter', () => showTooltip(help));
    help.addEventListener('mouseleave', () => { if (shadow.activeElement !== help) hideTooltip(); });
    help.addEventListener('focus', () => showTooltip(help));
    help.addEventListener('blur', hideTooltip);
  }
  shadow.addEventListener('scroll', hideTooltip, true);
  const closeDialog = (): void => {
    if (!activeDialog) return;
    tagGeneration += 1;
    if (activeDialog === favoriteFoldersDialog) pendingEnable = false;
    activeDialog.hidden = true;
    activeDialog = null;
    hideTooltip();
    mainView.hidden = false;
    dialogOpener?.focus();
    dialogOpener = null;
    renderFavoriteControls();
  };
  const openDialog = (dialog: HTMLElement, firstFocus: HTMLElement, opener: HTMLElement): void => {
    if (activeDialog) closeDialog();
    dialogOpener = opener;
    activeDialog = dialog;
    mainView.hidden = true;
    dialog.hidden = false;
    dialog.querySelector<HTMLElement>('.dialog-body')!.scrollTop = 0;
    favoriteFolders.scrollTop = 0;
    firstFocus.focus();
  };
  const validateDraft = (): boolean => {
    let message = '';
    if (!favoriteFolderLimit.validity.valid || !favoriteVideoLimit.validity.valid || !favoriteFolderLimit.value || !favoriteVideoLimit.value) {
      message = '收藏夹数量需为 1–10 的整数，每夹视频数需为 1–200 的整数。';
    } else if (draftFolderIds.size > Number(favoriteFolderLimit.value)) {
      message = `已选 ${draftFolderIds.size} 个，请先取消部分选择，将数量减至 ${favoriteFolderLimit.value} 个以内。`;
    }
    favoriteFoldersValidation.textContent = message;
    favoriteFoldersSave.disabled = Boolean(message) || (pendingEnable && !draftFolderIds.size);
    return !message;
  };
  const renderFavoriteFolders = (): void => {
    const optionsById = new Map(favoriteFolderOptions.map((folder) => [folder.id, folder]));
    for (const id of draftFolderIds) if (!optionsById.has(id)) optionsById.set(id, { id, title: `已保存收藏夹 ${id}` });
    const focusedId = (shadow.activeElement as HTMLElement | null)?.dataset.folderId;
    favoriteFolders.replaceChildren();
    if (optionsById.size === 0) {
      const empty = doc.createElement('span');
      empty.className = 'hint';
      empty.textContent = favoriteFolderLoading ? '正在读取收藏夹…' : favoriteFoldersLoaded ? '当前账号没有自己创建的收藏夹' : '暂无收藏夹列表';
      favoriteFolders.append(empty);
    } else {
      for (const folder of optionsById.values()) {
        const option = doc.createElement('button');
        option.type = 'button';
        option.className = 'folder-option';
        option.dataset.folderId = folder.id;
        const selected = draftFolderIds.has(folder.id);
        const atLimit = !selected && draftFolderIds.size >= Number(favoriteFolderLimit.value);
        option.setAttribute('aria-pressed', String(selected));
        option.setAttribute('aria-disabled', String(atLimit));
        option.textContent = folder.title;
        if (folder.mediaCount !== undefined || folder.isDefault) {
          const count = doc.createElement('small');
          count.textContent = `${folder.mediaCount === undefined ? '' : `${folder.mediaCount} 个视频`}${folder.isDefault ? ' · 默认' : ''}`;
          option.append(count);
        }
        if (atLimit) option.title = '已达到收藏夹数量上限，请先取消其他选择或提高上限。';
        option.addEventListener('click', () => {

          if (draftFolderIds.has(folder.id)) draftFolderIds.delete(folder.id);
          else if (draftFolderIds.size < Number(favoriteFolderLimit.value)) draftFolderIds.add(folder.id);
          else {
            favoriteFoldersValidation.textContent = '已达到收藏夹数量上限，请先取消其他选择或提高上限。';
            return;
          }
          renderFavoriteFolders();
        });
        favoriteFolders.append(option);
      }
    }
    favoriteFoldersCount.textContent = `已选 ${draftFolderIds.size} / ${favoriteFolderLimit.value} 个 · 列表共 ${favoriteFolderOptions.length} 个`;
    validateDraft();
    if (focusedId) Array.from(favoriteFolders.querySelectorAll<HTMLButtonElement>('[data-folder-id]')).find((button) => button.dataset.folderId === focusedId)?.focus();
  };
  const renderFavoriteControls = (): void => {
    const disabled = !favoriteEnabled.checked;
    favoriteContent.hidden = false;
    const selectedCount = current.favoriteFolderIds?.length ?? 0;
    const overLimit = selectedCount > (current.favoriteFolderLimit ?? 3);
    favoriteFoldersOpen.disabled = false;
    favoriteFoldersRefresh.disabled = (disabled && !pendingEnable) || Boolean(favoriteFolderLoading);
    const busy = workState.phase === 'updating' || workState.phase === 'searching';
    favoriteRefresh.disabled = disabled || !selectedCount || overLimit || busy;
    favoriteTags.disabled = disabled || !selectedCount || overLimit;
    const names = (current.favoriteFolderIds ?? []).map((id) => favoriteFolderOptions.find((folder) => folder.id === id)?.title ?? `收藏夹 ${id}`);
    favoriteSelectionSummary.textContent = overLimit ? `已选 ${selectedCount} 个，超出上限` : selectedCount > 1 ? `已选 ${selectedCount} 个收藏夹` : names[0] || '尚未选择收藏夹';
    favoriteSelectionSummary.title = names.join('、');
    const reason = !selectedCount ? 'no-folders' : disabled ? 'disabled' : workState.reason;
    const reasons: Record<string, string> = { disabled: '收藏补位已关闭，来源偏好保留', 'no-folders': '选择收藏夹，建立你的内容偏好', paused: '偏好已保留，开启时间过滤后补充首页', 'no-cutoff': '请先设置并应用截止时间', 'not-home': '偏好已保存，仅在首页补充；此处仍可更新偏好', 'no-tags': '没有可用的兴趣标签，请更换来源或更新偏好', 'no-results': '本轮没有符合日期的视频，可以继续寻找' };
    const stages = { preferences: '收藏偏好更新', search: '候选搜索', storage: '结果保存' };
    favoriteWorkStatus.dataset.phase = workState.phase;
    favoriteWorkStatus.textContent = !disabled && workState.phase === 'updating' ? '正在更新收藏偏好…'
      : !disabled && workState.phase === 'searching' ? '正在寻找符合日期的视频…'
      : !disabled && workState.phase === 'error' ? `${stages[workState.errorStage ?? 'preferences']}失败，${workState.hasCachedPreferences ? '已保留仍可用的旧偏好，' : ''}请重试`
      : reason ? reasons[reason] : workState.phase === 'filled' ? `本轮已补充 ${workState.insertedCount ?? 0} 个视频` : workState.phase === 'ready' ? '收藏偏好已更新' : '等待首页空位';
    favoriteSnapshot.hidden = !workState.updatedAt;
    if (workState.updatedAt) {
      const updated = new Date(workState.updatedAt);
      const date = localDateValue(updated);
      const time = localTimeValue(updated);
      favoriteCounts.textContent = `${workState.sourceCount ?? selectedCount} 个来源 · ${workState.tagCount ?? 0} 个标签`;
      favoriteUpdated.textContent = `${date.slice(5)} ${time.slice(0, 5)} 更新`;
      favoriteUpdated.dateTime = updated.toISOString();
      favoriteUpdated.title = `更新于 ${date} ${time}`;
      favoriteUpdated.setAttribute('aria-label', favoriteUpdated.title);
    }
    favoriteContinue.disabled = disabled || !selectedCount || busy || continuePending || Boolean(reason && reason !== 'no-results');
    favoriteContinueAction.hidden = !options.onFavoriteContinue;
    favoriteNext.hidden = reason !== 'paused' && reason !== 'no-cutoff';
    favoriteNext.textContent = reason === 'paused' ? '开启时间过滤' : '设置截止时间';
    if (disabled) favoriteFolderStatus.textContent = '开启收藏补位后可选择或刷新收藏夹';
  };
  const refreshFavoriteFolders = async (force = false): Promise<void> => {
    if (disposed || (!favoriteEnabled.checked && !pendingEnable)) return;
    if (!options.onFavoriteFoldersRefresh) {
      favoriteFolderStatus.textContent = '当前运行时无法读取收藏夹';
      return;
    }
    if (favoriteFolderLoading) return favoriteFolderLoading;
    favoriteFolderStatus.textContent = '正在读取收藏夹…';
    favoriteFoldersRefresh.disabled = true;
    favoriteFolderLoading = options.onFavoriteFoldersRefresh(force, () => !disposed && (favoriteEnabled.checked || pendingEnable)).then((folders) => {
      if (disposed || (!favoriteEnabled.checked && !pendingEnable)) return;
      favoriteFolderOptions = folders.filter((folder) => folder && typeof folder.id === 'string' && folder.id);
      favoriteFoldersLoaded = true;
      renderFavoriteFolders();
      favoriteFolderStatus.textContent = favoriteFolderOptions.length ? `已读取 ${favoriteFolderOptions.length} 个收藏夹` : '未找到可用收藏夹';
    }).catch(() => {
      if (!disposed && (favoriteEnabled.checked || pendingEnable)) favoriteFolderStatus.textContent = '收藏夹读取失败，已保留现有列表和选择，请稍后重试';
    }).finally(() => {
      favoriteFolderLoading = null;
      if (!disposed) { renderFavoriteControls(); renderFavoriteFolders(); }
    });
    renderFavoriteFolders();
    await favoriteFolderLoading;
  };
  const showFavoriteTags = async (): Promise<void> => {
    if (!favoriteEnabled.checked || !current.favoriteFolderIds?.length) return;
    openDialog(favoriteTagsDialog, favoriteTagsClose, favoriteTags);
    const generation = ++tagGeneration;
    favoriteTagsStatus.textContent = '正在读取当前标签…';
    favoriteTagsList.replaceChildren();
    if (!options.onFavoriteTagsLoad) {
      favoriteTagsStatus.textContent = '当前运行时无法读取标签';
      return;
    }
    try {
      const tags = await options.onFavoriteTagsLoad();
      if (disposed || generation !== tagGeneration || activeDialog !== favoriteTagsDialog) return;
      if (!tags.length) {
        favoriteTagsStatus.textContent = favoriteEnabled.checked ? '暂无可用标签，请先选择收藏夹并刷新' : '请先启用收藏标签首页补位';
        return;
      }
      favoriteTagsStatus.textContent = `共 ${tags.length} 个标签`;
      for (const tag of tags) {
        const item = doc.createElement('li');
        item.textContent = tag.tag;
        const count = doc.createElement('small');
        count.textContent = `${tag.videoCount} 个收藏视频`;
        item.append(count);
        favoriteTagsList.append(item);
      }
    } catch {
      if (disposed || generation !== tagGeneration || activeDialog !== favoriteTagsDialog) return;
      favoriteTagsStatus.textContent = '标签读取失败，请稍后重试';
    }
  };
  const renderFilterStatus = (): void => {
    filterControl.textContent = current.enabled ? '暂停过滤' : '开启过滤';
    filterControl.dataset.paused = String(!current.enabled);
    filterControl.setAttribute('aria-pressed', String(current.enabled));
    filterState.textContent = !current.enabled ? '未开启' : current.cutoffMinute ? '过滤中' : '待设时间';
    filterState.dataset.active = String(current.enabled && Boolean(current.cutoffMinute));
    status.textContent = current.enabled && current.cutoffMinute
      ? `${current.autoAdvance ? '自动推进中：' : '已启用：'}早于 ${current.cutoffMinute.replace('T', ' ')} 的内容`
      : current.enabled ? '请设置完整的截止日期和时间' : '过滤未启用';
    hint.textContent = current.enabled
      ? '仅保留严格早于截止时间的内容'
      : '关闭过滤后，请刷新页面以恢复完整内容';
    hint.hidden = current.enabled;
  };
  const emit = (resetAutoAnchor = false): void => {
    let nextAutoAdvance = autoAdvance.checked;
    if (nextAutoAdvance && !current.cutoffMinute) {
      autoAdvance.checked = false;
      nextAutoAdvance = false;
    }
    const autoAdvanceStartedAt = nextAutoAdvance
      ? (resetAutoAnchor || !current.autoAdvance ? Date.now() : current.autoAdvanceStartedAt)
      : null;
    const autoAdvanceBaseCutoffMinute = nextAutoAdvance
      ? (resetAutoAnchor || !current.autoAdvance ? current.cutoffMinute : current.autoAdvanceBaseCutoffMinute)
      : null;
    current = normaliseConfig({
      cutoffMinute: current.cutoffMinute,
      enabled: enabled.checked,
      supplementBudget: Number(budget.value),
      debug: current.debug,
      autoAdvance: nextAutoAdvance,
      autoAdvanceStartedAt,
      autoAdvanceBaseCutoffMinute,
      favoriteHomeFillEnabled: favoriteEnabled.checked,
      favoriteFolderIds: current.favoriteFolderIds,
      favoriteFolderLimit: current.favoriteFolderLimit,
      favoriteVideoLimit: current.favoriteVideoLimit,
      favoriteRefreshRequestedAt: current.favoriteRefreshRequestedAt ?? null,
    });
    cutoff.value = current.cutoffMinute ?? '';
    budget.value = String(current.supplementBudget);
    renderFilterStatus();
    renderFavoriteControls();
    void options.onChange?.(current);
  };
  const setOpen = (open: boolean): void => {
    if (!open) {
      closeDialog();
      hideTooltip();
    }
    card.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && favoriteEnabled.checked && !favoriteFoldersLoaded) void refreshFavoriteFolders();
  };
  const sync = (config: FilterPanelConfig): void => {
    current = normaliseConfig(config);
    cutoff.value = current.cutoffMinute ?? '';
    enabled.checked = current.enabled;
    budget.value = String(current.supplementBudget);
    const [date = '', time = ''] = (current.cutoffMinute ?? localDateTimeMinute()).split('T');
    if (!timeDirty) { cutoffDate.value = date; cutoffTime.value = time; }
    cutoff.value = current.cutoffMinute ?? '';
    autoAdvance.checked = current.autoAdvance === true;
    favoriteEnabled.checked = current.favoriteHomeFillEnabled === true;
    if (favoriteFoldersDialog.hidden) {
      draftFolderIds = new Set(current.favoriteFolderIds ?? []);
      favoriteFolderLimit.value = String(current.favoriteFolderLimit ?? 3);
      favoriteVideoLimit.value = String(current.favoriteVideoLimit ?? 50);
    }
    if (!favoriteEnabled.checked && !pendingEnable) closeDialog();
    renderFavoriteControls();
    renderFavoriteFolders();
    renderFilterStatus();
    if (favoriteEnabled.checked && !favoriteFoldersLoaded) void refreshFavoriteFolders();
  };

  toggle.addEventListener('click', () => setOpen(card.hidden));
  close.addEventListener('click', () => setOpen(false));
  const markTimeDraft = (): void => {
    timeDirty = true;
    timeDraftStatus.textContent = '修改尚未应用';
    timeDraftStatus.classList.remove('validation');
  };
  const applyTime = (): void => {
    const value = `${cutoffDate.value}T${cutoffTime.value}`;
    if (parseLocalMinute(value) === null) {
      timeDraftStatus.textContent = '请输入完整、有效的日期和时间';
      timeDraftStatus.classList.add('validation');
      return;
    }
    current = { ...current, cutoffMinute: value };
    timeDirty = false;
    timeDraftStatus.textContent = '时间已应用';
    timeDraftStatus.classList.remove('validation');
    emit(true);
  };
  for (const input of [cutoffDate, cutoffTime]) {
    input.addEventListener('input', markTimeDraft);
    input.addEventListener('change', markTimeDraft);
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); applyTime(); } });
  }
  timeApply.addEventListener('click', applyTime);
  timeCancel.addEventListener('click', () => { timeDirty = false; timeDraftStatus.textContent = ''; sync(current); });
  filterControl.addEventListener('click', () => {
    if (!current.enabled && !current.cutoffMinute) {
      timeDraftStatus.textContent = '请先应用截止时间，再开启过滤';
      cutoffDate.focus();
      return;
    }
    enabled.checked = !enabled.checked;
    emit();
  });
  favoriteNext.addEventListener('click', () => {
    if (!current.cutoffMinute) { cutoffDate.focus(); return; }
    if (!current.enabled) { enabled.checked = true; emit(); }
  });
  favoriteContinue.addEventListener('click', async () => {
    if (favoriteContinue.disabled) return;
    continuePending = true;
    renderFavoriteControls();
    try { await options.onFavoriteContinue?.(); }
    catch { workState = { ...workState, phase: 'error', errorStage: 'search' }; }
    finally { continuePending = false; if (!disposed) renderFavoriteControls(); }
  });
  fillCurrentTime.addEventListener('click', () => {
    cutoffTime.value = localTimeValue(new Date());
    markTimeDraft();
  });
  enabled.addEventListener('change', () => emit());
  budget.addEventListener('change', () => emit());
  autoAdvance.addEventListener('change', () => emit(true));
  favoriteEnabled.addEventListener('change', () => {
    if (favoriteEnabled.checked && !current.favoriteFolderIds?.length) {
      favoriteEnabled.checked = false;
      openFavoriteFolders(true);
      return;
    }
    emit();
    if (!favoriteEnabled.checked) closeDialog();
    else void refreshFavoriteFolders();
  });
  const openFavoriteFolders = (enableOnSave = false): void => {
    draftFolderIds = new Set(current.favoriteFolderIds ?? []);
    favoriteFolderLimit.value = String(current.favoriteFolderLimit ?? 3);
    favoriteVideoLimit.value = String(current.favoriteVideoLimit ?? 50);
    openDialog(favoriteFoldersDialog, favoriteFoldersClose, favoriteFoldersOpen);
    pendingEnable = enableOnSave || !current.favoriteHomeFillEnabled;
    renderFavoriteFolders();
    renderFavoriteControls();
    void refreshFavoriteFolders();
  };
  favoriteFoldersOpen.addEventListener('click', () => openFavoriteFolders());
  favoriteFoldersClose.addEventListener('click', closeDialog);
  favoriteFoldersCancel.addEventListener('click', closeDialog);
  favoriteFoldersSave.addEventListener('click', () => {
    if (!validateDraft()) return;
    if (pendingEnable) favoriteEnabled.checked = true;
    current = { ...current, favoriteFolderIds: [...draftFolderIds], favoriteFolderLimit: Number(favoriteFolderLimit.value), favoriteVideoLimit: Number(favoriteVideoLimit.value), favoriteRefreshRequestedAt: Math.max(Date.now(), (current.favoriteRefreshRequestedAt ?? 0) + 1) };
    if (draftFolderIds.size) workState = { ...workState, phase: 'updating' };
    emit();
    closeDialog();
  });
  favoriteFoldersRefresh.addEventListener('click', () => { void refreshFavoriteFolders(true); });
  favoriteFolderLimit.addEventListener('input', renderFavoriteFolders);
  favoriteVideoLimit.addEventListener('input', () => { validateDraft(); });
  favoriteRefresh.addEventListener('click', () => {
    if (!favoriteEnabled.checked || !current.favoriteFolderIds?.length) return;
    if (favoriteRefresh.disabled) return;
    const refreshRequestedAt = Math.max(Date.now(), (current.favoriteRefreshRequestedAt ?? 0) + 1);
    current = { ...current, favoriteRefreshRequestedAt: refreshRequestedAt };
    workState = { ...workState, phase: 'updating' };
    renderFavoriteControls();
    try {
      const pending = options.onChange?.(current);

      void Promise.resolve(pending).catch(() => {
        if (current.favoriteRefreshRequestedAt === refreshRequestedAt) { workState = { ...workState, phase: 'error', errorStage: 'preferences' }; renderFavoriteControls(); }
      });
    } catch {
      workState = { ...workState, phase: 'error', errorStage: 'preferences' };
      renderFavoriteControls();
    }
  });
  favoriteTags.addEventListener('click', () => { void showFavoriteTags(); });
  favoriteTagsClose.addEventListener('click', closeDialog);
  shadow.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.key === 'Escape') {
      if (activeDialog) { key.preventDefault(); closeDialog(); }
      else if (!card.hidden) { key.preventDefault(); setOpen(false); toggle.focus(); }
      hideTooltip();
    }
  });
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
      markTimeDraft();
    });
  });
  sync(current);

  return {
    element: host,
    update: sync,
    updateFavoriteState: (state) => { workState = state; renderFavoriteControls(); },
    destroy: () => { disposed = true; host.remove(); },
  };
}

export { PANEL_ID };

/** 语义更直观的别名，供运行时入口使用。 */
export const mountSettingsPanel = createFilterPanel;
