<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Zepper icon">
</p>

<h1 align="center">Zepper</h1>

<p align="center">
  A calm browser for macOS with Spaces, a vertical sidebar and built-in ad blocking, on Chromium.
</p>

<p align="center">
  <img src="docs/screenshot.png" width="900" alt="Zepper with the sidebar, Essentials, pinned tabs and a page">
</p>

## Features

**Spaces.** Group tabs into spaces, each with its own gradient theme and, optionally, its own sign-ins (cookies, logins and site data). Swipe between spaces on the trackpad, or pick one from the chevron next to the space name.

**A sidebar built for tabs.**

- Essentials, a grid of sites shared by every space.
- Pinned tabs per space that survive restarts, with nestable folders.
- Drag and drop for tabs and folders: reorder, pin or unpin, add to Essentials, or move to another space.
- Split view, up to four tabs side by side, stacked or in a grid.
- Tidy: groups related tabs into folders using Apple Intelligence, on the Mac (macOS 26 and later). Elsewhere it groups tabs by site.
- Compact mode hides the sidebar until you reach for the window edge.

**Command bar.** ⌘T to search, enter an address or switch to an open tab. DuckDuckGo bangs (`!yt cats`, `!gh electron`) resolve locally, so they go straight to the site.

**Privacy.**

- Ad and tracker blocking with uBlock Origin's filter lists, including YouTube ads. It can be turned off per site.
- Pop-up blocking.
- Private windows with a throwaway session.
- Global Privacy Control.
- A choice of browser identity: Chrome, Edge, Firefox, Safari or a custom string.

**Media.**

- A now-playing card for audio in other tabs, with a nudge to pause what's already playing.
- Automatic picture-in-picture when you leave a playing video, with ±10s controls.
- Optional Google Widevine for protected video (see [Protected video](#protected-video-widevine)).

**Also:**

- Chrome Web Store extensions, managed from Settings.
- A downloads window and a searchable history page.
- Page dialogs that say which site is asking.
- Certificate details and per-site permissions behind the lock icon.
- Trackpad swipes to go back and forward.

## Getting started

Requires macOS, Node.js 22+ and npm 11.

```bash
npm install
npm run dev
```

| Command                | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `npm run dev`          | Runs Zepper with hot reload for the UI                                   |
| `npm run check`        | Type-checks, lints and checks formatting                                 |
| `npm run build`        | Bundles main, preload and UI into `out/`                                 |
| `npm run dist`         | Builds the macOS app into `dist/`                                        |
| `npm run build:native` | Builds the Tidy helper (`native/tidy`) into `build/bin/`. Needs Xcode 26 |
| `npm run brand:dev`    | Shows the development runtime as "Zepper" in the menu bar and Dock       |

## Protected video (Widevine)

Zepper runs on [castLabs' Electron for Content Security](https://github.com/castlabs/electron-releases), which adds Google Widevine. It's off until you turn it on in Settings → Media, or accept the prompt a site like Netflix triggers. Installing it restarts Zepper once.

Streaming services also require the app to be **VMP-signed** with a production certificate from castLabs' free EVS service; the castLabs build carries only a development one. One-time setup:

```bash
python3 -m venv .evs && .evs/bin/pip install castlabs-evs
npm run vmp:signup     # create your EVS account (asks for email, name, password; emails a code)
npm run vmp:sign       # sign the development runtime in node_modules/electron/dist
```

Re-run `npm run vmp:sign` after reinstalling Electron, and `npm run vmp:login` when the login expires. `npm run dist` signs the packaged app automatically, before Apple code signing (`scripts/vmp-sign.cjs`). `npm run vmp:verify` shows which certificate the runtime has.

## Keyboard shortcuts

| Action                                        | Keys                  |
| --------------------------------------------- | --------------------- |
| Command bar / new tab · open location         | ⌘T · ⌘L               |
| Close tab · reopen closed tab                 | ⌘W · ⇧⌘T              |
| Recent tab · next/previous tab                | ⌃⇥ · ⌥⌘↓ / ⌥⌘↑        |
| Space 1–9 · next/previous space               | ⌃1…⌃9 · ⌥⌘→ / ⌥⌘←     |
| Essential 1–9 · tab 1–8 / last                | ⌥1…⌥9 · ⌘1…⌘8 / ⌘9    |
| Pin / unpin · clear unpinned tabs             | ⌘D · ⇧⌘K              |
| Compact mode · find in page                   | ⌘S · ⌘F               |
| Split side by side / stacked / grid · unsplit | ⌥⌘V / ⌥⌘H / ⌥⌘G · ⌥⌘U |
| History · downloads                           | ⌘Y · ⌥⌘L              |
| New window · new private window               | ⌘N · ⇧⌘N              |
| Copy URL · copy as Markdown                   | ⇧⌘C · ⌥⇧⌘C            |

## Project layout

| Path                        | What it is                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`                 | Main process: windows, tabs and spaces, sessions and profiles, ad blocking, extensions, downloads, persistence                                     |
| `src/preload/`              | `index.ts` bridges the browser UI to the main process; `page.ts` runs in every web page (cosmetic filtering, compatibility shims, dialogs, swipes) |
| `src/renderer/src/chrome/`  | The sidebar and content card, drawn under the web pages                                                                                            |
| `src/renderer/src/overlay/` | A transparent layer above the pages: command bar, popovers, settings, dialogs, history, downloads                                                  |
| `src/renderer/src/pip/`     | Controls for the floating picture-in-picture player                                                                                                |
| `src/shared/`               | Types, settings and theme helpers shared by every process                                                                                          |
| `native/tidy/`              | A small Swift helper that asks Apple Intelligence to group tabs                                                                                    |
| `docs/`                     | [Architecture](docs/ARCHITECTURE.md) and the [feature list](docs/FEATURES.md)                                                                      |

How the pieces fit together is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
