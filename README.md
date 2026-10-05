# Zepper

A calm, beautiful browser with Spaces, persistent pinned tabs and built-in ad blocking: Zen Browser's UX on Chromium, built with Electron.

## Run

```bash
npm install
npm run dev
```

`npm run typecheck` type-checks main, preload and renderers. `npm run dist` builds a macOS app.

## Protected video (Widevine)

Zepper runs on [castLabs' Electron for Content Security](https://github.com/castlabs/electron-releases), which adds Google Widevine. It's off until you turn it on (Settings → Media, or the prompt a site like Netflix triggers); installing it restarts Zepper once.

Streaming services also require the app to be **VMP-signed** with a production certificate from castLabs' free EVS service; the castLabs build only carries a development one. One-time setup:

```bash
python3 -m venv .evs && .evs/bin/pip install castlabs-evs
npm run vmp:signup     # create your EVS account (asks for email, name, password; emails a code)
npm run vmp:sign       # sign the development runtime in node_modules/electron/dist
```

Re-run `npm run vmp:sign` after reinstalling Electron, and `npm run vmp:login` when the login expires. `npm run dist` signs the packaged app automatically (`scripts/vmp-sign.cjs`, before Apple code signing). `npm run vmp:verify` shows which certificate the runtime has.

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
