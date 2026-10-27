# Bilibili Time Machine

**Set a cutoff date for Bilibili and hide content from after that moment.**

Filter videos, comments, and XML danmaku (on-screen comments) on current Bilibili pages while keeping the native layout. Available as a Tampermonkey userscript and a Chrome extension, both sharing the same filtering core.

[简体中文](README.md) · [Install userscript](https://greasyfork.org/en/scripts/601594) · [Download extension](https://github.com/LeKZzzz/bilibili-time-machine/releases) · [Report an issue](https://github.com/LeKZzzz/bilibili-time-machine/issues)

> This is a time filter, not a web archive. It filters content that remains available; it cannot restore historical homepages, deleted videos, or past recommendation rankings. Content at or after the cutoff, or with an unverifiable timestamp, is hidden.

## Preview

| Time filter and homepage filling | Favorite folders | Interest tags |
| --- | --- | --- |
| <img src="assets/screenshots/panel.png" width="280" alt="Main panel with cutoff time, filtering controls, and favorites-based homepage filling"> | <img src="assets/screenshots/folders.png" width="280" alt="Favorite folder selection with reading limits and save controls"> | <img src="assets/screenshots/tags.png" width="280" alt="Interest tags and matching saved-video counts"> |

Screenshots are from the `v0.2.1` source, with sample folders and tags rather than real account data. This README describes the current source; installed releases may differ. The interface is in Chinese, so the instructions include the actual button labels.

## Features

- **Browse with a time cutoff:** filter video cards and thumbnails, loaded comments and replies, and XML danmaku.
- **Fill sparse search results:** when fewer than half a page of results remain visible, fetch up to two more pages and deduplicate them, then restore the original page number and URL.
- **Fill homepage gaps from your favorites:** use tags from selected favorite folders to find videos before the cutoff, without rearranging existing visible cards.
- **Let the clock advance:** optionally move the cutoff forward by elapsed whole minutes, continuing after a page refresh.
- **Pause at any time:** adjust the cutoff, pause filtering, and manage favorite sources from an in-page panel.
- **Animation playlists and public-service ads:** alternate between shows or play each show in order. Animation mode allows mid-roll ads; ordinary viewing offers optional ads at the end of a video. This feature is implemented in the current source but has not been released.

Time filtering supports the homepage, video pages, categories, search, profile video lists, and the activity feed on `www.bilibili.com`, `search.bilibili.com`, `space.bilibili.com`, and `t.bilibili.com`. Independent playback also supports video and bangumi playback pages on `www.bilibili.com`; this does not imply full time-filtering support for bangumi pages. Other unrecognized routes retain only the settings entry point.

**On this page:** [Installation](#installation) · [Usage](#usage) · [Data and caching](#data-and-caching) · [Troubleshooting and limitations](#troubleshooting-and-limitations) · [Contributing](#contributing)

## Installation

Choose **either the extension or the userscript**, not both on the same page. Normal use does not require Node.js or a source build.

### Userscript (recommended)

1. Install and enable [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open [Bilibili Time Machine on Greasy Fork](https://greasyfork.org/en/scripts/601594), click **Install this script**, and confirm in Tampermonkey.
3. Refresh Bilibili and click “时光机” (Time Machine) to configure it.

To update, check for updates in Tampermonkey or install the latest version from Greasy Fork. Greasy Fork is the official userscript installation channel. It is published separately from GitHub Releases, so versions may differ.

### Chrome extension

1. Open [GitHub Releases](https://github.com/LeKZzzz/bilibili-time-machine/releases), download `bilibili-time-machine-extension-vX.Y.Z.zip` from the chosen release's **Assets**, and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted directory that **directly contains `manifest.json`**.
4. Refresh Bilibili.

Chrome cannot load the ZIP directly. GitHub's automatically generated **Source code** archives are not installable packages either. To update, extract and load the new version, confirm the version in the extensions manager, and refresh Bilibili.

<details>
<summary>Other downloads: release userscripts and Actions builds</summary>

Releases also provide `bilibili-time-machine.user.js` and `bilibili-time-machine-userscript-vX.Y.Z.zip`. Both contain the same production userscript. Extract the ZIP first, then import the script into Tampermonkey, or replace the default template in its script editor and save.

Assets may still be building immediately after a release is published. If they are missing, check the corresponding Actions run.

To try a branch build, sign in to GitHub, open a successful **Build** run for that branch in [Actions](https://github.com/LeKZzzz/bilibili-time-machine/actions), and download an **Artifact**:

| Artifact | Purpose |
| --- | --- |
| `bilibili-time-machine-release` | Production build without project diagnostic logs |
| `bilibili-time-machine-dev` | Development build with local, sanitized logs |

After extraction, load `extension/` in Chrome or install `userscript/bilibili-time-machine.user.js` in Tampermonkey. An Actions build is not a formal Release and is not published to Greasy Fork.

</details>

## Usage

### Set a cutoff

1. Click “时光机” (Time Machine) on a Bilibili page.
2. Enter a date and time in your **local time zone**, then click “应用时间” (Apply time) or press Enter.
3. Click “开启过滤” (Enable filtering). To restore the full page later, pause filtering and refresh.

For example, a cutoff of `2020-01-01 00:00:00` keeps only content timestamped **strictly before** that moment. Videos use their publication time; comments and danmaku use their posting time.

| Control | Behavior |
| --- | --- |
| Date and time fields | Support seconds; edits take effect only when applied. “取消” (Cancel) restores the applied value |
| “填入当前时间” (Fill current time) | Fills the current hours, minutes, and seconds while keeping the selected date; still requires Apply |
| “现在” (Now) | Fills both the current date and time; still requires Apply |
| Automatic advancement | Advances by whole minutes without overwriting an edit in progress; applying a new time restarts the clock |
| “暂停过滤” (Pause filtering) | Stops filtering; refresh to recover content already removed from responses |

The extra-request budget in advanced settings is used to verify publication times of videos already encountered. It defaults to 20 videos per page or route, is configurable from 0–100, and allows up to 3 concurrent requests. Content whose time remains unknown after a failed request or an exhausted budget stays hidden.

### Fill homepage gaps from your favorites

This feature is off by default and fills only homepage slots hidden by time filtering. It requires access to your Bilibili favorite folders.

1. Enable “收藏偏好补充首页” (Fill homepage using favorite preferences) and select folders when prompted.
2. In “选择收藏夹” (Select favorite folders), choose sources and reading limits, then click “保存” (Save) to build your preferences.
3. Return to the homepage. If gaps remain, click “继续寻找” (Keep looking), or scroll down and stop to start another round.
4. After changing your saved videos, click “更新收藏偏好” (Update favorite preferences). “查看兴趣标签” (View interest tags) shows the extracted tags.

The default is **up to 3 folders, reading 50 videos per folder**. Limits can be set to 1–10 folders and 1–200 videos per folder. Selections over the limit must be adjusted before saving. Canceling, going back, closing the panel, or pressing Escape discards unsaved edits.

Candidates are randomly selected using tag preferences and deduplicated, with at most 5 search requests per round. Gaps may remain when no eligible videos are found: the cutoff is never relaxed, and visible cards are not replaced.

“同步收藏夹名称” (Sync folder names) refreshes the list after folders are created, deleted, or renamed; it does not update video tags. Preferences for selected sources can still be updated while filtering is paused or away from the homepage. Disabling filling stops its tasks but keeps cached data and selections. Closing the panel alone does not cancel submitted tasks.

### Animation playlists and public-service ads (unreleased)

Open the animation entry in the Time Machine panel to enter “童年放映室” (Childhood Screening Room). No cutoff or enabled time filter is required, and playback settings do not change filtering settings. The current animation entry is exempt from publication-time filtering; recommendations and comments retain the existing filtering rules.

1. The default playlist contains two verified entries each from “猪猪侠之魔幻猪猡纪” and “开心超人”. Add a work, then add a video, a specific part, or a bangumi `ep` link; entries can also be removed. The tool does not search for or expand an entire season automatically.
2. Choose round-robin (one entry from each work) or sequential playback (finish one work first), save settings, then click “从头播放” (Start from the beginning). The complete playlist loops; shorter works wait until the other works finish the round.
3. Animation ads default to on, with a notice before starting; ordinary-viewing ads default to off. Both modes share an ad list and interval, initially 20 minutes, but track their own actual viewing time. Pauses, buffering, seeks, and ad playback do not add viewing time; playback speed does not accelerate the clock.
4. Animation pauses for an ad when due. Ordinary viewing waits until the current video ends, without queuing multiple ads. “跳过广告” (Skip ad) is available even while loading. Ending or skipping clears the overlay and resumes animation or releases native end-of-video behavior; a native pause-at-end setting is respected.
5. “暂停” pauses the session; “退出连播” exits and saves progress. Reloading, reopening, or opening a new tab does not start animation automatically. Use “继续观看” (Resume) to continue. Navigating away ends the session; exit before editing the animation playlist or its order.

Use “点击继续播放” when autoplay is blocked or startup positioning conflicts. Buffering, pauses, and autoplay restrictions do not make a source invalid. Entries explicitly limited to previews, lacking full access, or unavailable are skipped; playback stops if the entire list is unavailable. Membership and regional restrictions are not bypassed. Ads use full same-origin Bilibili pages, so loading overhead and player changes affect availability. A failed ad clears its overlay without immediately inserting another. Ads stay within the current document; cross-document episode changes do not guarantee fullscreen preservation.

Real Chrome MV3 regression testing on 2026-10-27 covered ordinary animation transitions, startup and stable resume, plus a member-only episode's scheduling, resume, and ad recovery. This does not cover every member source, page variant, or userscript workflow. Remaining userscript combinations, current member-player native fullscreen, and continuous-buffering samples still need verification. Local builds do not update GitHub or Greasy Fork releases.

## Data and caching

Playback settings, playlists, and resume progress use userscript GM storage or the extension's `chrome.storage.local`, separately from filtering settings. They do not automatically sync between the two installation methods. Scheduled transitions save before navigating; progress is also saved periodically and on page exit. Forcibly closing the browser may lose the last unsaved seconds.

Folder names are stored in the current Bilibili site's `localStorage`. Tag snapshots, search candidates, and filling history are stored locally in `IndexedDB`. Both are separated by Bilibili UID. Related requests retrieve favorites, query video information, and search for candidates.

| Cache | Lifetime | Per-account limit |
| --- | --- | --- |
| Favorite tag snapshot | 24 hours | 100 scored tags |
| Search candidates | 7 days | 500 entries |
| Previously inserted videos | 30 days | 1,000 entries |

- Caches can be reused across reloads, tabs, and routes on the same origin; different Bilibili subdomains do not share them.
- Tag snapshots are checked on read and rebuilt when expired, not refreshed by an independent background timer.
- Favorite content is not read and tag searches are not started when filling is disabled or no folders are selected.
- Deduplication history expires, so videos are not guaranteed to stay excluded forever. Without the IndexedDB API, those caches remain in page memory only.
- Development builds write sanitized diagnostic logs only to the current browser console; they do not upload them. Logs exclude response bodies, comment text, cookies, and full URLs. Production builds omit project diagnostic logs.

## Troubleshooting and limitations

| Problem | What to check |
| --- | --- |
| No “时光机” entry point | Confirm the extension or userscript is enabled and the page is supported. Refresh the page after reloading the extension |
| Homepage gaps are not filled | Use `www.bilibili.com/`, enable filtering and filling, select folders, and make sure hidden card slots exist. Gaps remain if no eligible candidates are available |
| Content cannot be verified and is hidden | Its timestamp is unknown or a lookup failed. Try adjusting the extra-request budget in advanced settings |
| Favorites-based filling fails | Follow the panel feedback to update preferences or keep looking again. Normal time filtering continues |
| Old interface after an update | Reload the extension directory actually in use, then refresh the page. For userscripts, confirm the new version was saved |
| Content is still missing after pausing | Refresh the page to fetch data previously removed from responses |

**Known limitations:** comment filtering covers only loaded comments; it does not fetch the full comment history. Protobuf segmented danmaku is not supported. Coverage of all infinite-scroll batches and some Bilibili page variants still needs further verification; site-wide coverage is not guaranteed.

## Contributing

Compatibility reports, documentation improvements, and fixes are welcome. Search [Issues](https://github.com/LeKZzzz/bilibili-time-machine/issues) before reporting a problem, and include the installed version, browser version, installation method, page type, reproduction steps, and sanitized error information. Do not share cookies, credentials, or personal account data.

### Build from source

Use **Node.js 22** (matching CI), npm, and Git:

```sh
git clone https://github.com/LeKZzzz/bilibili-time-machine.git
cd bilibili-time-machine
npm ci
npm run build
```

`npm run build` runs type checking and the full test suite before producing both production outputs:

| Output | Local installation |
| --- | --- |
| `dist/extension/` | Use Chrome's **Load unpacked** option |
| `dist/userscript/bilibili-time-machine.user.js` | Import into Tampermonkey, or replace the script editor contents and save |

The public `main` branch does not include a prebuilt `dist/`. After rebuilding, reload the extension or reimport/update the userscript, then refresh Bilibili.

### Development and checks

When submitting a pull request, describe your changes and verification results.

```sh
npm ci
npm run typecheck
npm test -- --run
npm run build
npm run build:dev
```

Run the four check and build commands above before committing. Development outputs are in `dist/dev/extension/` and `dist/dev/userscript/` and install the same way as production builds. Their console logs use the `[时光机]` prefix. Do not enable production and development builds at the same time.

The project uses TypeScript, Vite, Vitest, and jsdom. The native TypeScript settings panel uses styles compiled with Tailwind CSS and daisyUI, injected into a Shadow DOM without a CDN dependency.

| Directory | Responsibility |
| --- | --- |
| `src/core/` | Time rules, tag scoring, candidate selection, and storage |
| `src/page/` | Response filtering and initial page state handling |
| `src/runtime/` | Extension/userscript adapters, messaging, and page lifecycle |
| `src/playback/` | Animation playlists, playback sessions, ads, player integration, and persistence bridging |
| `src/routes/`, `src/ui/` | Route support, settings panel, and notices |
| `extension/`, `userscript/` | Extension manifest and userscript entry points |
| `tests/` | Fixtures, unit tests, and integration tests |

<details>
<summary>Maintainers: automated builds and releases</summary>

`.github/workflows/build.yml` runs on pushes or manual dispatch. It executes `npm ci`, `npm run build`, and `npm run build:dev`, then uploads production and development Artifacts. It does not create a Release.

To publish a release:

1. Finish verification. Set the version to `X.Y.Z` in `package.json`, the root package versions in `package-lock.json`, `extension/manifest.json`, and the userscript metadata in `vite.config.ts`.
2. Create a `vX.Y.Z` tag on the commit to release and **publish a GitHub Release**. Pushing a tag or saving a draft alone does not trigger asset builds.
3. Wait for `.github/workflows/release.yml` to build the tag, check version consistency, and upload the three production assets: the extension ZIP, userscript ZIP, and standalone `.user.js`. Check the Actions result, download the assets, and verify installation.

The Release workflow uses the built-in `GITHUB_TOKEN`, not a PAT. It does not upload development builds, publish to extension stores, create signed CRX files, or update Greasy Fork. A partial upload failure may leave some assets in place; rerunning uses `gh release upload --clobber` to complete or overwrite same-named assets without rewriting the tag.

</details>

## License

Licensed under the [MIT License](LICENSE).
