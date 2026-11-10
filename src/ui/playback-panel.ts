import { normalizePlaybackUrl, type PlaybackConfig, type PlaybackEntry } from '../playback/model';
import type { PlaybackState } from '../playback/session';
import type { ResolvedPlaybackSource } from '../playback/source';

export type PlaybackPanelCommand = { type: 'save-config'; config: PlaybackConfig }
  | { type: 'start' | 'resume' | 'pause' | 'exit' | 'continue' | 'skip-ad' | 'cancel-catalog-resolution' | 'resolve-catalog' };

export interface PlaybackPanelHandle {
  element: HTMLElement;
  open(): void;
  destroy(): void;
}

export interface PlaybackPanelClient {
  getState(): PlaybackState;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  command(command: PlaybackPanelCommand): void | Promise<void>;
  resolveSource(url: string): Promise<ResolvedPlaybackSource>;
}

const STATUS: Record<PlaybackState['status'], string> = {
  idle: '等待开始', loading: '正在加载', playing: '播放中', paused: '已暂停', waiting: '等待播放器',
  'waiting-end': '已达到广告间隔，等待当前视频结束', ad: '公益广告插播中', blocked: '请点击“继续播放”', stopped: '已停止',
};

export function createPlaybackPanel(doc: Document, client: PlaybackPanelClient): PlaybackPanelHandle {
  const element = doc.createElement('section');
  element.id = 'playback-dialog';
  element.className = 'panel-view playback-view';
  element.hidden = true;
  element.setAttribute('aria-label', '动画时光机与公益广告');
  element.innerHTML = `
    <div class="dialog-body">
      <div class="playback-now"><strong id="playback-status" role="status"></strong><div id="playback-current"></div><div id="playback-next" class="description"></div><div id="playback-clock" class="description"></div><div id="playback-message" role="status" aria-live="polite"></div></div>
      <section class="section"><div class="section-label">公益广告设置</div>
        <label class="row"><span>动画中途插播</span><input id="playback-animation-ads" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
        <label class="row"><span>普通观看片尾插播</span><input id="playback-normal-ads" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
        <label class="row" for="playback-interval">广告间隔（分钟）<input id="playback-interval" class="ui-input ui-input-sm" type="number" min="0" step="any" required></label>
        <p class="description">按正片实际观看时间计时，两种模式分别计算。每次广告最多播放 60 秒，未播完的下次继续。加载和播放时均可跳过。</p>
      </section>
      <section class="section"><label class="section-label" for="playback-order">动画播放顺序</label><select id="playback-order"><option value="round-robin">轮播 · 每部各播一集</option><option value="sequential">顺播 · 看完一部再下一部</option></select><p class="description">片单播完后循环。播放中可切换顺序，保存后从下一集生效。增删作品或分集前，请先退出连播。</p>
        <div class="playback-catalog-status"><span id="playback-catalog-message" role="status" aria-live="polite"></span><button id="playback-cancel-catalog" class="ui-btn ui-btn-sm" type="button" hidden>取消自动补全</button></div>
        <div id="playback-works" class="playback-list" tabindex="0" aria-label="动画作品列表"></div>
        <div class="playback-source-actions"><button id="playback-add-work" class="ui-btn ui-btn-sm" type="button">添加作品</button><span class="description">粘贴链接导入分集，也可以手动添加。</span></div>
      </section>
      <section class="section"><div class="section-label">公益广告片单</div><p class="description">随机播放，全部播完后重新开始。片单只有一条时会重复播放。</p><div id="playback-ads" class="playback-list playback-ad-list" tabindex="0" aria-label="公益广告列表"></div><div class="playback-source-actions"><button id="playback-add-ad" class="ui-btn ui-btn-sm" type="button">添加公益广告</button></div></section>
    </div>
    <footer class="panel-footer playback-footer"><div id="playback-feedback" role="status" aria-live="polite"></div><div id="playback-ad-notice" class="description"></div><div class="playback-actions"><button id="playback-save" class="ui-btn ui-btn-sm" type="button">保存设置</button><button id="playback-start" class="ui-btn ui-btn-primary ui-btn-sm" type="button">从头播放</button><button id="playback-resume" class="ui-btn ui-btn-sm" type="button">继续观看</button><button id="playback-pause" class="ui-btn ui-btn-sm" type="button">暂停</button><button id="playback-continue" class="ui-btn ui-btn-primary ui-btn-sm" type="button">继续播放</button><button id="playback-skip-ad" class="ui-btn ui-btn-sm" type="button">跳过广告</button><button id="playback-exit" class="ui-btn ui-btn-sm" type="button">退出连播</button></div><div class="description">退出后保留进度，下次点击“继续观看”恢复。</div></footer>
    <dialog id="playback-details-dialog" class="playback-source-dialog playback-details-dialog" aria-labelledby="playback-details-title">
      <section class="playback-source-content playback-details-content">
        <header class="playback-modal-header"><h2 id="playback-details-title"></h2><button id="playback-details-close" class="ui-btn ui-btn-sm" type="button">关闭</button></header>
        <div id="playback-details-entries" class="playback-modal-scroll" aria-label="分集列表"></div>
        <footer class="playback-source-actions playback-source-modal-actions"><span class="description">添加或删除后，请返回并点击“保存设置”。</span><button id="playback-details-add" class="ui-btn ui-btn-primary ui-btn-sm" type="button">添加分集</button></footer>
      </section>
    </dialog>
    <dialog id="playback-add-dialog" class="playback-source-dialog" aria-labelledby="playback-add-title">
      <form id="playback-add-form" class="playback-source-content" novalidate>
        <h2 id="playback-add-title">添加作品</h2>
        <label id="playback-add-name-label" class="playback-source-input-label" for="playback-add-name">作品名称</label>
        <input id="playback-add-name" class="ui-input ui-input-sm" type="text" autocomplete="off" placeholder="作品名称">
        <label id="playback-add-url-label" class="playback-source-input-label" for="playback-add-url">B 站视频、合集或番剧链接</label>
        <div class="playback-source-input-row"><input id="playback-add-url" class="ui-input ui-input-sm" type="text" autocomplete="url" placeholder="粘贴 B 站链接"><button id="playback-add-parse" class="ui-btn ui-btn-sm" type="submit">获取分集</button></div>
        <p id="playback-add-status" class="playback-source-status" role="status" aria-live="polite">粘贴链接获取分集，预览后选择要添加的内容；也可仅添加当前链接。</p>
        <div id="playback-add-preview" class="playback-source-preview" aria-label="可添加的分集"></div>
        <div class="playback-source-actions playback-source-modal-actions"><button id="playback-add-cancel" class="ui-btn ui-btn-sm" type="button">取消</button><button id="playback-add-direct" class="ui-btn ui-btn-sm" type="button">仅添加此链接</button><button id="playback-add-confirm" class="ui-btn ui-btn-primary ui-btn-sm" type="button" disabled>加入片单</button></div>
      </form>
    </dialog>`;
  const get = <T extends HTMLElement>(id: string): T => element.querySelector<T>(`#playback-${id}`)!;
  let state = client.getState();
  let draft: PlaybackConfig = structuredClone(state.config);
  let dirty = false;
  let draftRevision = 0;
  let disposed = false;
  let catalogCancelSent = false;
  let catalogResolveRequested = false;
  let sourceRequestId = 0;
  let resolvingSource = false;
  let resolvedSource: ResolvedPlaybackSource | null = null;
  let selectedSourceEntries = new Set<number>();
  let sourceStatus = '粘贴链接后，点击“获取分集”。';
  let addTrigger: HTMLButtonElement | null = null;
  let detailTrigger: HTMLButtonElement | null = null;
  let detailWorkId: string | null = null;
  let addMode: 'work' | 'entry' | 'ad' = 'work';
  let targetWorkId: string | null = null;
  const addDialog = get<HTMLDialogElement>('add-dialog');
  const detailsDialog = get<HTMLDialogElement>('details-dialog');
  const active = () => state.mode === 'animation' && !['idle', 'stopped'].includes(state.status);
  const feedback = (text: string) => { get('feedback').textContent = text; };
  const send = async (command: PlaybackPanelCommand): Promise<boolean> => {
    try { await client.command(command); return true; }
    catch (error) { if (!disposed) feedback(error instanceof Error ? error.message : '操作失败，请重试。'); return false; }
  };
  const resolveCatalogOnOpen = () => {
    if (dirty || state.mode !== 'normal' || state.catalogResolving || catalogResolveRequested
      || !draft.works.some(work => work.sourceStatus === 'pending')) return;
    catalogResolveRequested = true;
    void send({ type: 'resolve-catalog' }).then(ok => { if (!ok) catalogResolveRequested = false; });
  };
  const cancelCatalogResolution = () => {
    if (state.catalogResolving && !catalogCancelSent) { catalogCancelSent = true; void send({ type: 'cancel-catalog-resolution' }); }
  };
  const markDirty = () => {
    draftRevision++; dirty = true; cancelCatalogResolution();
    feedback('设置尚未保存'); renderStatus();
  };
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = 'ui-btn ui-btn-xs'; node.textContent = label;
    node.addEventListener('click', action); return node;
  };
  const bindModal = (dialog: HTMLDialogElement, close: () => void, restore: () => void) => {
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', restore);
  };
  const renderAddControls = () => {
    const locked = active() && addMode !== 'ad';
    get<HTMLInputElement>('add-name').disabled = locked;
    get<HTMLInputElement>('add-url').disabled = locked;
    get<HTMLButtonElement>('add-parse').hidden = addMode === 'ad';
    get<HTMLButtonElement>('add-parse').disabled = locked || resolvingSource;
    get<HTMLButtonElement>('add-direct').disabled = locked || resolvingSource;
    get<HTMLButtonElement>('add-confirm').hidden = addMode === 'ad';
    get<HTMLButtonElement>('add-confirm').disabled = locked || resolvingSource || !resolvedSource || selectedSourceEntries.size === 0;
  };
  const renderSourcePreview = () => {
    const preview = get('add-preview'); preview.replaceChildren();
    preview.hidden = addMode === 'ad';
    if (!resolvedSource) return;
    const kindLabel: Record<ResolvedPlaybackSource['kind'], string> = {
      parts: '多分集视频', collection: '合集', season: '番剧', single: '单集',
    };
    const intro = doc.createElement('p');
    intro.className = 'playback-source-result-title';
    intro.textContent = `${resolvedSource.title} · ${kindLabel[resolvedSource.kind]} · ${resolvedSource.entries.length} 集`;
    const list = doc.createElement('ul');
    list.setAttribute('aria-label', '可添加的分集');
    resolvedSource.entries.forEach((entry, index) => {
      const row = doc.createElement('li');
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedSourceEntries.has(index);
      checkbox.setAttribute('aria-label', `选择${entry.title}`);
      const title = doc.createElement('span'); title.textContent = `${index + 1}. ${entry.title}`;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedSourceEntries.add(index);
        else selectedSourceEntries.delete(index);
        renderAddControls();
      });
      row.append(checkbox, title); list.append(row);
    });
    preview.append(intro, list);
  };
  const renderSourceState = () => {
    get('add-status').textContent = sourceStatus;
    renderSourcePreview();
    renderAddControls();
  };
  const invalidateSource = (message = '粘贴链接后，点击“获取分集”。') => {
    sourceRequestId++;
    resolvingSource = false;
    resolvedSource = null;
    selectedSourceEntries.clear();
    sourceStatus = message;
    renderSourceState();
  };
  const closeAddDialog = () => {
    invalidateSource();
    if (addDialog.open) addDialog.close();
  };
  const openAddDialog = (mode: 'work' | 'entry' | 'ad', trigger: HTMLButtonElement, workId: string | null = null) => {
    if (active() && mode !== 'ad') return;
    addMode = mode; targetWorkId = workId; addTrigger = trigger;
    const title = get('add-title');
    title.textContent = mode === 'ad' ? '添加公益广告' : mode === 'entry' ? '添加分集' : '添加作品';
    get('add-name-label').textContent = mode === 'ad' ? '广告名称（选填）' : mode === 'entry' ? '分集名称（选填）' : '作品名称（仅添加链接时必填）';
    get<HTMLInputElement>('add-name').placeholder = get('add-name-label').textContent!;
    get('add-url-label').textContent = mode === 'ad' ? 'B 站视频或番剧单集链接' : 'B 站视频、合集或番剧链接';
    get<HTMLInputElement>('add-name').value = '';
    get<HTMLInputElement>('add-url').value = '';
    invalidateSource(mode === 'ad' ? '仅添加链接对应的视频；如需指定分集，请粘贴该分集的链接。' : '粘贴链接获取分集，预览后选择要添加的内容；也可仅添加当前链接。');
    get<HTMLButtonElement>('add-direct').textContent = mode === 'ad' ? '添加广告' : '仅添加此链接';
    get<HTMLButtonElement>('add-confirm').textContent = mode === 'entry' ? '添加所选分集' : '加入片单';
    addDialog.showModal();
    get<HTMLInputElement>('add-url').focus();
  };
  const parseSource = async () => {
    const url = get<HTMLInputElement>('add-url').value.trim();
    if (!url) { sourceStatus = '请先输入 B 站链接。'; renderSourceState(); get('add-url').focus(); return; }
    const requestId = ++sourceRequestId;
    resolvingSource = true;
    resolvedSource = null;
    selectedSourceEntries.clear();
    sourceStatus = '正在获取分集…';
    renderSourceState();
    try {
      const source = await client.resolveSource(url);
      if (requestId !== sourceRequestId || disposed || !addDialog.open || get<HTMLInputElement>('add-url').value.trim() !== url) return;
      if (!source.entries.length) {
        sourceStatus = '未找到可添加的分集，也可以选择“仅添加此链接”。';
        return;
      }
      resolvedSource = source;
      selectedSourceEntries = new Set(source.entries.map((_entry, index) => index));
      sourceStatus = `已找到 ${source.entries.length} 个分集，请选择要添加的内容。`;
    } catch (error) {
      if (requestId !== sourceRequestId || disposed || !addDialog.open) return;
      sourceStatus = error instanceof Error ? error.message : '未能获取分集，请检查链接后重试。';
    } finally {
      if (requestId === sourceRequestId && !disposed) {
        resolvingSource = false;
        renderSourceState();
      }
    }
  };
  const renderEntries = (container: HTMLElement, entries: PlaybackEntry[], locked: boolean, onEdit?: () => void) => {
    container.replaceChildren();
    const list = doc.createElement('ol');
    entries.forEach((entry, index) => {
      const row = doc.createElement('li');
      const title = doc.createElement('a'); title.textContent = entry.title; title.href = entry.url; title.target = '_blank'; title.rel = 'noopener noreferrer';
      const remove = button('删除', () => {
        const scrollTop = container.scrollTop;
        entries.splice(index, 1); onEdit?.(); markDirty(); renderLists();
        if (detailsDialog.open) renderDetailsEntries();
        container.scrollTop = scrollTop;
        const buttons = container.querySelectorAll<HTMLButtonElement>('li button');
        (buttons[Math.min(index, buttons.length - 1)] ?? get<HTMLButtonElement>(detailsDialog.open ? 'details-add' : 'add-ad')).focus({ preventScroll: true });
      });
      remove.disabled = locked; remove.setAttribute('aria-label', `删除${entry.title}`);
      row.append(title, remove); list.append(row);
    });
    container.append(list);
  };
  const findWork = (id: string | null) => draft.works.find(work => work.id === id);
  function renderDetailsEntries() {
    if (!detailsDialog.open && !detailWorkId) return;
    const work = findWork(detailWorkId);
    if (!work) { if (detailsDialog.open) detailsDialog.close(); return; }
    get('details-title').textContent = `${work.title} · ${work.entries.length} 集`;
    get<HTMLButtonElement>('details-add').disabled = active();
    renderEntries(get('details-entries'), work.entries, active(), () => { work.sourceStatus = 'manual'; });
  }
  const openDetailsDialog = (workId: string, trigger: HTMLButtonElement) => {
    detailWorkId = workId; detailTrigger = trigger;
    renderDetailsEntries();
    detailsDialog.showModal();
  };
  const renderLists = () => {
    const works = get('works');
    works.replaceChildren();
    draft.works.forEach((work, index) => {
      const group = doc.createElement('section'); group.className = 'playback-work';
      const title = button(`${index + 1}. ${work.title} · ${work.entries.length} 集${work.sourceStatus === 'failed' ? ' · 分集获取失败' : ''}`, () => openDetailsDialog(work.id, title));
      title.className = 'ui-btn ui-btn-ghost playback-work-open';
      title.dataset.workId = work.id;
      title.setAttribute('aria-haspopup', 'dialog');
      title.setAttribute('aria-label', `${work.title}，${work.entries.length} 集，查看分集`);
      const remove = button('删除作品', () => {
        draft.works.splice(index, 1); markDirty(); renderLists();
      });
      remove.disabled = active(); remove.setAttribute('aria-label', `删除作品${work.title}`);
      group.append(title, remove); works.append(group);
    });
    if (!draft.works.length) works.textContent = '还没有作品，请添加动画作品。';
    renderEntries(get('ads'), draft.ads, false);
  };
  const renderConfig = () => {
    get<HTMLInputElement>('animation-ads').checked = draft.animationAds;
    get<HTMLInputElement>('normal-ads').checked = draft.normalAds;
    get<HTMLInputElement>('interval').value = String(draft.intervalMinutes);
    get<HTMLSelectElement>('order').value = draft.order;
    renderLists();
  };
  const renderStatus = () => {
    const entryLabel = (entry: PlaybackEntry | null) => {
      if (!entry) return null;
      const work = state.config.works.find(item => item.entries.some(candidate => candidate.id === entry.id));
      return work ? `${work.title} · ${entry.title}` : entry.title;
    };
    get('status').textContent = `${state.mode === 'animation' ? '动画连播' : '普通观看'} · ${STATUS[state.status]}`;
    get('current').textContent = `当前：${entryLabel(state.current) ?? '当前页面视频'}`;
    get('next').textContent = `接下来：${entryLabel(state.next) ?? '由 B 站播放器控制'}`;
    const seconds = Math.floor(state.elapsedMs / 1000);
    const adsEnabled = state.mode === 'animation' ? state.config.animationAds : state.config.normalAds;
    get('clock').textContent = adsEnabled
      ? `累计观看 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · 广告间隔 ${state.config.intervalMinutes} 分钟`
      : `${state.mode === 'animation' ? '动画中途' : '普通观看片尾'}插播已关闭`;
    get('message').textContent = state.ad ? `正在插播：${state.ad.title}。${state.message}` : state.message;
    const adChanges: string[] = [];
    if (draft.animationAds !== state.config.animationAds) adChanges.push(`动画中途插播将${draft.animationAds ? '开启' : '关闭'}`);
    if (draft.normalAds !== state.config.normalAds) adChanges.push(`普通观看片尾插播将${draft.normalAds ? '开启' : '关闭'}`);
    get('ad-notice').textContent = adChanges.length
      ? `${adChanges.join('；')}，保存后生效。`
      : `动画中途插播已${state.config.animationAds ? '开启' : '关闭'}。`;
    get('catalog-message').textContent = state.catalogMessage ?? '';
    get<HTMLButtonElement>('cancel-catalog').hidden = !state.catalogResolving;
    get<HTMLButtonElement>('add-work').disabled = active();
    get<HTMLButtonElement>('add-ad').disabled = false;
    get<HTMLButtonElement>('save').disabled = !dirty;
    get<HTMLButtonElement>('start').disabled = dirty || active() || state.status === 'loading' || state.catalogResolving === true || !draft.works.some(work => work.entries.length);
    get<HTMLButtonElement>('resume').disabled = dirty || state.status === 'loading' || state.catalogResolving === true || !state.canResume;
    get('resume').hidden = active();
    get('pause').hidden = !active() || !['playing', 'loading', 'waiting'].includes(state.status);
    get('continue').hidden = !['paused', 'blocked'].includes(state.status);
    get('skip-ad').hidden = !state.ad;
    get('exit').hidden = !active();
    renderAddControls();
  };
  get<HTMLButtonElement>('cancel-catalog').addEventListener('click', cancelCatalogResolution);
  get<HTMLButtonElement>('add-work').addEventListener('click', () => openAddDialog('work', get('add-work')));
  get<HTMLButtonElement>('add-ad').addEventListener('click', () => openAddDialog('ad', get('add-ad')));
  get<HTMLFormElement>('add-form').addEventListener('submit', event => {
    event.preventDefault();
    if (addMode === 'ad') get<HTMLButtonElement>('add-direct').click();
    else if (!active()) void parseSource();
  });
  get<HTMLButtonElement>('add-cancel').addEventListener('click', closeAddDialog);
  bindModal(addDialog, closeAddDialog, () => {
    if (addTrigger?.isConnected) addTrigger.focus();
    else if (detailsDialog.open) get<HTMLButtonElement>('details-add').focus();
    else get<HTMLButtonElement>('add-work').focus();
    addTrigger = null;
  });
  get<HTMLInputElement>('add-url').addEventListener('input', () => {
    const url = get<HTMLInputElement>('add-url').value.trim();
    invalidateSource(addMode === 'ad' ? '仅添加链接对应的视频；如需指定分集，请粘贴该分集的链接。'
      : url ? '链接已更改，请重新点击“获取分集”。' : '粘贴链接后，点击“获取分集”。');
  });
  const appendEntries = (entries: PlaybackEntry[], sourceTitle: string, sourceStatus: 'manual' | 'resolved') => {
    if (addMode === 'work') {
      const title = get<HTMLInputElement>('add-name').value.trim() || sourceTitle;
      if (!title) { get('add-status').textContent = '请填写作品名称。'; get<HTMLInputElement>('add-name').focus(); return false; }
      draft.works.push({ id: crypto.randomUUID(), title, sourceStatus, entries });
    } else if (addMode === 'entry') {
      const work = findWork(targetWorkId);
      if (!work) { get('add-status').textContent = '目标作品已不存在，请重新打开添加窗口。'; return false; }
      work.entries.push(...entries);
      work.sourceStatus = 'manual';
    } else {
      draft.ads.push(...entries);
    }
    closeAddDialog();
    markDirty();
    renderLists();
    if (detailsDialog.open) renderDetailsEntries();
    return true;
  };
  get<HTMLButtonElement>('add-direct').addEventListener('click', () => {
    if (active() && addMode !== 'ad') return;
    const urlInput = get<HTMLInputElement>('add-url');
    const normalized = normalizePlaybackUrl(urlInput.value.trim());
    if (!normalized) {
      get('add-status').textContent = addMode === 'ad'
        ? '请输入 B 站视频或番剧单集链接，可打开对应视频后复制地址。'
        : '请输入 B 站视频或番剧单集链接；合集和整季番剧请先点击“获取分集”。';
      urlInput.focus(); return;
    }
    const name = get<HTMLInputElement>('add-name').value.trim();
    if (addMode === 'work' && !name) { get('add-status').textContent = '手动添加作品时请填写作品名称。'; get<HTMLInputElement>('add-name').focus(); return; }
    const count = addMode === 'entry' ? (findWork(targetWorkId)?.entries.length ?? 0) : draft.ads.length;
    const entry = { id: crypto.randomUUID(), title: name || `${addMode === 'ad' ? '公益广告' : '分集'} ${count + 1}`, url: normalized };
    appendEntries([entry], name || '公益广告', 'manual');
  });
  get<HTMLButtonElement>('add-confirm').addEventListener('click', () => {
    const source = resolvedSource;
    if (active() || !source || addMode === 'ad') return;
    const entries = source.entries.flatMap((entry, index) => {
      if (!selectedSourceEntries.has(index)) return [];
      return [{ ...entry, id: crypto.randomUUID() }];
    });
    if (!entries.length) { sourceStatus = '请至少选择一个分集。'; renderSourceState(); return; }
    appendEntries(entries, source.title, 'resolved');
  });
  get<HTMLButtonElement>('details-close').addEventListener('click', () => detailsDialog.close());
  get<HTMLButtonElement>('details-add').addEventListener('click', () => {
    const trigger = get<HTMLButtonElement>('details-add');
    if (detailWorkId) openAddDialog('entry', trigger, detailWorkId);
  });
  bindModal(detailsDialog, () => detailsDialog.close(), () => {
    const trigger = detailTrigger?.isConnected ? detailTrigger
      : [...get('works').querySelectorAll<HTMLButtonElement>('[data-work-id]')].find(button => button.dataset.workId === detailWorkId);
    detailWorkId = null;
    get('details-entries').replaceChildren();
    (trigger ?? get('works')).focus({ preventScroll: true });
    detailTrigger = null;
  });
  for (const [id, key] of [['animation-ads', 'animationAds'], ['normal-ads', 'normalAds']] as const) {
    get<HTMLInputElement>(id).addEventListener('change', event => { draft[key] = (event.target as HTMLInputElement).checked; markDirty(); });
  }
  get<HTMLSelectElement>('order').addEventListener('change', event => { draft.order = (event.target as HTMLSelectElement).value as PlaybackConfig['order']; markDirty(); });
  get<HTMLInputElement>('interval').addEventListener('input', () => { draft.intervalMinutes = Number(get<HTMLInputElement>('interval').value); markDirty(); });
  get('save').addEventListener('click', async () => {
    if (!(draft.intervalMinutes > 0) || !Number.isFinite(draft.intervalMinutes)) { feedback('广告间隔请输入大于 0 的分钟数。'); get('interval').focus(); return; }
    if (draft.works.some(work => !work.entries.length)) { feedback('请为每部作品至少添加一个分集，或删除没有分集的作品。'); return; }
    const savedRevision = draftRevision;
    if (await send({ type: 'save-config', config: structuredClone(draft) }) && !disposed && savedRevision === draftRevision) {
      dirty = false; feedback('播放设置已保存'); renderStatus();
    }
  });
  for (const type of ['start', 'resume', 'pause', 'exit', 'continue', 'skip-ad'] as const) {
    get(type).addEventListener('click', () => { void send({ type }); });
  }
  renderConfig(); renderStatus();
  const unsubscribe = client.subscribe(next => {
    const wasActive = active(); const configChanged = JSON.stringify(state.config) !== JSON.stringify(next.config);
    state = next;
    if (state.catalogResolving) catalogResolveRequested = true;
    else { catalogCancelSent = false; if (catalogResolveRequested) catalogResolveRequested = false; }
    if (!dirty && configChanged) { draft = structuredClone(state.config); renderConfig(); }
    else if (wasActive !== active()) renderLists();
    if (detailsDialog.open && (configChanged || wasActive !== active())) renderDetailsEntries();
    renderStatus();
  });
  return { element, open: resolveCatalogOnOpen, destroy: () => { disposed = true; unsubscribe(); element.remove(); } };
}
