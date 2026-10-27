import { normalizePlaybackUrl, type PlaybackConfig, type PlaybackEntry } from '../playback/model';
import type { PlaybackState } from '../playback/session';

export type PlaybackPanelCommand = { type: 'save-config'; config: PlaybackConfig }
  | { type: 'start' | 'resume' | 'pause' | 'exit' | 'continue' | 'skip-ad' };

export interface PlaybackPanelClient {
  getState(): PlaybackState;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  command(command: PlaybackPanelCommand): void | Promise<void>;
}

const STATUS: Record<PlaybackState['status'], string> = {
  idle: '等待开始', loading: '正在加载', playing: '播放中', paused: '已暂停', waiting: '等待播放器',
  'waiting-end': '到点了，等待片尾', ad: '公益广告插播中', blocked: '点击继续播放', stopped: '已停止',
};

export function createPlaybackPanel(doc: Document, client: PlaybackPanelClient, onBack: () => void) {
  const element = doc.createElement('section');
  element.id = 'playback-dialog';
  element.className = 'panel-view playback-view';
  element.hidden = true;
  element.setAttribute('aria-label', '动画时光机与公益广告');
  element.innerHTML = `
    <header class="tag-dialog-title"><div><div class="brand">童年放映室</div><div class="subtitle">独立播放 · 无需设置截止时间</div></div><button id="playback-back" class="ui-btn ui-btn-ghost ui-btn-sm" type="button">返回</button></header>
    <div class="dialog-body">
      <div class="playback-now"><strong id="playback-status" role="status"></strong><div id="playback-current"></div><div id="playback-next" class="description"></div><div id="playback-clock" class="description"></div><div id="playback-message" role="status" aria-live="polite"></div></div>
      <section class="section"><div class="section-label">穿插一点公益广告</div>
        <label class="row"><span>动画中途插播</span><input id="playback-animation-ads" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
        <label class="row"><span>普通观看片尾插播</span><input id="playback-normal-ads" class="ui-toggle ui-toggle-primary ui-toggle-sm" type="checkbox"></label>
        <label class="row" for="playback-interval">每累计播放（分钟）<input id="playback-interval" class="ui-input ui-input-sm" type="number" min="0" step="any" required></label>
        <p class="description">只计算正片实际播放时间，两种模式分别计时。广告加载时也可立即跳过。</p>
      </section>
      <section class="section"><label class="section-label" for="playback-order">动画播放顺序</label><select id="playback-order"><option value="round-robin">轮播 · 每部各播一集</option><option value="sequential">顺播 · 看完一部再下一部</option></select><p class="description">整份片单播完后循环。运行中请先退出，再修改动画片单与顺序。</p>
        <div id="playback-works" class="playback-list" tabindex="0" aria-label="动画作品与有序条目"></div>
        <div class="playback-add"><input id="playback-work-title" class="ui-input ui-input-sm" placeholder="作品名称" aria-label="新作品名称"><button id="playback-add-work" class="ui-btn ui-btn-sm" type="button">添加作品</button></div>
      </section>
      <section class="section"><div class="section-label">公益广告片单</div><p class="description">随机遍历，每次一条。只有一条时允许重复。</p><div id="playback-ads" class="playback-list playback-ad-list" tabindex="0" aria-label="公益广告条目"></div></section>
      <p class="description">添加指定 BV 视频 / 分 P 或番剧 ep 链接；每个链接为一个条目，不自动展开整季。</p>
    </div>
    <footer class="panel-footer playback-footer"><div id="playback-feedback" role="status" aria-live="polite"></div><div id="playback-ad-notice" class="description"></div><div class="playback-actions"><button id="playback-save" class="ui-btn ui-btn-sm" type="button">保存设置</button><button id="playback-start" class="ui-btn ui-btn-primary ui-btn-sm" type="button">从头播放</button><button id="playback-resume" class="ui-btn ui-btn-sm" type="button">继续观看</button><button id="playback-pause" class="ui-btn ui-btn-sm" type="button">暂停</button><button id="playback-continue" class="ui-btn ui-btn-primary ui-btn-sm" type="button">点击继续播放</button><button id="playback-skip-ad" class="ui-btn ui-btn-sm" type="button">跳过广告</button><button id="playback-exit" class="ui-btn ui-btn-sm" type="button">退出连播</button></div><div class="description">退出保留进度；重新打开后由你主动继续。</div></footer>`;
  const get = <T extends HTMLElement>(id: string): T => element.querySelector<T>(`#playback-${id}`)!;
  let state = client.getState();
  let draft: PlaybackConfig = structuredClone(state.config);
  let dirty = false;
  let draftRevision = 0;
  let disposed = false;
  const active = () => state.mode === 'animation' && !['idle', 'stopped'].includes(state.status);
  const feedback = (text: string) => { get('feedback').textContent = text; };
  const send = async (command: PlaybackPanelCommand): Promise<boolean> => {
    try { await client.command(command); return true; }
    catch (error) { if (!disposed) feedback(error instanceof Error ? error.message : '操作失败，请重试。'); return false; }
  };
  const markDirty = () => { draftRevision++; dirty = true; feedback('设置尚未保存'); renderStatus(); };
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const node = doc.createElement('button');
    node.type = 'button'; node.className = 'ui-btn ui-btn-xs'; node.textContent = label;
    node.addEventListener('click', action); return node;
  };
  const renderEntries = (container: HTMLElement, entries: PlaybackEntry[], locked: boolean, label: string) => {
    const list = doc.createElement('ol');
    entries.forEach((entry, index) => {
      const row = doc.createElement('li');
      const title = doc.createElement('a'); title.textContent = entry.title; title.href = entry.url; title.target = '_blank'; title.rel = 'noopener noreferrer';
      const remove = button('删除', () => { entries.splice(index, 1); markDirty(); renderLists(); });
      remove.disabled = locked; remove.setAttribute('aria-label', `删除${entry.title}`);
      row.append(title, remove); list.append(row);
    });
    container.append(list);
    const form = doc.createElement('form'); form.className = 'playback-entry-form';
    const title = doc.createElement('input'); title.className = 'ui-input ui-input-sm'; title.placeholder = '条目名称（选填）'; title.setAttribute('aria-label', `${label}条目名称`);
    const url = doc.createElement('input'); url.className = 'ui-input ui-input-sm'; url.placeholder = 'BV / 分 P / ep 链接'; url.required = true; url.setAttribute('aria-label', `${label}播放链接`);
    const add = button('添加条目', () => {}); add.type = 'submit';
    title.disabled = locked; url.disabled = locked; add.disabled = locked;
    form.append(title, url, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const normalized = normalizePlaybackUrl(url.value.trim());
      if (!normalized) { feedback('请输入 B 站 BV 视频、指定分 P 或番剧 ep 链接。'); url.focus(); return; }
      entries.push({ id: crypto.randomUUID(), title: title.value.trim() || `条目 ${entries.length + 1}`, url: normalized });
      markDirty(); renderLists();
    });
    container.append(form);
  };
  const renderLists = () => {
    const works = get('works'); works.replaceChildren();
    draft.works.forEach((work, index) => {
      const group = doc.createElement('section'); group.className = 'playback-work';
      const header = doc.createElement('div'); header.className = 'row';
      const title = doc.createElement('strong'); title.textContent = `${index + 1}. ${work.title}`;
      const remove = button('删除作品', () => { draft.works.splice(index, 1); markDirty(); renderLists(); });
      remove.disabled = active(); remove.setAttribute('aria-label', `删除作品${work.title}`);
      header.append(title, remove); group.append(header);
      renderEntries(group, work.entries, active(), work.title); works.append(group);
    });
    if (!draft.works.length) works.textContent = '还没有作品，请添加作品和播放条目。';
    const ads = get('ads'); ads.replaceChildren(); renderEntries(ads, draft.ads, false, '公益广告');
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
    get('status').textContent = `${state.mode === 'animation' ? '动画频道' : '普通观看'} · ${STATUS[state.status]}`;
    get('current').textContent = `当前：${entryLabel(state.current) ?? '当前页面视频'}`;
    get('next').textContent = `接下来：${entryLabel(state.next) ?? '由原播放器决定'}`;
    const seconds = Math.floor(state.elapsedMs / 1000);
    get('clock').textContent = `本模式累计 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / ${state.config.intervalMinutes} 分钟`;
    get('message').textContent = state.ad ? `正在插播：${state.ad.title}。${state.message}` : state.message;
    get('ad-notice').textContent = draft.animationAds ? '动画公益广告已开启：到点暂停，插播后断点继续。' : '动画公益广告已关闭。';
    get<HTMLSelectElement>('order').disabled = active();
    get<HTMLInputElement>('work-title').disabled = active();
    get<HTMLButtonElement>('add-work').disabled = active();
    get<HTMLButtonElement>('save').disabled = !dirty;
    get<HTMLButtonElement>('start').disabled = dirty || active() || state.status === 'loading' || !draft.works.some(work => work.entries.length);
    get<HTMLButtonElement>('resume').disabled = dirty || state.status === 'loading' || !state.canResume;
    get('resume').hidden = active();
    get('pause').hidden = !active() || !['playing', 'loading', 'waiting'].includes(state.status);
    get('continue').hidden = !['paused', 'blocked'].includes(state.status);
    get('skip-ad').hidden = !state.ad;
    get('exit').hidden = !active();
  };
  get('back').addEventListener('click', onBack);
  get('add-work').addEventListener('click', () => {
    const title = get<HTMLInputElement>('work-title');
    if (!title.value.trim()) { feedback('请填写作品名称。'); title.focus(); return; }
    draft.works.push({ id: crypto.randomUUID(), title: title.value.trim(), entries: [] }); title.value = '';
    markDirty(); renderLists();
  });
  for (const [id, key] of [['animation-ads', 'animationAds'], ['normal-ads', 'normalAds']] as const) {
    get<HTMLInputElement>(id).addEventListener('change', event => { draft[key] = (event.target as HTMLInputElement).checked; markDirty(); });
  }
  get<HTMLSelectElement>('order').addEventListener('change', event => { draft.order = (event.target as HTMLSelectElement).value as PlaybackConfig['order']; markDirty(); });
  get<HTMLInputElement>('interval').addEventListener('input', () => { draft.intervalMinutes = Number(get<HTMLInputElement>('interval').value); markDirty(); });
  get('save').addEventListener('click', async () => {
    if (!(draft.intervalMinutes > 0) || !Number.isFinite(draft.intervalMinutes)) { feedback('广告间隔需要是大于零的分钟数。'); get('interval').focus(); return; }
    if (draft.works.some(work => !work.entries.length)) { feedback('请为每部作品至少添加一个条目，或删除空作品。'); return; }
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
    if (!dirty && configChanged) { draft = structuredClone(state.config); renderConfig(); }
    else if (wasActive !== active()) renderLists();
    renderStatus();
  });
  return { element, back: get<HTMLButtonElement>('back'), destroy: () => { disposed = true; unsubscribe(); element.remove(); } };
}
