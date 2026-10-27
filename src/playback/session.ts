import { normalizePlaybackData, playbackQueue, type PlaybackConfig, type PlaybackData, type PlaybackEntry } from './model';

export interface PlaybackState {
  config: PlaybackConfig;
  mode: 'animation' | 'normal';
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'waiting' | 'waiting-end' | 'ad' | 'blocked' | 'stopped';
  current: PlaybackEntry | null;
  next: PlaybackEntry | null;
  ad: PlaybackEntry | null;
  elapsedMs: number;
  message: string;
  canResume: boolean;
}
export interface PlaybackPorts {
  navigate(entry: PlaybackEntry, position: number): Promise<void>;
  play(position?: number): void;
  pause(): void;
  showAd(entry: PlaybackEntry): void;
  closeAd(): void;
  releaseEnded(): void;
  save(data: PlaybackData): void | Promise<void>;
  state(state: PlaybackState): void;
}

export class PlaybackSession {
  private data: PlaybackData;
  private mode: PlaybackState['mode'] = 'normal';
  private status: PlaybackState['status'] = 'idle';
  private ad: PlaybackEntry | null = null;
  private message = '';
  private playingSince: number | null = null;
  private generation = 0;
  private transitioning = false;
  private pendingNavigation = false;
  private adBag: PlaybackEntry[] = [];
  private lastAdId = '';
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(data: PlaybackData, private readonly ports: PlaybackPorts,
    options: { now?: () => number; random?: () => number } = {}) {
    this.data = normalizePlaybackData(data);
    // 关闭页面时尚未结束的广告按跳过处理，不在新页面恢复广告。
    if (this.data.progress.pendingAdMode === 'animation') this.data.progress.animationElapsedMs = 0;
    if (this.data.progress.pendingAdMode === 'normal') this.data.progress.normalElapsedMs = 0;
    delete this.data.progress.pendingAdMode;
    this.adBag = (this.data.progress.adBagIds ?? []).flatMap(id => this.data.config.ads.filter(ad => ad.id === id));
    this.lastAdId = this.data.progress.lastAdId ?? '';
    if (this.data.progress.stopReason) { this.message = this.data.progress.stopReason; this.status = 'stopped'; }
    this.now = options.now ?? (() => performance.now());
    this.random = options.random ?? Math.random;
  }

  getData(): PlaybackData { return structuredClone(this.data); }
  getState(): PlaybackState {
    const queue = playbackQueue(this.data.config);
    const cursor = this.data.progress.cursor % (queue.length || 1);
    return {
      config: structuredClone(this.data.config), mode: this.mode, status: this.status,
      current: this.mode === 'animation' ? queue[cursor] ?? null : null,
      next: this.mode === 'animation' ? queue[(cursor + 1) % queue.length] ?? null : null,
      ad: this.ad, elapsedMs: this.elapsed(), message: this.message,
      canResume: queue.length > 0,
    };
  }

  configure(config: PlaybackConfig): void {
    config = normalizePlaybackData({ config }).config;
    const wasPlaying = this.playingSince !== null;
    this.accumulate();
    const queueChanged = config.order !== this.data.config.order
      || JSON.stringify(config.works) !== JSON.stringify(this.data.config.works);
    const adsChanged = JSON.stringify(config.ads) !== JSON.stringify(this.data.config.ads);
    if (queueChanged) {
      delete this.data.progress.stopReason; this.message = '';
      if (this.status === 'stopped') this.status = 'idle';
    }
    const current = playbackQueue(this.data.config)[this.data.progress.cursor];
    this.data.config = structuredClone(config);
    const index = playbackQueue(config).findIndex(entry => entry.id === current?.id);
    this.data.progress.cursor = Math.max(0, index);
    if (index < 0) this.data.progress.position = 0;
    if (adsChanged) { this.adBag = []; this.data.progress.adBagIds = []; }
    // 修改片单时结束本次连播，避免正在播的条目被悄悄替换。
    if (this.mode === 'animation' && queueChanged) this.exit();
    else {
      if (this.ad) this.finishAd();
      if (wasPlaying) this.playingSince = this.now();
      this.persist(); this.emit();
    }
  }

  checkpoint(): void {
    const wasPlaying = this.playingSince !== null;
    this.accumulate();
    if (wasPlaying) this.playingSince = this.now();
    this.persist();
  }

  async start(): Promise<void> {
    this.cleanupAd();
    this.data.progress.cursor = 0;
    this.data.progress.position = 0;
    this.data.progress.round = 0;
    this.data.progress.animationElapsedMs = 0;
    this.data.progress.failedEntryIds = [];
    await this.resume();
  }

  async resume(): Promise<void> {
    this.accumulate();
    this.cleanupAd();
    this.mode = 'animation';
    this.message = '';
    delete this.data.progress.stopReason;
    this.data.progress.failedEntryIds = [];
    await this.navigateCurrent();
  }

  async resumeNavigation(failureReason?: string): Promise<void> {
    if (!playbackQueue(this.data.config).length) {
      this.status = 'stopped'; this.message = '请先添加动画条目'; this.emit(); return;
    }
    this.transitioning = false;
    this.mode = 'animation';
    this.status = 'loading';
    this.emit();
    if (failureReason) { this.mediaFailed(failureReason); return; }
    this.ports.play(this.data.progress.position);
  }

  pause(): void {
    this.generation++; this.transitioning = false;
    this.accumulate();
    this.cleanupAd();
    this.ports.pause();
    this.status = 'paused';
    this.persist(); this.emit();
  }

  continuePlayback(): void {
    if (this.mode === 'animation' && this.pendingNavigation) { void this.navigateCurrent(); return; }
    this.status = 'loading'; this.message = ''; this.emit();
    this.ports.play(this.mode === 'animation' ? this.data.progress.position : undefined);
  }

  exit(): void { this.stop(true); }
  leave(): void { this.stop(false); }

  mediaPosition(seconds: number): void {
    if (this.mode === 'animation' && Number.isFinite(seconds)) this.data.progress.position = Math.max(0, seconds);
  }
  mediaPlaying(): void {
    if (this.ad) { this.ports.pause(); return; }
    if (this.status === 'blocked' && this.message === '点击继续播放') this.message = '';
    this.playingSince ??= this.now();
    this.status = this.due() && this.mode === 'normal' ? 'waiting-end' : 'playing';
    this.emit();
  }
  mediaPaused(): void { this.accumulate(); if (!this.ad && !this.transitioning && !['blocked', 'stopped'].includes(this.status)) this.status = 'paused'; this.emit(); }
  mediaWaiting(): void { this.accumulate(); if (!this.ad && !this.transitioning && !['paused', 'blocked', 'stopped'].includes(this.status)) this.status = 'waiting'; this.emit(); }
  adPlaying(): void {
    if (!this.ad) return;
    this.status = 'ad'; this.message = ''; this.emit();
  }
  autoplayBlocked(): void {
    this.accumulate(); this.status = 'blocked'; this.message = '点击继续播放'; this.emit();
  }
  tick(): void {
    const wasPlaying = this.playingSince !== null;
    this.accumulate();
    if (wasPlaying && !this.ad) this.playingSince = this.now();
    if (wasPlaying && this.due()) {
      if (this.mode === 'animation') this.beginAd();
      else this.status = 'waiting-end';
    }
    this.emit();
  }

  mediaEnded(): boolean {
    this.accumulate();
    if (this.ad || this.transitioning) return true;
    if (this.mode === 'animation') {
      this.data.progress.failedEntryIds = [];
      void this.advance();
      return true;
    }
    if (this.due()) { this.beginAd(); return this.ad !== null; }
    this.status = 'idle'; this.emit(); return false;
  }

  mediaFailed(reason: string): void {
    if (this.ad) { this.finishAd(); return; }
    if (this.mode !== 'animation' || this.transitioning) return;
    this.accumulate();
    const current = this.getState().current;
    if (current && !this.data.progress.failedEntryIds.includes(current.id)) this.data.progress.failedEntryIds.push(current.id);
    this.message = reason;
    const queue = playbackQueue(this.data.config);
    if (queue.every(entry => this.data.progress.failedEntryIds.includes(entry.id))) {
      this.data.progress.stopReason = '整份片单均无法播放，请检查片源';
      this.stop(true); this.status = 'stopped'; this.message = this.data.progress.stopReason; this.emit();
    } else void this.advance();
  }

  finishAd(): void {
    if (!this.ad) return;
    this.cleanupAd();
    this.status = 'loading';
    this.persist(); this.emit();
    if (this.mode === 'animation') this.ports.play(this.data.progress.position);
    else { this.status = 'idle'; this.ports.releaseEnded(); this.emit(); }
  }

  private elapsed(): number {
    return this.mode === 'animation' ? this.data.progress.animationElapsedMs : this.data.progress.normalElapsedMs;
  }
  private accumulate(): void {
    if (this.playingSince === null) return;
    const delta = Math.max(0, this.now() - this.playingSince);
    if (this.mode === 'animation') this.data.progress.animationElapsedMs += delta;
    else this.data.progress.normalElapsedMs += delta;
    this.playingSince = null;
  }
  private due(): boolean {
    return (this.mode === 'animation' ? this.data.config.animationAds : this.data.config.normalAds)
      && this.data.config.ads.length > 0 && this.elapsed() >= this.data.config.intervalMinutes * 60_000;
  }
  private beginAd(): void {
    if (!this.data.config.ads.length) return;
    this.accumulate();
    if (!this.adBag.length) {
      this.adBag = [...this.data.config.ads];
      for (let index = this.adBag.length - 1; index > 0; index--) {
        const swap = Math.floor(this.random() * (index + 1));
        [this.adBag[index], this.adBag[swap]] = [this.adBag[swap], this.adBag[index]];
      }
      if (this.adBag.length > 1 && this.adBag[0].id === this.lastAdId) {
        [this.adBag[0], this.adBag[1]] = [this.adBag[1], this.adBag[0]];
      }
    }
    this.ad = this.adBag.shift()!;
    this.lastAdId = this.ad.id;
    this.data.progress.lastAdId = this.lastAdId;
    this.data.progress.adBagIds = this.adBag.map(ad => ad.id);
    this.data.progress.pendingAdMode = this.mode;
    this.status = 'ad';
    this.persist();
    this.ports.pause(); this.emit(); this.ports.showAd(this.ad);
  }
  private cleanupAd(): void {
    if (!this.ad) return;
    this.ports.closeAd(); this.ad = null;
    delete this.data.progress.pendingAdMode;
    if (this.mode === 'animation') this.data.progress.animationElapsedMs = 0;
    else this.data.progress.normalElapsedMs = 0;
  }
  private stop(pause: boolean): void {
    this.generation++; this.transitioning = false; this.pendingNavigation = false;
    this.accumulate(); this.cleanupAd();
    if (pause) this.ports.pause();
    this.mode = 'normal'; this.status = 'idle'; this.persist(); this.emit();
  }
  private async advance(): Promise<void> {
    const queue = playbackQueue(this.data.config);
    this.data.progress.cursor++;
    if (this.data.progress.cursor >= queue.length) { this.data.progress.cursor = 0; this.data.progress.round++; }
    this.data.progress.position = 0;
    await this.navigateCurrent();
  }
  private async navigateCurrent(): Promise<void> {
    const entry = this.getState().current;
    if (!entry) { this.stop(true); this.status = 'stopped'; this.message = '请先添加动画条目'; this.emit(); return; }
    const generation = ++this.generation;
    this.transitioning = true; this.pendingNavigation = true; this.status = 'loading'; this.emit();
    try {
      await this.ports.save(this.getData());
      if (generation !== this.generation) return;
      // 同页定位会在 navigate 返回前发出播放失败事件，必须允许它推进到下一条。
      this.transitioning = false;
      this.pendingNavigation = false;
      await this.ports.navigate(entry, this.data.progress.position);
    } catch {
      if (generation === this.generation) {
        this.pendingNavigation = true; this.status = 'blocked'; this.message = '无法保存进度或切换视频，请重试';
      }
    } finally {
      if (generation === this.generation) { this.transitioning = false; this.emit(); }
    }
  }
  private persist(): void {
    void this.saveSnapshot().catch(() => {
      this.message = '进度保存失败，请检查存储空间'; this.emit();
    });
  }
  private async saveSnapshot(): Promise<void> { await this.ports.save(this.getData()); }
  private emit(): void { this.ports.state(this.getState()); }
}
