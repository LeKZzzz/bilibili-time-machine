/** 页面内的紧凑设置面板；字段与共享 FilterConfig 保持一致。 */

import type { FavoriteFolderOption, FilterConfig } from '../core/types';
import type { FavoriteTagScore } from '../core/favorite-home-fill';
import { parseLocalMinute } from '../core/time';
import type { FavoriteHomeFillState } from '../runtime/favorite-home-fill-controller';
import panelStyle from './panel.css?inline';
import { createPlaybackPanel, type PlaybackPanelClient } from './playback-panel';

export type FilterPanelConfig = FilterConfig;

export interface FilterPanelOptions {
  config: FilterPanelConfig;
  document?: Document;
  onChange?: (config: FilterPanelConfig) => void | Promise<void>;
  onFavoriteFoldersRefresh?: (force?: boolean, isActive?: () => boolean) => Promise<FavoriteFolderOption[]>;
  onFavoriteContinue?: () => void | Promise<void>;
  onFavoriteTagsLoad?: () => Promise<FavoriteTagScore[]>;
  playback?: PlaybackPanelClient;
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
      <section class="card" hidden aria-label="B 站时光机设置">
        <div id="panel-navigation">
          <header class="title">
            <div><div class="brand">时光机</div><div id="panel-subtitle" class="subtitle">想回到过去，试着让故事继续</div></div>
            <div class="heading-actions"><span id="filter-state" class="state ui-badge" role="status"></span><button class="close ui-btn ui-btn-ghost ui-btn-xs" type="button" aria-label="关闭设置面板">×</button></div>
          </header>
          <nav class="panel-tabs" role="tablist" aria-label="时光机功能" hidden>
            <button id="filter-tab" class="panel-tab" type="button" role="tab" aria-selected="true" aria-controls="main-view">截止时间过滤</button>
            <button id="playback-tab" class="panel-tab" type="button" role="tab" aria-selected="false" aria-controls="playback-dialog" tabindex="-1">动画时光机</button>
          </nav>
        </div>
        <div id="main-view" class="panel-view">
          <div class="panel-body">
            <section class="section" aria-label="时间设置">
              <div class="row"><span class="section-label">截止时间<span class="description">本地时间 · 精确到秒</span></span><input id="enabled" type="checkbox" hidden><button id="filter-control" class="filter-control ui-btn ui-btn-sm" type="button"></button></div>
              <input id="cutoff" type="hidden">
              <div class="cutoff-grid">
                <div class="field"><label class="field-label" for="cutoff-date">日期</label><input id="cutoff-date" class="ui-input ui-input-sm" type="date" aria-label="截止日期"></div>
                <div class="field"><label class="field-label" for="cutoff-time">时间</label><input id="cutoff-time" class="ui-input ui-input-sm" type="time" step="1" aria-label="截止时间（含秒）"></div>
              </div>
              <div class="presets" aria-label="快捷时间"><button class="preset ui-btn ui-btn-xs" type="button" data-preset="now" title="填入当前日期和时间" aria-label="填入当前日期和时间">现在</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="today" title="填入今天的 00:00:00" aria-label="填入今天的 00:00:00">今天</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="yesterday" title="填入昨天的 00:00:00" aria-label="填入昨天的 00:00:00">昨天</button><button class="preset ui-btn ui-btn-xs" type="button" data-preset="week" title="填入 7 天前的 00:00:00" aria-label="填入 7 天前的 00:00:00">7 天前</button><button id="fill-current-time" class="time-fill preset ui-btn ui-btn-xs" type="button" aria-label="填入当前时分秒，保留已选日期">填入当前时间</button></div>
              <div class="time-actions"><span id="time-draft-status" role="status" aria-live="polite"></span><button id="time-cancel" class="ui-btn ui-btn-ghost ui-btn-sm" type="button">取消</button><button id="time-apply" class="ui-btn ui-btn-primary ui-btn-sm" type="button">应用时间</button></div>
              <label class="row"><span>自动推进时间<span class="description" style="display:block">每经过 1 分钟，截止时间推进 1 分钟</span></span><input id="auto-advance" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
            </section>
            <section class="favorite section" aria-label="收藏偏好补充首页">
              <div class="row"><span class="setting-label section-label"><label for="favorite-enabled">收藏偏好补充首页</label><button class="help" type="button" data-help="favorite-enabled" aria-label="收藏偏好补充首页说明">?</button></span><input id="favorite-enabled" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox" aria-label="启用收藏偏好补充首页"></div>
              <div class="description favorite-description">根据收藏偏好，填补首页被过滤的空位</div>
              <div id="favorite-content" hidden>
                <div class="favorite-summary row"><span id="favorite-selection-summary" class="favorite-folder-status"></span><span class="setting-label"><button id="favorite-folders-open" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">选择收藏夹</button><button class="help" type="button" data-help="favorite-selection" aria-label="收藏夹选择说明">?</button></span></div>
                <div id="favorite-work-status" class="work-status" role="status" aria-live="polite"></div>
                <div id="favorite-snapshot" class="favorite-snapshot description"><span id="favorite-counts"></span><time id="favorite-updated"></time></div>
                <button id="favorite-next" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm" hidden></button>
                <div class="favorite-actions">
                  <span id="favorite-continue-action" class="setting-label"><button id="favorite-continue" type="button" class="ui-btn ui-btn-sm">继续寻找</button><button class="help" type="button" data-help="favorite-continue" aria-label="继续寻找的用途">?</button></span>
                  <span class="setting-label"><button id="favorite-tags" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">查看兴趣标签</button><button class="help" type="button" data-help="favorite-tags" aria-label="兴趣标签说明">?</button></span>
                  <span class="setting-label favorite-refresh-action"><button id="favorite-refresh" type="button" class="ui-btn ui-btn-sm">更新收藏偏好</button><button class="help" type="button" data-help="favorite-refresh" aria-label="更新收藏偏好说明">?</button></span>
                </div>
              </div>
            </section>
            <details class="advanced section">
              <summary>高级设置</summary>
              <div class="row"><label for="budget">发布时间查询上限<span class="description" style="display:block">视频缺少发布时间时，查询视频详情</span></label><input id="budget" class="ui-input ui-input-sm" type="number" min="0" max="100" step="1" inputmode="numeric" aria-label="每页发布时间查询上限"></div>
            </details>
          </div>
          <footer class="panel-footer"><div class="status" role="status" aria-live="polite"></div><div class="hint">仅保留严格早于截止时间的内容</div></footer>
        </div>
        <section id="favorite-folders-dialog" class="tag-dialog panel-view" role="region" aria-labelledby="favorite-folders-title" hidden>
          <header class="tag-dialog-title"><div><div id="favorite-folders-title" class="brand">选择收藏夹</div><div class="subtitle">保存后生效，返回将放弃本次修改</div></div><button id="favorite-folders-close" class="text-button ui-btn ui-btn-ghost ui-btn-sm" type="button" aria-label="取消并返回设置">返回</button></header>
          <div class="dialog-body">
            <div class="row"><span id="favorite-folders-count" class="tag-dialog-status" role="status" aria-live="polite"></span><button class="help" type="button" data-help="favorite-selection" aria-label="收藏夹选择数量说明">?</button></div>
            <div id="favorite-folders" class="folder-list" role="group" aria-label="可选收藏夹"></div>
            <div class="setting-label"><button id="favorite-folders-refresh" type="button" class="text-button ui-btn ui-btn-ghost ui-btn-sm">刷新收藏夹列表</button><button class="help" type="button" data-help="favorite-list-cache" aria-label="刷新收藏夹列表说明">?</button></div>
            <div class="description">在 B 站新建、删除或重命名收藏夹后，可在这里刷新列表。</div>
            <div class="favorite-folder-status" id="favorite-folder-status" role="status" aria-live="polite"></div>
            <div class="folder-controls">
              <div class="row"><span class="setting-label"><label for="favorite-folder-limit">收藏夹数量上限</label><button class="help" type="button" data-help="favorite-folder-limit" aria-label="收藏夹数量上限说明">?</button></span><input id="favorite-folder-limit" class="ui-input ui-input-sm" type="number" min="1" max="10" step="1" aria-label="收藏夹数量上限"></div>
              <div class="row"><span class="setting-label"><label for="favorite-video-limit">每夹读取视频数</label><button class="help" type="button" data-help="favorite-video-limit" aria-label="每夹读取视频数说明">?</button></span><input id="favorite-video-limit" class="ui-input ui-input-sm" type="number" min="1" max="200" step="1" aria-label="每夹读取视频数"></div>
            </div>
            <div id="favorite-folders-validation" class="validation" role="status" aria-live="polite"></div>
          </div>
          <footer class="dialog-actions"><button id="favorite-folders-cancel" type="button" class="ui-btn ui-btn-sm">取消</button><button id="favorite-folders-save" type="button" class="ui-btn ui-btn-primary ui-btn-sm">保存</button></footer>
        </section>
        <section id="favorite-tags-dialog" class="tag-dialog panel-view" role="region" aria-labelledby="favorite-tags-title" hidden>
          <header class="tag-dialog-title"><span id="favorite-tags-title" class="brand">兴趣标签</span><button id="favorite-tags-close" class="text-button ui-btn ui-btn-ghost ui-btn-sm" type="button" aria-label="返回设置">返回</button></header>
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
  const navigation = shadow.querySelector<HTMLElement>('#panel-navigation')!;
  const filterTab = shadow.querySelector<HTMLButtonElement>('#filter-tab')!;
  const playbackTab = shadow.querySelector<HTMLButtonElement>('#playback-tab')!;
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
    'favorite-enabled': '选择收藏夹并保存后，将根据收藏视频的标签，为首页补充符合截止时间的视频。关闭后停止更新和搜索。',
    'favorite-selection': '选择用于生成兴趣标签的收藏夹，保存后更新收藏偏好。达到数量上限时，先取消其他选择，或提高上限。',
    'favorite-list-cache': '重新获取当前账号的收藏夹列表。需要更新收藏视频的标签时，请点击“更新收藏偏好”。',
    'favorite-folder-limit': '可选择 1–10 个收藏夹。降低上限后，需取消超出的选择才能保存。',
    'favorite-video-limit': '每个收藏夹读取最近收藏的 1–200 条视频，用于生成兴趣标签。数量越大，读取时间越长。',
    'favorite-refresh': '重新读取所选收藏夹中的视频标签，更新兴趣偏好。关闭首页补充可停止任务。',
    'favorite-continue': '再寻找一批符合截止时间的视频。只填空位，不会替换已显示的视频；没有合适结果时仍会留空。',
    'favorite-tags': '根据所选收藏视频生成的兴趣标签，旁边的数字表示包含该标签的收藏视频数量。',
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
    navigation.hidden = false;
    mainView.hidden = false;
    dialogOpener?.focus();
    dialogOpener = null;
    renderFavoriteControls();
  };
  const openDialog = (dialog: HTMLElement, firstFocus: HTMLElement, opener: HTMLElement): void => {
    if (activeDialog) closeDialog();
    dialogOpener = opener;
    activeDialog = dialog;
    navigation.hidden = true;
    mainView.hidden = true;
    dialog.hidden = false;
    dialog.querySelector<HTMLElement>('.dialog-body')!.scrollTop = 0;
    favoriteFolders.scrollTop = 0;
    firstFocus.focus();
  };
  const playbackPanel = options.playback ? createPlaybackPanel(doc, options.playback) : null;
  if (playbackPanel) {
    card.append(playbackPanel.element);
    shadow.querySelector<HTMLElement>('.panel-tabs')!.hidden = false;
    for (const [view, tab] of [[mainView, filterTab], [playbackPanel.element, playbackTab]] as const) {
      view.setAttribute('role', 'tabpanel');
      view.setAttribute('aria-labelledby', tab.id);
    }
    const selectTab = (tab: HTMLButtonElement): void => {
      if (tab.getAttribute('aria-selected') === 'true') return;
      hideTooltip();
      const playing = tab === playbackTab;
      mainView.hidden = playing;
      playbackPanel.element.hidden = !playing;
      filterState.hidden = playing;
      for (const item of [filterTab, playbackTab]) {
        item.setAttribute('aria-selected', String(item === tab));
        item.tabIndex = item === tab ? 0 : -1;
      }
      if (playing) playbackPanel.open();
    };
    for (const tab of [filterTab, playbackTab]) {
      tab.addEventListener('click', () => selectTab(tab));
      tab.addEventListener('keydown', (event) => {
        let next: HTMLButtonElement;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = tab === filterTab ? playbackTab : filterTab;
        else if (event.key === 'Home') next = filterTab;
        else if (event.key === 'End') next = playbackTab;
        else return;
        event.preventDefault();
        selectTab(next);
        next.focus();
      });
    }
  }
  const validateDraft = (): boolean => {
    let message = '';
    if (!favoriteFolderLimit.validity.valid || !favoriteVideoLimit.validity.valid || !favoriteFolderLimit.value || !favoriteVideoLimit.value) {
      message = '收藏夹上限请输入 1–10 的整数，每夹读取视频数请输入 1–200 的整数。';
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
    const reasons: Record<string, string> = { disabled: '首页补充已关闭，已保留收藏夹选择和偏好', 'no-folders': '选择收藏夹并保存，开始使用收藏偏好补充首页', paused: '开启时间过滤后，将按收藏偏好补充首页', 'no-cutoff': '请先设置并应用截止时间', 'not-home': '收藏偏好已保存，回到 B 站首页后补充视频', 'no-tags': '暂无兴趣标签，请更新收藏偏好或更换收藏夹', 'no-results': options.onFavoriteContinue ? '暂未找到符合截止时间的视频，可点击“继续寻找”' : '暂未找到符合截止时间的视频，可更新收藏偏好后重试' };
    favoriteContinue.disabled = disabled || !selectedCount || busy || continuePending || Boolean(reason && reason !== 'no-results');
    favoriteContinueAction.hidden = !options.onFavoriteContinue;
    const retryPreferences = favoriteRefresh.disabled ? '请重新选择收藏夹后重试。' : '请点击“更新收藏偏好”重试。';
    const errors = {
      preferences: `收藏偏好更新失败。${workState.hasCachedPreferences ? '已保留原有偏好。' : ''}${retryPreferences}`,
      search: `视频搜索失败。${options.onFavoriteContinue && !favoriteContinue.disabled ? '请点击“继续寻找”重试。' : retryPreferences}`,
      storage: '本次结果未能保存，请稍后刷新页面重试。',
    };
    favoriteWorkStatus.dataset.phase = workState.phase;
    favoriteWorkStatus.textContent = !disabled && workState.phase === 'updating' ? '正在更新收藏偏好…'
      : !disabled && workState.phase === 'searching' ? '正在寻找符合截止时间的视频…'
      : !disabled && workState.phase === 'error' ? errors[workState.errorStage ?? 'preferences']
      : reason ? reasons[reason] : workState.phase === 'filled' ? `本轮已补充 ${workState.insertedCount ?? 0} 个视频` : workState.phase === 'ready' ? '收藏偏好已更新' : '等待首页空位';
    favoriteSnapshot.hidden = !workState.updatedAt;
    if (workState.updatedAt) {
      const updated = new Date(workState.updatedAt);
      const date = localDateValue(updated);
      const time = localTimeValue(updated);
      favoriteCounts.textContent = `${workState.sourceCount ?? selectedCount} 个收藏夹 · ${workState.tagCount ?? 0} 个标签`;
      favoriteUpdated.textContent = `${date.slice(5)} ${time.slice(0, 5)} 更新`;
      favoriteUpdated.dateTime = updated.toISOString();
      favoriteUpdated.title = `更新于 ${date} ${time}`;
      favoriteUpdated.setAttribute('aria-label', favoriteUpdated.title);
    }
    favoriteNext.hidden = reason !== 'paused' && reason !== 'no-cutoff';
    favoriteNext.textContent = reason === 'paused' ? '开启时间过滤' : '设置截止时间';
    favoriteFoldersSave.textContent = pendingEnable ? '保存并启用' : '保存';
    if (disabled && !pendingEnable) favoriteFolderStatus.textContent = '选择收藏夹并保存后，将启用首页补充。';
  };
  const refreshFavoriteFolders = async (force = false): Promise<void> => {
    if (disposed || (!favoriteEnabled.checked && !pendingEnable)) return;
    if (!options.onFavoriteFoldersRefresh) {
      favoriteFolderStatus.textContent = '当前无法读取收藏夹，请刷新页面后重试。';
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
      if (!disposed && (favoriteEnabled.checked || pendingEnable)) favoriteFolderStatus.textContent = '未能读取收藏夹，已保留现有选择。请点击“刷新收藏夹列表”重试。';
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
    favoriteTagsStatus.textContent = '正在读取兴趣标签…';
    favoriteTagsList.replaceChildren();
    if (!options.onFavoriteTagsLoad) {
      favoriteTagsStatus.textContent = '当前无法读取兴趣标签，请刷新页面后重试。';
      return;
    }
    try {
      const tags = await options.onFavoriteTagsLoad();
      if (disposed || generation !== tagGeneration || activeDialog !== favoriteTagsDialog) return;
      if (!tags.length) {
        favoriteTagsStatus.textContent = favoriteEnabled.checked ? '暂无兴趣标签。请返回后点击“更新收藏偏好”；仍无标签时，可更换收藏夹。' : '请先启用收藏偏好补充首页。';
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
      favoriteTagsStatus.textContent = '未能读取兴趣标签，请返回后重新打开。';
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
    destroy: () => { disposed = true; playbackPanel?.destroy(); host.remove(); },
  };
}

export { PANEL_ID };

/** 语义更直观的别名，供运行时入口使用。 */
export const mountSettingsPanel = createFilterPanel;
