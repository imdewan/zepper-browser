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

| File                                     | Responsibility                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                               | Startup: user agent, Widevine wait, opening the first window, quitting                                                                                                                 |
| `hub.ts`                                 | Services shared by all windows (history, settings, ad blocking, extensions, downloads, Widevine), IPC routing to the window that owns the sender, and setting up each browsing session |
| `browser.ts`                             | One window: spaces, tabs (Essentials, pinned, normal), the pinned-area folder tree, split view, layout, menus, permissions, page dialogs, gestures, persistence                        |
| `compat.ts`                              | Browser identity (user agent and client hints) and site-compatibility switches handed to pages                                                                                         |
| `adblock.ts`                             | The Ghostery engine with uBlock Origin's lists: network blocking per session, cosmetic filters, per-site allowlist                                                                     |
| `extensions.ts`                          | Chrome extension APIs (`electron-chrome-extensions`) and the Chrome Web Store, plus enable/disable/remove                                                                              |
| `downloads.ts`, `history.ts`, `bangs.ts` | The download list, browsing history, and local DuckDuckGo bang resolution                                                                                                              |
| `site.ts`                                | Per-site permissions and captured certificate chains                                                                                                                                   |
| `updater.ts`                             | Zepper's own updates: checks GitHub Releases, downloads and unpacks the new version, and installs it when Zepper quits                                                                 |
| `ai.ts`, `tidy.ts`, `semantic.ts`        | The on-device intelligence helper (started on demand, stopped when idle), Tidy Tabs, and history search by meaning                                                                     |
| `shields.ts`, `zoom.ts`, `capture.ts`    | Privacy protections (link cleaning, HTTPS upgrades, fingerprinting seeds), per-site zoom, and screen captures                                                                          |
| `vault.ts`, `importers.ts`               | The password manager's encrypted store (passwords and passkeys), and importing from other browsers and CSV exports                                                                     |
| `autofill.ts`, `password-settings.ts`    | The password popup (dropdown, save offers, passkey sheets) and Settings › Passwords                                                                                                    |
| `authenticator.ts`, `passkeys.ts`        | Zepper's passkey authenticator, and checking pages' WebAuthn requests (with macOS's passkeys as an option)                                                                             |
| `native.ts`, `hybrid.ts`, `cbor.ts`      | The credentials addon (`native/credentials`: Touch ID, Keychain reads, Bluetooth, macOS's passkeys), passkeys from phones, and CBOR                                                    |
| `persist.ts`, `settings-store.ts`        | Atomic, debounced JSON files under the user data folder                                                                                                                                |
| `devtools-server.ts`                     | Development-only debug endpoint (see below)                                                                                                                                            |

### Windows

- **The main window** is persisted (`zepper-state.json`): spaces, tabs, folders, splits, sidebar width and window bounds.
- **New windows** (⌘N) open on the current space (its look and sign-ins) with no tabs, at the size of the window you're in. They aren't saved. Closing the main window leaves other windows open; ⌘N then brings the main window back.
- **Private windows** get an in-memory session that is cleared when the window closes.

### Sessions and profiles

Each space has a `profile`. `'default'` is Electron's default session, which Essentials and extensions also use. Any other value is a persistent partition (`persist:space-<id>`) with its own cookies, storage and cache. `Hub.profileSession()` creates sessions on demand, and `Hub.attachSession()` wires every one up the same way: ad blocking, permissions, certificates, the page preload, headers and downloads.

Permission requests (camera, microphone, location, notifications…) show Zepper's prompt unless the site already has a decision. Electron's permission checks can only answer yes or no, so a page would see every undecided permission as "denied", and sites that look before they ask (Google Meet, Zoom, Teams) would report themselves blocked. The page preload makes undecided permissions read as "prompt" in `navigator.permissions` (and `Notification.permission` as "default"), from the list of the site's refusals it's given at load; device names stay hidden until you allow. Allowing the camera or microphone also asks macOS for access, or points you to System Settings if it was refused there.

A tab's page can't change session. When a tab moves to a space with a different profile, it is reloaded in the right one (`Browser.rehome`).

### Pinned area and folders

A space's pinned area is a tree: `space.pinnedItems` and each folder's `items` hold tab and folder ids in order. That tree is the source of truth. `this.tabs` keeps pinned tabs in the same flattened order, so code that walks tabs in sidebar order (cycling, ⌘1–9) works unchanged. Every move goes through `Browser.dropItem`, which drag and drop and the context menus both use.

## Pages: `src/preload/page.ts`

This runs in every frame of every page (iframes too: `nodeIntegrationInSubFrames`, still sandboxed and isolated) before the page's own scripts. Per-site protections follow the top-level site, so an embedded frame gets that site's fingerprinting noise:

- **Cosmetic filtering.** Hiding rules and scriptlets are fetched synchronously, so they apply at document start (that's what defeats YouTube's ads). Generic rules follow as the page renders.
- **Compatibility.**
  - Hides Chromium-only APIs when presenting as Firefox or Safari.
  - On Google's sign-in page, fills in `window.chrome` (and hides passkeys when the system's can't be used).
  - Refuses Widevine while it's turned off, and notices which sites ask for it.
- **Dialogs.** `alert`, `confirm` and `prompt` are routed to Zepper's own dialog through a synchronous IPC call that main answers when you respond.
- **Swipes.** Two-finger horizontal swipes are classified (vertical scroll, horizontal scroller, page-handled, or a swipe) and reported for back/forward.
- **Sign-in fields.** Focus on a username or password field is reported (with the field's position) so Zepper can show the passwords dropdown; the chosen login is filled through the native value setter, so frameworks notice. A sent password is reported only so Zepper can offer to save it.
- **Passkeys.** `navigator.credentials.create()` and `get()` for public-key credentials go to Zepper (`src/preload/webauthn.ts`), which answers with real `PublicKeyCredential` objects. Conditional requests (passkey autofill) wait for you to pick a passkey under the username field.

Code run in the page's main world goes through `contextBridge.executeInMainWorld` and must be self-contained.

## On-device intelligence

`native/zepper-ai/main.swift` is a small Swift program built with `npm run build:native` and bundled as `Resources/bin/zepper-ai`. `ai.ts` starts it when needed and talks to it over stdin and stdout, one JSON request per line; it exits after a few idle minutes. It uses:

- **Foundation Models** (Apple Intelligence) for Tidy Tabs (guided generation with `@Generable`), page summaries and answers (streamed), and re-ranking history matches.
- **NaturalLanguage** contextual embeddings for history search by meaning, and language detection.
- **Translation** for translating pages, a paragraph at a time as attributed text, so each translated piece maps back to the text node (and link) it came from.

Everything runs on the Mac. Where Apple Intelligence isn't available, Tidy Tabs groups by site and the other features stay hidden.

## Passwords and passkeys

- **The vault** (`vault.ts`) is one file in the profile, `passwords.vault`, encrypted with Electron's `safeStorage` (the key Chromium keeps in the macOS Keychain). Logins are matched to pages by origin, then by site (`tldts`): accounts.example.com is offered what was saved on example.com, and an `http` login is offered on the `https` page of the same host, never the other way round. If the file can't be decrypted (the Keychain key changed), it's set aside rather than overwritten.
- **The popup** (`autofill.ts`, `src/renderer/src/autofill`) is a small borderless child window, so it has a real shadow and never takes focus from the page; the page passes arrow keys and Return on while the list is open. A login is filled only when you choose it, only into the frame it was listed for, and only on HTTPS (or local development) pages. A password typed into a form is held until the page navigates (a failed sign-in usually doesn't), then offered for saving; one Zepper suggested is saved without asking.
- **Passkeys** (`authenticator.ts`): P-256 keys made and kept in the vault, with a "none" attestation, Zepper's own AAGUID, and the signature counter left at 0, as other passkey providers do. User verification is Touch ID or the Mac's password through LocalAuthentication (`native/credentials/system.mm`), asked when the site prefers or requires it. Main checks every request itself (`passkeys.ts`): the origin comes from the frame, the relying party must be that site or a parent domain (never a public suffix), and only a visible tab's top frame gets a sheet.
- **Phones** (`hybrid.ts`, FIDO's hybrid transport, "caBLE v2", as in Chromium's `device/fido/cable`): the QR code carries a fresh P-256 identity key and a secret; the phone advertises a short message over Bluetooth, encrypted with a key derived from that secret (`native/credentials/ble.mm` scans for it); both connect to the phone maker's relay (`cable.auth.com` for Apple, `cable.ua5v.com` for Google, or a hashed name), run a Noise KNpsk0 handshake keyed by the QR secret and the advert, and the request goes over it as CTAP2 (makeCredential or getAssertion). The client data is built in main, as for Zepper's own passkeys.
- **macOS's passkeys** (iCloud Keychain, a phone nearby, security keys) are offered as "Use another device…" when Zepper is signed with `com.apple.developer.web-browser.public-key-credential`, which Apple grants on request (`npm run dist:browser`, see Packaging). They run through AuthenticationServices in the main process (`native/credentials/passkeys.mm`), the process holding the entitlement.
- **Importing** (`importers.ts`): Chromium browsers keep logins in a SQLite file (`Login Data`) with passwords encrypted by AES-128-CBC under a key derived from a Keychain item (for Chrome, "Chrome Safe Storage"). Zepper reads that item through Security.framework, so macOS asks you to allow it, and reads a copy of the database with `node:sqlite`. Some browsers' folders are protected by macOS until you give Zepper Full Disk Access. CSV exports are matched by column names, so most password managers' files work.
- **Showing or exporting passwords** in Settings asks for Touch ID (or the Mac's password) first, then not again for two minutes (`password-settings.ts`).

## Protected video

Zepper uses castLabs' Electron build. Widevine is opt-in: while it's off, `components.updatesEnabled` stays false so nothing is downloaded. castLabs' updater can only install on a launch where updates were on from the start, so turning Widevine on restarts Zepper once. Streaming services also need a production VMP signature (see the README).

## Development

- `npm run dev` runs Zepper with hot reload for the UI. Main-process changes need a restart.
- In development, a debug server listens on `127.0.0.1:9876`. It answers local tools only (requests from web pages are refused):
  - `/snapshot` and `/state`: what the window holds.
  - `/command`: send a command.
  - `/capture`: screenshots of each layer.
  - `/eval`: run code in the active page.
  - `/move`, `/drag`, `/wheel`: input.
- A second, isolated instance can run alongside your own: `ZEPPER_PROFILE=<folder> ZEPPER_DEBUG_PORT=9877 node_modules/.bin/electron .` (after `npm run build`). Stop it by the process listening on its port: `kill $(lsof -ti tcp:9877 -sTCP:LISTEN)`.
- `npm run check` runs type checking, ESLint and Prettier; CI runs the same on every push.

## Screen sharing

`getDisplayMedia` requests go to `Browser.chooseShareSource()`, which gathers your other tabs and, through `desktopCapturer`, windows and screens with previews, then shows the picker (`SharePicker.tsx`) in the overlay. A tab is shared as its `WebFrameMain`, with its sound if asked (`enableLocalEcho` keeps it playing for you). A window or screen can carry the Mac's sound: Chromium's Core Audio tap (`MacCatapLoopbackAudioForScreenShare`, macOS 14.2+, which needs `NSAudioCaptureUsageDescription` in Info.plist), asked for as `loopbackWithoutChrome` so Zepper's own sound (a call's other voices) isn't sent back.

## Updates

`updater.ts` reads electron-builder's `latest-mac.yml` from the latest GitHub release a few seconds after launch and every four hours. A newer version's zip is downloaded, checked against the feed's sha512, unpacked with `ditto` (which keeps the signature intact) into `Updates/` in the profile, and checked again (bundle id, version, `codesign --verify`). The sidebar then shows Update. Installing happens on quit: a small shell script waits for Zepper to exit, swaps the app bundle (restoring the old one if that fails), and reopens it when you clicked Update. This avoids Squirrel.Mac, which only trusts updates signed with a Developer ID. `ZEPPER_UPDATE_FEED` points a build at another feed (a local folder served over HTTP, for trying an update), and `ZEPPER_PROFILE` gives a packaged copy a profile of its own.

## Packaging

`npm run dist` builds the app with electron-builder. Its `afterPack` hook (`scripts/after-pack.cjs`) flips Electron's fuses (no running as Node, no Node debugging flags, app code only from the integrity-checked asar, cookies encrypted on disk) and then VMP-signs, in that order, because the signature covers the framework binary the fuses change. Last, it re-seals the app with an ad-hoc signature, since VMP signing adds a file inside the framework; Apple code signing, when there's a Developer ID, replaces it. electron-builder packages a copy of the Electron runtime staged by `scripts/stage-electron.mjs`, because `npm run brand:dev` renames the development copy. Hardened-runtime entitlements (`build/entitlements.mac.plist`) allow JIT, the Widevine library, and the camera, microphone and location for sites you allow. The app registers for `http`/`https` links and web page files, so it can be the default browser.

Each release should include `latest-mac.yml` and the `.zip` alongside the `.dmg`: they're the update feed.

`npm run dist:browser` (with `ZEPPER_PROVISIONING_PROFILE` pointing at the Developer ID profile Apple issues with the browser entitlement) adds the app identity and `com.apple.developer.web-browser.public-key-credential` to the main app's entitlements only. Electron's helper apps have no profile, and macOS stops any process claiming a restricted entitlement without one.

## License

Zepper is licensed under the GPL-3.0 (only). That matches `electron-chrome-extensions`, which `src/main/extensions.ts` uses under its GPL-3.0 option. Other dependencies are under permissive or GPL-compatible licenses (MIT, BSD, MPL-2.0).
