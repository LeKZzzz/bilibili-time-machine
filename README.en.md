# Bilibili Time Machine

**Browse Bilibili with a date in the past, or turn childhood cartoons into a looping channel.**

Bilibili Time Machine combines time filtering, animation playlists, and optional public-service ad breaks. Browse videos and comments from before a chosen date, or build a playlist of your favorite cartoons to alternate between shows or watch in order, with occasional public-service clips. It keeps Bilibili's native pages and player and is available as a Chrome extension or Tampermonkey userscript.

[简体中文](README.md) · [Download extension](https://github.com/LeKZzzz/bilibili-time-machine/releases) · [Install userscript](https://greasyfork.org/en/scripts/601594) · [Report an issue](https://github.com/LeKZzzz/bilibili-time-machine/issues)

## What you can do

| What you want | How it works |
| --- | --- |
| See only content from before a chosen date | Set a cutoff to filter video cards, loaded comments, and XML danmaku; optionally let the cutoff advance with time |
| Watch cartoons like a TV channel | Arrange shows and episodes in the Childhood Screening Room, alternate between shows or finish one at a time, and resume saved progress |
| Add public-service ad breaks | Choose clips and an interval; animation can pause mid-episode, while ordinary viewing waits until the video ends. Ads are always skippable |
| Leave fewer gaps on the filtered homepage | Use tags from your favorite folders to find videos before the cutoff, filling empty slots without replacing visible content |

**Time filtering and playback are independent.** Animation does not require a cutoff or an enabled filter. With filtering enabled, the current animation entry is exempt, while recommendations and comments keep their existing filtering rules.

The tool uses content still available on Bilibili. It cannot restore historical homepages, deleted videos, or past recommendation rankings, and does not bypass membership or regional restrictions.

[Installation](#installation) · [Watch animation](#watch-animation-childhood-screening-room) · [Ad breaks](#configure-public-service-ads) · [Browse by date](#browse-with-a-date-in-the-past) · [Troubleshooting](#troubleshooting-and-limitations) · [Contributing](#contributing)

<details>
<summary>Preview: time filtering, Childhood Screening Room, and favorite preferences</summary>

| Time filtering | Childhood Screening Room |
| --- | --- |
| <img src="assets/screenshots/panel.png" width="320" alt="Current time-filter panel with the animation channel entry"> | <img src="assets/screenshots/playback.png" width="320" alt="Childhood Screening Room: custom playlists, playback order, and ad settings"> |

| Favorite folders | Interest tags |
| --- | --- |
| <img src="assets/screenshots/folders.png" width="320" alt="Favorite folder sources, reading limits, and save controls"> | <img src="assets/screenshots/tags.png" width="320" alt="Interest tags extracted from sample favorites"> |

Screenshots use the actual `v0.3.0` UI components with demo data, not personal favorites. The sample shows illustrate the playlist and can be replaced with your own choices.

</details>

## Installation

**Choose either the extension or the userscript. Do not enable both.** Normal use does not require Node.js or a source build.

### Chrome extension

1. Download `bilibili-time-machine-extension-vX.Y.Z.zip` from **Assets** on [GitHub Releases](https://github.com/LeKZzzz/bilibili-time-machine/releases) and extract it.
2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
3. Select the directory that **directly contains `manifest.json`**, refresh Bilibili, and click “时光机” (Time Machine).

To update, load the new directory, confirm the extension version, and refresh Bilibili. Do not use the Release's **Source code** archives; they are not installable packages.

### Tampermonkey userscript

1. Install and enable [Tampermonkey](https://www.tampermonkey.net/).
2. Open [Bilibili Time Machine on Greasy Fork](https://greasyfork.org/en/scripts/601594), click **Install this script**, and confirm in Tampermonkey.
3. Refresh Bilibili and click “时光机” (Time Machine). You can check for later updates in Tampermonkey.

**Animation and ad features require `v0.3.0` or later.** Greasy Fork and GitHub are published separately, so their versions may differ. If Greasy Fork has not been updated yet, download `bilibili-time-machine.user.js` from a GitHub Release and import it into Tampermonkey. The extracted `bilibili-time-machine-userscript-vX.Y.Z.zip` contains the same script.

## Watch animation: Childhood Screening Room

Open **“时光机” (Time Machine) → “动画时光机” (Animation Time Machine) → “打开频道” (Open channel)**. The interface is in Chinese; the instructions below include the actual control labels.

1. Try the built-in sample playlist, or click “添加作品” (Add show), enter a Bilibili link for an animation you want to watch, and click “添加条目” (Add entry). BV videos, specific parts, and bangumi `ep` links are supported. Each link is one entry; entire seasons are not imported automatically.
2. Choose “轮播 · 每部各播一集” (Round-robin: one episode per show) or “顺播 · 看完一部再下一部” (Sequential: finish one show first). Click “保存设置” (Save settings), then “从头播放” (Start from the beginning).
3. Click “暂停” (Pause) for a break, or “退出连播” (Exit continuous playback) to end the session and retain progress. Next time, open the channel and click “继续观看” (Resume).

For a show A with two episodes and a show B with three:

| Order | Example |
| --- | --- |
| Round-robin | A1 → B1 → A2 → B2 → B3 → A1 in the next round |
| Sequential | A1 → A2 → B1 → B2 → B3 → A1 in the next round |

The playlist loops after every entry has played. Each show needs at least one entry. Exit continuous playback before editing the playlist or order, and save your changes. Reloading, reopening the browser, or opening a new tab does not start animation automatically; choose Resume yourself. Navigating away from the current entry also ends the session.

> Mid-episode animation ads are on by default, with a 20-minute interval. For uninterrupted animation, turn off “动画中途插播” (Animation mid-roll ads) and save settings.

## Configure public-service ads

Manage ad links, switches, and the interval in “童年放映室” (Childhood Screening Room). Two sample clips are included: “妈妈，洗脚” and “关爱老人，用心开始”. You can add or remove entries.

| Setting | Default | When an ad plays | After it ends or is skipped |
| --- | --- | --- | --- |
| “动画中途插播” (Animation mid-roll ads) | On | Pauses the current animation when accumulated viewing reaches the interval | Resumes the animation from its paused position |
| “普通观看片尾插播” (Ordinary-viewing end-of-video ads) | Off | Waits until the current video ends after the interval is reached | Returns control to Bilibili's native autoplay; a pause-at-end setting stays paused |

Ads appear over the current player with the surroundings dimmed. **“跳过广告” (Skip ad) works during both loading and playback.** If an ad fails to load, its overlay is removed without immediately inserting another.

Both modes share the ad list and interval but track viewing time separately. The default is **20 minutes of actual playback**. Pauses, buffering, seeks, and the ads themselves do not count; faster playback does not accelerate the timer. Ordinary viewing never interrupts a video mid-play and does not accumulate a backlog of ads.

## Browse with a date in the past

Open “时光机” (Time Machine), enter a date and time in your **local time zone**, click “应用时间” (Apply time) or press Enter, then click “开启过滤” (Enable filtering).

A cutoff of `2020-01-01 00:00:00`, for example, shows only content timestamped **strictly before** that moment. Videos use their publication time; comments and danmaku use their posting time. Content at or after the cutoff, or with an unverifiable timestamp, is hidden.

- Apply date and time edits before they take effect. “取消” (Cancel) restores the applied value.
- “现在” (Now) fills the current date and time. “填入当前时间” (Fill current time) changes only hours, minutes, and seconds, keeping the date.
- Automatic advancement moves the cutoff by elapsed whole minutes, continues after a refresh, and does not overwrite an edit in progress.
- To restore the full page, click “暂停过滤” (Pause filtering) and refresh so previously filtered response data can be loaded again.

Time filtering covers the homepage, video pages, categories, search, profile video lists, and the activity feed on `www.bilibili.com`, `search.bilibili.com`, `space.bilibili.com`, and `t.bilibili.com`. If fewer than half a page of search results remain visible, it fetches up to two more pages, deduplicates results, and restores the original page number and URL. Bangumi playback support does not imply complete time-filtering support for bangumi pages.

### Fill homepage gaps from your favorites

This feature is off by default and requires your current Bilibili account to have access to its favorite folders.

1. Enable “收藏偏好补充首页” (Fill homepage using favorite preferences), choose sources in “选择收藏夹” (Select favorite folders), and save.
2. Return to the homepage. If gaps remain, click “继续寻找” (Keep looking), or scroll down and stop to start another round.
3. After changing saved videos, click “更新收藏偏好” (Update favorite preferences). Use “查看兴趣标签” (View interest tags) to inspect the results. “同步收藏夹名称” (Sync folder names) updates only the folder list, not video tags.

The default is **up to 3 folders, reading 50 videos per folder**, adjustable in settings. Candidates are randomly selected using tag preferences and deduplicated, with at most 5 searches per round. If no suitable video is found, the gap remains; the cutoff is never relaxed.

## Troubleshooting and limitations

| Problem | Explanation or action |
| --- | --- |
| No entry point, or the old interface remains after an update | Check the installed version, enabled state, and supported page. Refresh Bilibili after reloading the extension. Do not enable the userscript and extension together |
| Animation does not start automatically | Follow the panel prompt and click “点击继续播放” (Click to continue playing); the browser may block autoplay. After a reload or reopening, use “继续观看” (Resume) |
| A bangumi entry is skipped | Explicit preview-only, inaccessible, or unavailable entries are skipped. Playback stops if the entire playlist is unavailable. Member-only content still requires the appropriate account access |
| Homepage gaps remain | Enable filtering and filling on the homepage and select favorite folders. A gap remains when no candidate meets the cutoff and deduplication rules |
| Content is hidden because its time cannot be verified | Try adjusting the extra-request budget in advanced settings. Content with an unknown timestamp is not allowed through |
| Progress differs after exiting or changing installation methods | Exiting saves progress, but the extension and userscript do not share storage. Forcibly closing the browser may lose the last unsaved seconds |

Comments are filtered only when loaded; the tool does not fetch the full comment history. Danmaku filtering currently supports XML, not protobuf segments. Changes to Bilibili pages and players can affect compatibility; site-wide coverage is not guaranteed.

Fullscreen is not guaranteed to survive episode changes that navigate between pages. Real Chrome extension regression testing has covered automatic transitions, resume, and ad recovery with a member-only sample. Some Tampermonkey combinations, native fullscreen on member content, and continuous buffering still need verification; these results do not guarantee every source will work.

## Data storage and privacy

Playback settings, playlists, and resume progress are stored locally for the current installation method and do not automatically sync between the extension and userscript. Favorite preferences are separated by Bilibili account. Favorite content is not read and tag searches are not started when filling is disabled or no folders are selected.

<details>
<summary>Storage, cache, and diagnostic details</summary>

- The userscript uses GM storage; the extension uses `chrome.storage.local`. Playback and filtering settings are stored separately.
- Folder names use the site's `localStorage`; tags, candidates, and filling history use `IndexedDB`. Pages on the same origin can reuse them, but different Bilibili subdomains cannot. Without IndexedDB, these caches stay in the current page's memory.
- Tag caches last 24 hours and hold up to 100 scored tags; search candidates last 7 days with up to 500 entries; filling history lasts 30 days with up to 1,000 entries. All are separated by account. Expiring caches mean deduplication is not permanent.
- Additional requests to verify video timestamps default to at most 20 videos per page or route, configurable from 0–100, with up to 3 concurrent requests. Favorite sources can be set to 1–10 folders and 1–200 videos per folder.
- Development builds write sanitized logs only to the current browser console; they do not upload them. Logs exclude response bodies, comment text, cookies, and full URLs. Production builds omit project diagnostic logs.

</details>

## Contributing

Report problems through [GitHub Issues](https://github.com/LeKZzzz/bilibili-time-machine/issues), including the installed version, installation method, browser version, page type, and reproduction steps. Do not share cookies, credentials, or personal account data.

### Build from source

You need **Node.js 22**, npm, and Git:

```sh
git clone https://github.com/LeKZzzz/bilibili-time-machine.git
cd bilibili-time-machine
npm ci
npm run build
```

The build runs type checking and all tests, then produces `dist/extension/` and `dist/userscript/bilibili-time-machine.user.js`. Load them using the installation steps above. After rebuilding, reload the extension or update the script, then refresh Bilibili. The public `main` branch does not include a prebuilt `dist/`.

<details>
<summary>Development checks and directory structure</summary>

Before committing, run:

```sh
npm run typecheck
npm test -- --run
npm run build
npm run build:dev
```

Development outputs are in `dist/dev/extension/` and `dist/dev/userscript/`, with console logs prefixed by `[时光机]`. Do not enable them alongside production builds. Pull requests should describe the changes and verification results.

The project uses TypeScript, Vite, Vitest, and jsdom. The settings panel uses native TypeScript, Tailwind CSS, and daisyUI, with compiled styles injected into a Shadow DOM and no CDN dependency.

| Directory | Responsibility |
| --- | --- |
| `src/core/`, `src/page/` | Time rules, favorite candidates, and page-content filtering |
| `src/playback/` | Animation playlists, playback sessions, ads, and resume |
| `src/runtime/` | Extension/userscript adapters, messaging, and page lifecycle |
| `src/routes/`, `src/ui/` | Page support, settings panels, and notices |
| `extension/`, `userscript/`, `tests/` | Entry points, manifest, and tests |

</details>

<details>
<summary>Maintainers: build artifacts and automatic releases</summary>

- **Actions builds:** `build.yml` checks, tests, and builds on pushes or manual runs. It provides the production Artifact `bilibili-time-machine-release` and development Artifact `bilibili-time-machine-dev`. Sign in to GitHub to download from a successful [Build run](https://github.com/LeKZzzz/bilibili-time-machine/actions), then use the extracted `extension/` or `userscript/` output.
- **GitHub Releases:** align the versions in `package.json`, the root package entries in `package-lock.json`, `extension/manifest.json`, and `vite.config.ts`, then push the public changes to `main`. `release.yml` checks the corresponding `vX.Y.Z`: published versions are skipped; otherwise it builds, validates versions, uploads the three production assets, and publishes the Release.
- **Retries:** rerun a failed workflow or dispatch it manually on `main`. An existing draft is completed using its original commit or existing tag, without rewriting tags or published versions. A tag-only push does not trigger publication. The workflow uses the built-in `GITHUB_TOKEN`, not a PAT.
- **Separate channels:** Actions Artifacts are not Releases. Publishing on GitHub does not update Greasy Fork or extension stores; Greasy Fork requires a separate publication.

</details>

## License

[MIT](LICENSE)
