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

## Spaces

- Each space has its own pinned tabs, normal tabs, emoji, gradient theme and, optionally, its own sign-ins:
  - **Start fresh**
  - **Copy from** another space (cookies)
  - **Share with** another space
- Switch with a trackpad swipe on the sidebar, ⌃1–9, the space dots, or the picker behind the chevron next to the space name
- Right-click a space to rename it, change its icon or theme, set its sign-ins, clear its data, add a folder, unload or delete it

## Tabs

- **Essentials:** a grid shared by every space.
- **Pinned tabs** per space, saved across restarts; ⌘W resets and unloads them.
- **Folders** in the pinned area, nestable: collapse, rename, ungroup or delete with their tabs.
- **Drag and drop:**
  - reorder tabs and folders, and drop into folders;
  - pin or unpin by dragging between the two lists;
  - add to (or reorder) Essentials;
  - move to another space by dropping on its dot.
- **Split view:** up to four tabs side by side, stacked or in a grid, with resizable dividers.
- **Tidy:** one click groups a space's tabs into named folders, with Undo. It uses Apple Intelligence on the Mac (macOS 26 and later), so nothing leaves your computer; elsewhere it groups tabs from the same site.
- Reopen closed tabs, unload tabs, clear unpinned tabs.

## Command bar and search

- ⌘T / ⌘L: search, enter an address, or switch to an open tab. An empty bar lists recent tabs and sites
- Search engine choice and suggestions
- DuckDuckGo bangs resolved locally (`!yt cats`, `cats !w`, `!gh`), with completions as you type

## Privacy and security

- **Ad blocking:** built in, using uBlock Origin's filter lists (refreshed daily). Covers network requests, cosmetic filtering and scriptlets, including YouTube ads. It can be turned off per site.
- **Pop-up blocking:** pages can open tabs and windows only right after a click or key press; blocked ones can be opened from a notice.
- **Private windows** with an in-memory session.
- **Global Privacy Control** and Do Not Track.
- **Browser identity:** Chrome, Edge, Firefox, Safari or custom, with matching client hints.
- **Site panel:** certificate viewer, permissions, and cookies and site data per domain.
- **Page dialogs** name the site asking, block spam, and include HTTP sign-in.

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
