import { createPlaybackPlayer, type PlaybackPlayer } from './player';

export const CONTROLLED_PLAYBACK_FRAME = 'bilibili-time-machine-ad';

export function createAdvertisementOverlay(options: {
  url: string;
  window?: Window;
  player: PlaybackPlayer;
  onFinish(reason: 'ended' | 'skipped' | 'error'): void;
  onBlocked?(): void;
  onPlaying?(): void;
}): { destroy(): void; resume(): void } {
  const original = options.player.media();
  const document = original?.ownerDocument ?? (options.window ?? window).document;
  const page = options.window ?? document.defaultView!;
  const previousFocus = document.activeElement as HTMLElement | null;
  const host = document.fullscreenElement ?? original?.closest('.bpx-player-container, #bilibili-player, #bilibiliPlayer') ?? document.body;
  const layer = document.createElement('div');
  layer.dataset.timeMachineAd = '';
  layer.setAttribute('role', 'region');
  layer.setAttribute('aria-label', '公益广告');
  layer.style.cssText = 'position:absolute;inset:0;z-index:2147483647;background:#080b10;box-shadow:0 0 0 100vmax #000b;overflow:hidden;';
  const root = layer.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{color:white}iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
    .controls{position:absolute;z-index:2;display:flex;gap:8px;flex-wrap:wrap;max-width:calc(100vw - 24px)}
    .controls[popover]{position:fixed;inset:auto;margin:0;border:0;padding:0;background:transparent;overflow:visible}
    button{font:600 14px sans-serif;min-height:44px;padding:10px 16px;border:2px solid white;border-radius:8px;background:#17212e;color:white;cursor:pointer}
    button:focus-visible{outline:3px solid #ffd35c;outline-offset:3px}.resume[hidden]{display:none}
    .loading{position:absolute;left:12px;bottom:12px;background:#17212e;padding:8px;font:14px sans-serif}
  </style><div class="loading" role="status">正在加载公益广告，可随时跳过</div><div class="controls"><button class="skip" type="button">跳过广告</button><button class="resume" type="button" hidden>点击继续播放</button></div>`;
  const skip = root.querySelector<HTMLButtonElement>('.skip')!;
  const resume = root.querySelector<HTMLButtonElement>('.resume')!;
  const controls = root.querySelector<HTMLElement>('.controls')!;
  const usesPopover = typeof controls.showPopover === 'function';
  if (usesPopover) controls.setAttribute('popover', 'manual');
  const frame = document.createElement('iframe');
  frame.name = CONTROLLED_PLAYBACK_FRAME;
  frame.title = '公益广告播放器';
  frame.allow = 'autoplay';
  let adPlayer: PlaybackPlayer | null = null;
  let done = false;
  let requestedPlay = false;
  let lastMedia: HTMLVideoElement | null = null;
  const hostElement = host as HTMLElement;
  const oldPosition = hostElement.style.position;
  const changedPosition = page.getComputedStyle(hostElement).position === 'static';
  if (changedPosition) hostElement.style.position = 'relative';
  const positionControls = () => {
    if (done) return;
    const bounds = layer.getBoundingClientRect();
    if (usesPopover) {
      // 控件进入顶层，避免窄屏下被站点祖先或设置面板的堆叠上下文遮挡。
      if (!controls.matches(':popover-open')) controls.showPopover();
      const size = controls.getBoundingClientRect();
      controls.style.left = `${Math.max(12, Math.min(Math.max(12, bounds.left + 12), page.innerWidth - size.width - 12))}px`;
      controls.style.top = `${Math.max(12, Math.min(Math.max(12, bounds.top + 12), page.innerHeight - size.height - 12))}px`;
    } else {
      controls.style.left = `${Math.max(12, 12 - bounds.left)}px`;
      controls.style.top = `${Math.max(12, 12 - bounds.top)}px`;
    }
  };
  const preventOriginalPlayback = (event: Event) => {
    if (event.target === options.player.media() || event.target === original) (event.target as HTMLMediaElement).pause();
  };
  const onFullscreenChange = () => {
    // 全屏元素也在顶层；重新展示控件，使其排在新的全屏根节点上方。
    if (usesPopover) controls.hidePopover();
    positionControls();
  };
  const destroy = () => {
    if (done) return;
    done = true;
    page.clearInterval(timer);
    page.clearTimeout(loadTimeout);
    adPlayer?.pause();
    adPlayer?.destroy();
    frame.src = 'about:blank';
    if (usesPopover) controls.hidePopover();
    layer.remove();
    document.removeEventListener('play', preventOriginalPlayback, true);
    page.removeEventListener('resize', positionControls);
    page.removeEventListener('scroll', positionControls, true);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    if (changedPosition) hostElement.style.position = oldPosition;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else if (original?.isConnected) original.focus({ preventScroll: true });
  };
  const finish = (reason: 'ended' | 'skipped' | 'error') => {
    if (done) return;
    destroy();
    options.onFinish(reason);
  };
  const continueAd = () => { resume.hidden = true; void adPlayer?.play(); };
  skip.addEventListener('click', () => finish('skipped'));
  resume.addEventListener('click', continueAd);
  document.addEventListener('play', preventOriginalPlayback, true);
  options.player.pause();
  host.appendChild(layer);
  positionControls();
  skip.focus({ preventScroll: true });
  page.addEventListener('resize', positionControls);
  page.addEventListener('scroll', positionControls, true);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  frame.addEventListener('error', () => finish('error'));
  frame.addEventListener('load', () => {
    if (done) return;
    try {
      const child = frame.contentWindow!;
      const childDocument = child.document;
      const style = childDocument.createElement('style');
      style.textContent = 'html,body{margin:0!important;overflow:hidden!important}.bpx-player-container,#bilibili-player,#bilibiliPlayer{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important}';
      childDocument.head.appendChild(style);
      adPlayer?.destroy();
      requestedPlay = false;
      adPlayer = createPlaybackPlayer({
        window: child,
        shouldHoldEnded: () => true,
        onEvent(event) {
          if (event.type === 'ended') finish('ended');
          else if (event.type === 'unavailable') finish('error');
          else if (event.type === 'blocked') { resume.hidden = false; options.onBlocked?.(); }
          else if (event.type === 'playing') { root.querySelector('.loading')?.remove(); options.onPlaying?.(); }
        },
      });
    } catch { finish('error'); }
  });
  const timer = page.setInterval(() => {
    if (done) return;
    options.player.pause();
    const media = adPlayer?.media();
    if (media) page.clearTimeout(loadTimeout);
    if (media !== lastMedia) { lastMedia = media ?? null; requestedPlay = false; }
    if (media && !requestedPlay) { requestedPlay = true; void adPlayer?.play(); }
  }, 250);
  // 仅限制播放器首次载入；媒体出现后的暂停和缓冲不设失败倒计时。
  const loadTimeout = page.setTimeout(() => finish('error'), 30_000);
  try {
    const url = new URL(options.url, page.location.href);
    if (url.origin !== page.location.origin || !/^\/(video\/|bangumi\/play\/)/.test(url.pathname)) throw new Error('Unsupported advertisement URL');
    frame.src = url.href;
    root.prepend(frame);
  } catch { queueMicrotask(() => finish('error')); }
  return { destroy, resume: continueAd };
}
