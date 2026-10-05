# Making Zepper your own

Zepper is meant to be forked. The whole browser UI is TypeScript, React and CSS on top of Electron, and Chromium comes prebuilt. There's no Chromium checkout to download and nothing to compile for hours: change a file and the UI reloads in about a second.

This guide shows where things live, so you can find them quickly in your fork.

## Getting started

```bash
# Fork on GitHub first, then:
git clone https://github.com/<you>/zepper-browser.git
cd zepper-browser
npm install
npm run dev
```

UI changes (`src/renderer/`) appear as soon as you save. Main-process changes (`src/main/`) need a restart of `npm run dev`.

To pick up later changes from this repository:

```bash
git remote add upstream https://github.com/imdewan/zepper-browser.git
git fetch upstream
git merge upstream/main
```

## Rebrand it

| What                                    | Where                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App name and bundle id                  | `package.json` → `build.productName` and `build.appId`; `app.setName('Zepper')` and the About options in `src/main/index.ts`                                   |
| App icon                                | `resources/icon.png` and `resources/icon-dark.png` (Dock), `build/icon.icns` (the packaged app); `scripts/make-icons.py` builds them from `resources/logo.png` |
| Logo in the About panel                 | `src/renderer/src/assets/logo.png`; the text is in `src/renderer/src/overlay/AboutPanel.tsx`                                                                   |
| Name in the menu bar during development | `scripts/brand-dev-runtime.mjs` (run `npm run brand:dev`)                                                                                                      |

## Change the look

| What                                    | Where                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Colours, radii, fonts (design tokens)   | CSS variables at the top of `src/renderer/src/styles/base.css`                             |
| Sidebar                                 | Components in `src/renderer/src/chrome/`, styles in `src/renderer/src/styles/chrome.css`   |
| Command bar, settings, popovers, toasts | Components in `src/renderer/src/overlay/`, styles in `src/renderer/src/styles/overlay.css` |
| Gradient presets offered for spaces     | `THEME_PRESET_GROUPS` in `src/shared/theme.ts`                                             |
| How a gradient is drawn                 | `themeBackground()` in `src/shared/theme.ts`                                               |
| Icons                                   | `src/renderer/src/icons.tsx` (small inline SVGs)                                           |
| First space on a fresh install          | `makeSpace('Personal', '😀', …)` in the `Browser` constructor, `src/main/browser.ts`       |

## Change the behaviour

| What                                                                    | Where                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Default settings                                                        | `DEFAULT_SETTINGS` in `src/shared/settings.ts`                                                                                 |
| Search engines                                                          | `SEARCH_ENGINES` in `src/shared/settings.ts`                                                                                   |
| Keyboard shortcuts and menus                                            | `src/main/menu.ts`                                                                                                             |
| DuckDuckGo bangs                                                        | `src/main/bangs.ts` (the bundled list is `src/main/bangs-top.json`)                                                            |
| Ad-blocking filter lists                                                | `AdBlock.start()` in `src/main/adblock.ts`. Swap the prebuilt lists for your own with Ghostery's `ElectronBlocker.fromLists()` |
| Privacy protections (HTTPS upgrades, link cleaning, cross-site cookies) | `src/main/shields.ts` and `src/main/adblock.ts`                                                                                |
| Fingerprinting protection                                               | `fingerprintShim` in `src/preload/page.ts`                                                                                     |
| User agent and site compatibility                                       | `src/main/compat.ts`                                                                                                           |
| Tidy Tabs (Apple Intelligence)                                          | `src/main/tidy.ts` and the Swift helper in `native/tidy/`                                                                      |

## Add a feature

Zepper's main process owns all state; the UI sends **commands** and receives **snapshots**. Adding something usually touches the same four places:

1. **A command:** add it to the `Command` union in `src/shared/types.ts`.
2. **Handle it:** add a `case` to `Browser.handle()` in `src/main/browser.ts`.
3. **Send it from the UI:** `zepper.send({ type: 'your.command', … })` from any component.
4. **Show its state:** if the UI needs new state, add it to `Snapshot` (`src/shared/types.ts`) and fill it in `Browser.snapshot()`.

A new setting is similar: add it to `Settings` and `DEFAULT_SETTINGS` in `src/shared/settings.ts`, add a row in `src/renderer/src/overlay/SettingsPanel.tsx`, and read it from `this.settings` in the main process or `snapshot.settings` in the UI.

[ARCHITECTURE.md](ARCHITECTURE.md) explains the layers (sidebar, tabs, overlay) and how state flows between them.

## Build your app

```bash
npm run dist
```

That produces a `.dmg` and a `.zip` in `dist/`. A few things to know:

- **Code signing:** to share your build without Gatekeeper warnings, sign and notarise it with your Apple Developer ID (electron-builder picks up your signing identity; see its [code signing docs](https://www.electron.build/code-signing)).
- **Protected video (Netflix, Spotify…):** needs your own free castLabs EVS account for VMP signing. See [Protected video](../README.md#protected-video-widevine) in the README.
- **Tidy Tabs** needs Xcode 26 to build its helper (`npm run build:native`, which `npm run dist` runs for you).
- **Electron fuses** are flipped in `scripts/after-pack.cjs`; leave them on unless you know why you need one off.

## Licence

Zepper is licensed under the [GPL-3.0](../LICENSE). You're free to use, change and share your fork. If you distribute it, it has to stay under the GPL-3.0 with its source available, and keep the copyright notices.
