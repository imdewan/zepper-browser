# Zepper

A calm, beautiful browser with Spaces, persistent pinned tabs and built-in ad blocking: Zen Browser's UX on Chromium, built with Electron.

## Run

```bash
npm install
npm run dev
```

`npm run typecheck` type-checks main, preload and renderers. `npm run dist` builds a macOS app.

## Layout

| Path | What it is |
|---|---|
| `src/main/` | Main process: browser state (spaces, tabs, pins), web views, ad blocking, permissions, menus, persistence |
| `src/preload/` | `index.ts` bridges the browser UI to the main process; `page.ts` runs in web pages to detect swipe gestures |
| `src/renderer/src/chrome/` | Window chrome under the web views: sidebar, Essentials, spaces, content card |
| `src/renderer/src/overlay/` | Transparent layer above web views: command palette, toasts, popovers, settings, compact-mode peek |
| `src/shared/` | Types, settings and theme helpers shared by every process |
| `docs/` | Feature list (`FEATURES.md`), visual reference and research notes |

In development, a debug endpoint on `127.0.0.1:9876` can capture each layer and send commands. It is never started in packaged builds.
