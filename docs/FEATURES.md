# Features

What Zepper does today, by area. See [ARCHITECTURE.md](ARCHITECTURE.md) for how it's built.

## Window and sidebar

- Vertical sidebar on the left or right, resizable (190–500px), with a window gradient that shows through, plus transparency and corner radius controls
- Top row: traffic lights, extensions, back, forward, reload. Buttons shrink to fit narrow sidebars instead of disappearing
- Address pill with the site's lock (certificate, permissions, cookies, per-site ad blocking) and a copy button on hover
- Bottom bar: settings, space switcher (with a "+" for new spaces), downloads with a progress ring
- Compact mode (⌘S): the sidebar hides and floats back in when you reach the window edge
- The main window remembers its size and position
- New windows (⌘N) open on the space you're in, with no tabs, at your window's size
- Default browser: links and files opened from other apps open in Zepper (Settings → General)
- Print (⌘P), Save Page As (⇧⌘S), Export as PDF, Open File (⌘O), View Source (⌥⌘U), and Chromium's PDF viewer
- Zoom in Chrome's steps, remembered per site, with a notice to reset; pinch to zoom
- A crashed page keeps its tab and offers Reload; a page that stops responding can be waited for or closed
- Closing a tab with unsaved changes asks first ("Leave site?")
- Quitting asks first when other windows (which aren't restored) are open

## Spaces

- Each space has its own pinned tabs, normal tabs, emoji, gradient theme and, optionally, its own sign-ins:
  - **Start fresh**
  - **Copy from** another space (cookies)
  - **Share with** another space
- Switch with a trackpad swipe on the sidebar, ⌃1–9, the space dots, or the picker behind the chevron next to the space name
- Right-click a space to rename it, change its icon or theme, set its sign-ins, clear its data, add a folder, unload or delete it

## Tabs

- **Essentials:** a grid of most-used sites per space, using that space's sign-ins; they can be dragged to another space.
- **Pinned tabs** per space, saved across restarts; ⌘W resets and unloads them.
- **Restored on restart:** open tabs and Essentials come back (both can be turned off in Settings → Tabs).
- **Folders** in the pinned area, nestable: collapse, rename, ungroup or delete with their tabs.
- **Drag and drop:**
  - reorder tabs and folders, and drop into folders;
  - pin or unpin by dragging between the two lists;
  - add to (or reorder) Essentials;
  - move to another space by dropping on its dot.
- **Split view:** up to four tabs side by side, stacked or in a grid, with resizable dividers.
- **Tidy:** one click groups a space's tabs into named folders, with Undo. It uses Apple Intelligence on the Mac (macOS 26 and later), so nothing leaves your computer; elsewhere it groups tabs from the same site.
- **Tabs you haven't opened lately:** a card above them offers to close them (one ⇧⌘T brings them back) or set them aside in a folder; after 3 days by default (Settings → Tabs).
- Reopen closed tabs, unload tabs, clear unpinned tabs.

## Command bar and search

- ⌘T / ⌘L: search, enter an address, or switch to an open tab. An empty bar lists recent tabs and sites
- Search engine choice and suggestions
- DuckDuckGo bangs resolved locally (`!yt cats`, `cats !w`, `!gh`), with completions as you type

## Privacy and security

- **Ad blocking:** built in, using uBlock Origin's filter lists (refreshed daily). Covers network requests, cosmetic filtering and scriptlets, including YouTube ads.
- **Protections, on by default.** Each can be turned off in Settings → Privacy, and all of them for one site from the lock icon:
  - **Cookie banners hidden**, with uBlock Origin's annoyance lists.
  - **Fingerprinting protection:** tiny per-site, per-session noise on canvas, WebGL and audio readouts, a limited CPU core count, and WebRTC kept to the public network interface.
  - **Cross-site cookies blocked:** third-party requests can't set or send cookies (sign-in frames from Google, Microsoft and Apple still work).
  - **HTTPS upgrades** for plain-HTTP pages, falling back for sites without HTTPS.
  - **Clean links:** click identifiers (fbclid, gclid, msclkid…) are removed and Google AMP pages open on the real site.
- **HTTPS first:** typed addresses go to HTTPS, falling back to HTTP only when a site has no HTTPS; plain-HTTP pages show an open padlock ("Not secure").
- **Secure DNS:** DNS over HTTPS, automatic or through Cloudflare, Quad9 or Google.
- **Certificate errors** get their own page, and sites asking for a client certificate let you choose (or send none).
- **Clear browsing data:** history (by time range), cookies and site data, cached files and the downloads list, across every space.
- **Downloads:** opening a program or installer asks first.
- **Pop-ups** have no address bar, so their title shows the site you're on.
- **Pop-up blocking:** pages can open tabs and windows only right after a click or key press; blocked ones can be opened from a notice.
- **Private windows** with an in-memory session.
- **Global Privacy Control** and Do Not Track.
- **Browser identity:** Chrome, Edge, Firefox, Safari or custom, with matching client hints.
- **Site panel:** certificate viewer, permissions, and cookies and site data per domain.
- **Page dialogs** name the site asking, block spam, and include HTTP sign-in.

## Passwords and passkeys

- **Apple Passwords, built in.** Your saved logins appear under sign-in fields; pick one (or use ↓ and Return) to fill it. When you sign in with a new password, macOS asks whether to save it in Apple Passwords, which syncs through iCloud Keychain. Zepper keeps no passwords of its own. Connecting takes a six-digit code that macOS shows, once each time Zepper opens.
- **Passkeys and security keys** go through macOS: passkeys saved in Apple Passwords, a phone nearby (QR code), and USB or NFC security keys, with the system's own sheets.
- Both need a build signed with Apple's browser entitlement (see [Architecture](ARCHITECTURE.md#passwords-and-passkeys)). Other builds fill from Apple Passwords through macOS's own picker: choose **Apple Passwords…** under a sign-in field, then **Passwords…**.
- Settings → Passwords turns it off, opens the Passwords app, and lists sites where you chose never to save.

## Apple Intelligence (on the Mac)

Everything here runs on your Mac with Apple's on-device models (macOS 26 and later); nothing is sent anywhere.

- **Summarise or ask the page** (✦ in the address pill, ⇧⌘A, or the page menu): a summary streams in as soon as the panel opens; follow-up questions are answered from the parts of the page most related to them.
- **Translate pages:** when a page isn't in your language, a translate button appears in the address pill. Paragraphs on screen are translated first, links and formatting are kept, text added later is translated too, and the original comes back with one click. The faster model is used when its languages are downloaded (System Settings → General → Language & Region → Translation Languages).
- **Search history by meaning:** on the History page, a query of a few words shows Best matches by meaning, re-ranked by Apple Intelligence. The index lives with your history and goes when history is cleared.
- **Tidy Tabs** (see Tabs).

## Captures

- ⇧⌘2 freezes and dims the page. Hover to highlight an element and click to capture it, or drag a region; Visible (V) and Full page (F) take the screen or the whole page; Esc cancels.
- Captures are copied to the clipboard and marked with their pixel density (Retina captures open at their real size). A card offers Save (full pages save straight to Downloads), Show in Finder and Retake, and the thumbnail drags into other apps.

## Media

- **Now-playing card** for audio in other tabs: play/pause, mute, hide. It offers to pause other tabs when something new starts.
- **Picture-in-picture:**
  - automatic when you leave a playing video;
  - a rounded, resizable floating player;
  - ±10s, play/pause and mute controls, plus keyboard shortcuts.
- **Protected video:** opt-in Google Widevine, through castLabs' Electron, with VMP signing.

## Extensions, downloads and history

- **Extensions:**
  - Chrome Web Store installs and an extensions panel with pinning.
  - Settings → Extensions to turn extensions on or off, open their options, or remove them.
  - An optional extensions row.
- **Downloads window:** progress, pause/resume, open, Show in Finder. You choose the save location, or have Zepper ask each time.
- **History page** (⌘Y): search, delete entries, and clear the last hour, today or everything. History can also be cleared on quit.

## Gestures

- Two-finger swipe on a page to go back or forward
- Two-finger swipe on the sidebar to switch spaces
