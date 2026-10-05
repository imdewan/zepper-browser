# Architecture

Zepper is an Electron app: Chromium renders the pages and the browser's own UI is HTML. This page explains how it's put together.

## Processes and layers

Each window is a `BrowserWindow` with three kinds of content stacked on top of each other:

1. **Chrome** (`src/renderer/src/chrome/`): the window's own web contents. It draws the sidebar, the window background and the empty "content card" behind the page.
2. **Tabs**: one `WebContentsView` per loaded tab, placed over the content card (one view, or several in split view), with rounded corners.
3. **Overlay** (`src/renderer/src/overlay/`): a transparent `WebContentsView` on top. It hosts everything that must float above pages: the command bar, popovers, settings, dialogs, toasts, the floating sidebar in compact mode. Its size changes with what it shows (`hidden`, `corner` for toasts, `peek`, `full`), so pages stay clickable when it isn't needed.

The picture-in-picture player (`src/main/pip.ts`) moves a tab's view into a small floating panel window, with its own controls view (`src/renderer/src/pip/`).

## State flows one way

The **main process owns all state**. Renderers never change it directly:

- Main sends each window's renderers a **snapshot** (`Snapshot` in `src/shared/types.ts`): spaces, tabs, folders, settings, downloads and so on. Snapshots are coalesced to at most one per frame.
- Renderers send **commands** (`Command`, a tagged union) over IPC. Main applies them and sends a new snapshot.
- One-off UI events (open the command bar, start renaming) go from main to a renderer as `UiEvent`s.

`src/preload/index.ts` exposes this as `window.zepper`. When the UI is opened in a plain browser during development, `src/renderer/src/bridge.ts` substitutes a mock with sample data.

## Main process

| File | Responsibility |
|---|---|
| `index.ts` | Startup: user agent, Widevine wait, opening the first window, quitting |
| `hub.ts` | Services shared by all windows (history, settings, ad blocking, extensions, downloads, Widevine), IPC routing to the window that owns the sender, and setting up each browsing session |
| `browser.ts` | One window: spaces, tabs (Essentials, pinned, normal), the pinned-area folder tree, split view, layout, menus, permissions, page dialogs, gestures, persistence |
| `compat.ts` | Browser identity (user agent and client hints) and site-compatibility switches handed to pages |
| `adblock.ts` | The Ghostery engine with uBlock Origin's lists: network blocking per session, cosmetic filters, per-site allowlist |
| `extensions.ts` | Chrome extension APIs (`electron-chrome-extensions`) and the Chrome Web Store, plus enable/disable/remove |
| `downloads.ts`, `history.ts`, `bangs.ts` | The download list, browsing history, and local DuckDuckGo bang resolution |
| `site.ts` | Per-site permissions and captured certificate chains |
| `persist.ts`, `settings-store.ts` | Atomic, debounced JSON files under the user data folder |
| `devtools-server.ts` | Development-only debug endpoint (see below) |

### Windows

- **The main window** is persisted (`zepper-state.json`): spaces, tabs, folders, splits, sidebar width and window bounds.
- **New windows** (⌘N) start from the current space: its look, sign-ins, Essentials and pinned tabs. They aren't saved.
- **Private windows** get an in-memory session that is cleared when the window closes.

### Sessions and profiles

Each space has a `profile`. `'default'` is Electron's default session, which Essentials and extensions also use. Any other value is a persistent partition (`persist:space-<id>`) with its own cookies, storage and cache. `Hub.profileSession()` creates sessions on demand, and `Hub.attachSession()` wires every one up the same way: ad blocking, permissions, certificates, the page preload, headers and downloads.

A tab's page can't change session. When a tab moves to a space with a different profile, it is reloaded in the right one (`Browser.rehome`).

### Pinned area and folders

A space's pinned area is a tree: `space.pinnedItems` and each folder's `items` hold tab and folder ids in order. That tree is the source of truth. `this.tabs` keeps pinned tabs in the same flattened order, so code that walks tabs in sidebar order (cycling, ⌘1–9) works unchanged. Every move goes through `Browser.dropItem`, which drag and drop and the context menus both use.

## Pages: `src/preload/page.ts`

This runs in every frame of every page before the page's own scripts:

- **Cosmetic filtering.** Hiding rules and scriptlets are fetched synchronously, so they apply at document start (that's what defeats YouTube's ads). Generic rules follow as the page renders.
- **Compatibility.**
  - Hides Chromium-only APIs when presenting as Firefox or Safari.
  - On Google's sign-in page, fills in `window.chrome` and hides passkeys.
  - Refuses Widevine while it's turned off, and notices which sites ask for it.
- **Dialogs.** `alert`, `confirm` and `prompt` are routed to Zepper's own dialog through a synchronous IPC call that main answers when you respond.
- **Swipes.** Two-finger horizontal swipes are classified (vertical scroll, horizontal scroller, page-handled, or a swipe) and reported for back/forward.

Code run in the page's main world goes through `contextBridge.executeInMainWorld` and must be self-contained.

## Protected video

Zepper uses castLabs' Electron build. Widevine is opt-in: while it's off, `components.updatesEnabled` stays false so nothing is downloaded. castLabs' updater can only install on a launch where updates were on from the start, so turning Widevine on restarts Zepper once. Streaming services also need a production VMP signature (see the README).

## Development

- `npm run dev` runs Zepper with hot reload for the UI. Main-process changes need a restart.
- In development, a debug server listens on `127.0.0.1:9876`:
  - `/snapshot` and `/state`: what the window holds.
  - `/command`: send a command.
  - `/capture`: screenshots of each layer.
  - `/eval`: run code in the active page.
  - `/move`, `/drag`, `/wheel`: input.
- A second, isolated instance can run alongside your own: `ZEPPER_PROFILE=<folder> ZEPPER_DEBUG_PORT=9877 node_modules/.bin/electron .` (after `npm run build`). Stop it by the process listening on its port: `kill $(lsof -ti tcp:9877 -sTCP:LISTEN)`.
- `npm run check` runs type checking, ESLint and Prettier; CI runs the same on every push.

## Licensing note

`electron-chrome-extensions` is licensed under GPL-3.0 unless a commercial license is bought. `src/main/extensions.ts` uses it under GPL-3.0, which means Zepper's own source must be GPL-3.0-compatible if it's distributed.
