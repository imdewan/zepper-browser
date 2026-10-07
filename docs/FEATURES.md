# Features

What Zepper does today, by area. See [ARCHITECTURE.md](ARCHITECTURE.md) for how it's built.

## Welcome and setup

- On first launch, a short setup: bring over your open tabs, history and passwords from other browsers on this Mac, choose a look for your first space, review the privacy protections, turn on-device intelligence on or off, and make Zepper your default browser.
- **Open tabs** come from Chrome, Brave, Edge, Arc, Vivaldi, Opera, Helium, Chromium and Firefox. A browser's first window joins the space you're in and other windows get spaces of their own; pinned tabs stay pinned. From Arc you get its spaces (with their emoji), pinned tabs and folders, today's tabs, and its favourites as Essentials. Tabs load when you open them.
- Every step can be skipped. Settings → General → Import from another browser opens the import step again, and Welcome and setup the whole thing.

## Window and sidebar

- Vertical sidebar on the left or right, resizable (190–500px), with a window gradient that shows through, plus transparency and corner radius controls
- Top row: traffic lights, extensions, back, forward, reload. Buttons shrink to fit narrow sidebars instead of disappearing
- Address pill with the site's lock (certificate, permissions, cookies, per-site ad blocking) and a copy button on hover
- Bottom bar: settings, space switcher (with a "+" for new spaces), downloads with a progress ring
- Compact mode (⌘S): the sidebar hides and floats back in when you reach the window edge
- New windows (⌘N) open with all your spaces (their sign-ins and Essentials, not their pinned or open tabs), starting on the one you're in, at your window's size; or empty, if you prefer (Settings → General)
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

- **Essentials:** a grid of most-used sites per space, using that space's sign-ins; drag them into any order (dropping between tiles works too) or to another space, and give one an emoji instead of the site's icon (Change Icon… in its menu).
- **Pinned tabs** per space, saved across restarts; ⌘W resets and unloads them.
- **Restored on restart:** open tabs and Essentials come back (both can be turned off in Settings → Tabs).
- Drag a tab out of the sidebar for a window of its own, or onto another window's sidebar to move it there; its page keeps running
- Drop files or links on the sidebar to open them, between tabs or onto one
- Drag a finished download out of the downloads panel onto a page (to upload it), the tabs or Finder
- Every window comes back when you reopen Zepper, where it was with its spaces and tabs; windows you close yourself are forgotten
- Each tab keeps its back and forward pages (with their scroll positions) when you quit and reopen Zepper, and when Memory Saver unloads it
- **Memory Saver** (on by default, Settings → Tabs), as Chrome and Brave do it: a tab out of sight for 6, 4 or 2 hours (Moderate, Balanced or Maximum) gives back its memory and reloads when you open it, and when your Mac runs short of memory the tab you used least recently goes sooner. Time your Mac is asleep or locked doesn't count. Tabs you keep coming back to, pinned tabs, tabs that update out of sight (an unread count), and tabs playing sound, in a call, in picture-in-picture, allowed to send notifications or with something typed and not sent stay. Inactive tabs show Chrome's dotted ring around their icon.
- **Unopened tabs** (opened in the background, imported) show their real title and icon, read from the page without loading it.
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
- **Camera, microphone and screen indicators** on tabs using them, in macOS's colours (camera and microphone together show as one camera).

## Command bar and search

- ⌘T / ⌘L: search, enter an address, or switch to an open tab. An empty bar lists recent tabs and the sites you visit most
- **Top hit:** start typing a site you visit and it completes in the field (`you` → `you|tube.com`); Return goes there (or switches to its tab), → or Tab accepts it, Delete keeps just what you typed
- **Popular sites** you haven't visited yet complete and appear too, from a built-in list of about 330 (one address each: no youtu.be or country copies; no adult, gambling, piracy or scam-prone sites), matched by address or name (`gmail`, `twitter`); shown with a globe, so typing doesn't tell those sites anything
- History matches, ranked by how often and how recently you visited (pages that look the same show once)
- Search engine choice and suggestions
- DuckDuckGo bangs resolved locally (`!yt cats`, `cats !w`, `!gh`), with completions as you type

## Privacy and security

- **Ad blocking:** built in, using uBlock Origin's filter lists (refreshed daily). Covers network requests, cosmetic filtering and scriptlets, including YouTube ads.
- **Protections, on by default.** Each can be turned off in Settings → Privacy, and all of them for one site from the lock icon:
  - **Cookie banners hidden**, with uBlock Origin's annoyance lists.
  - **Fingerprinting protection:** tiny per-site, per-session noise on canvas, WebGL and audio readouts, and WebRTC kept to the public network interface.
  - **Cross-site cookies blocked:** third-party requests can't set or send cookies (sign-in frames from Google, Microsoft and Apple still work).
  - **HTTPS upgrades** for plain-HTTP pages, falling back for sites without HTTPS.
  - **Clean links:** click identifiers (fbclid, gclid, msclkid…) are removed and Google AMP pages open on the real site.
- **HTTPS first:** typed addresses go to HTTPS, falling back to HTTP only when a site has no HTTPS; plain-HTTP pages show an open padlock ("Not secure").
- **Secure DNS:** DNS over HTTPS, automatic or through Cloudflare, Quad9 or Google.
- **Certificate errors** get their own page, and sites asking for a client certificate let you choose (or send none).
- **Clear browsing data:** history (by time range), cookies and site data, cached files and the downloads list, across every space.
- **Downloads:** opening a program or installer asks first.
- **Pop-ups** have no address bar, so their title shows the site you're on.
- **Pop-up floods blocked:** windows you open by clicking are never blocked, and a site can open a couple on its own (sign-in, payment, a call's companion window); one that keeps opening them is stopped, with **Always Allow** on the notice. Per site, from the lock icon: Allow, Auto (the default) or Block (only after a click).
- **Site permissions** in Settings → Privacy: what you've allowed or blocked for each site, with a reset, and whether macOS lets Zepper use the camera, microphone and screen (with a shortcut to System Settings).
- **Pop-up blocking:** pages can open tabs and windows only right after a click or key press; blocked ones can be opened from a notice.
- **Private windows** with an in-memory session.
- **Global Privacy Control** and Do Not Track.
- **Browser identity:** Chrome, Edge, Firefox, Safari or custom, with matching client hints.
- **Site panel:** certificate viewer, permissions, and cookies and site data per domain.
- **Page dialogs** name the site asking, block spam, and include HTTP sign-in.
- **Force Paste** in a text field's right-click menu types the clipboard in, for sites that block pasting.

## Passwords and passkeys

- **A password manager, built in.** Saved logins appear under sign-in fields (↓ and Return work too), including email-first sign-in steps, forms inside web components and sign-in frames embedded in a page; other pages of the same site get them as well. After you sign in with a new or changed password, Zepper offers to save it. Everything stays on your Mac, encrypted with a key kept in your Keychain.
- **Strong passwords:** sign-up and change-password fields offer a generated one (in Apple's style, like `xetbaz-fikmo4-Rykgub`), filled into both boxes and saved once you sign up.
- **Passkeys:** sites can create and use passkeys saved in Zepper, confirmed with Touch ID or your Mac's password, and passkey autofill under username fields works too.
- **Passkeys from your phone:** choose **Use a phone…** on a passkey sheet and scan the QR code with your iPhone or Android phone; its passkeys (iCloud Keychain, Google Password Manager) sign you in. Bluetooth checks the phone is nearby. Builds signed with Apple's browser entitlement can also hand a request to macOS for iCloud Keychain, a phone nearby or a security key.
- **Import** straight from Chrome, Brave, Edge, Arc, Vivaldi, Opera, Helium or Chromium on this Mac, or from a CSV export from Apple Passwords and Safari, Firefox, 1Password, Bitwarden, LastPass, Proton Pass and others. **Export** as CSV.
- **Settings → Passwords:** search, show (after Touch ID), copy, edit and delete passwords; delete passkeys; and the sites where you chose never to save.

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

- **Now-playing card** for audio in other tabs: play/pause, mute, hide. It offers to pause other tabs when something new starts. Only media counts (a video or audio player, or a page that says what's playing), not notification sounds or call audio.
- **Picture-in-picture:**
  - automatic when you leave a playing video; leaving a call (camera or microphone on) opens the site's own floating call window instead, as Chrome does (Google Meet), and it closes when you come back;
  - a rounded, resizable floating player;
  - ±10s, play/pause and mute controls, plus keyboard shortcuts.
- **Protected video:** opt-in Google Widevine, through castLabs' Electron, with VMP signing.
- **Screen sharing** (Meet, Zoom, Teams…): a picker with your other tabs, windows and screens.
  - A tab can share its sound (and keeps playing for you).
  - A window or screen can share your Mac's sound, minus Zepper's own, so a call doesn't hear itself back (macOS 14.2 and later; macOS asks the first time).

## Updates

- Zepper checks for a new version in the background and downloads it. An **Update** button then stays at the top of the sidebar until you click it, which restarts into the new version; quitting installs it too. Until then it takes the place of the extensions, back and forward buttons (⌘[ and ⌘] still work).
- About Zepper (or Zepper › Check for Updates…) checks straight away and shows where it's at; so does Settings → General, which can also turn background downloads off.
- Installed somewhere Zepper can't replace itself (straight from the disk image, say), the button opens the download page instead.

## Extensions, downloads and history

- **Extensions:**
  - Chrome Web Store installs and an extensions panel with pinning.
  - Settings → Extensions to turn extensions on or off, open their options, or remove them.
  - An optional extensions row.
- **Downloads window:** progress, pause/resume, open, Show in Finder, Move to Trash, and the site each download came from. A toast says what's downloading as it starts. You choose the save location, or have Zepper ask each time.
- **History page** (⌘Y): search, delete entries, and clear the last hour, today or everything. History can also be cleared on quit.
- **History import** from Chrome, Brave, Edge, Arc, Vivaldi, Opera, Helium, Chromium, Firefox and Safari (in the welcome and setup). Pages you'd already visited keep the higher visit count, so importing twice changes nothing.

## Gestures

- Two-finger swipe on a page to go back or forward, as in Chrome: an arrow slides in from the page's edge with your fingers, a ring filling as you go, and fills in the space's colour once letting go will navigate
- Two-finger swipe on the sidebar to switch spaces
