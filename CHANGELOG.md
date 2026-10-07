# Changelog

Notable changes to Zepper. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Drag a tab out of the sidebar (onto the page, or out of the window) for a window of its own, or onto another window's sidebar to move it there, as in Chrome: its page keeps running (no reload, still signed in). Pinned tabs and Essentials stay in their window, and private windows keep their tabs.
- Drop files or links on the sidebar to open them: between tabs for a new tab there, or on a tab to open them in it.
- Finished downloads drag out of the downloads panel as the files themselves: onto a page to upload them, onto the tabs to open them, or into Finder.
- Tabs keep their back and forward pages when you quit and reopen Zepper, as in Chrome, with each page's scroll position, and when Memory Saver unloads them (they used to come back with just their current page).

### Changed

- The downloads panel is cleaner: each file with its Finder icon, downloads under way at the top, the rest by day (Today, Yesterday, Earlier) with size, site and when, and a Show in Finder button for the folder.
- Settings › Privacy shows whether macOS lets Zepper use your location (with a way to change it), next to the camera, microphone and screen.
- Swiping back and forward works like Chrome's: the page stays still while an arrow slides in from its edge with your fingers, a ring filling as you go; once letting go will navigate, the circle fills in the space's colour. Letting go then goes straight there, without the page lurching and springing back as it did.
- In the command bar, → (at the end of what you've typed) puts the highlighted suggestion in the field without going there, so you can keep editing it: a search's words, or a page's address. Tab and Shift-Tab step through suggestions, as in Chrome and Firefox.
- Settings keeps its close button and the page's title in a bar at the top that stays put while the page scrolls.
- Lists of sites in Settings (site permissions, sites with protections off, sites passwords are never saved for) have pages of their own, opened from a row that says how many sites there are: searchable, in A–Z order, each site with a button to undo what's set. Esc goes back out of one.
- Chrome's dotted inactive ring only marks tabs that were unloaded to free memory (by Memory Saver, or Unload): tabs that simply haven't been opened since Zepper started look as usual.
- A tab playing sound shows its bars in the text colour, so they read on any theme (they were the space's accent colour, and hard to see on some), a little larger. Pointing at the tab (or an Essential) shows a speaker instead, so it's clear a click mutes it.

### Fixed

- Save Image As…, Save Link As… and Save Video As… saved straight to Downloads instead of asking where, as they do in Chrome. They ask now, with the file's name filled in; other downloads still follow Settings › Downloads.
- Turning on the extensions row (Settings › Extensions) showed nothing until you'd pinned an extension. It shows all your extensions until you pin some, then just the pinned ones.
- Sites couldn't get your location (Google Maps: "Your precise location could not be determined"): macOS was never asked to let Zepper use it, so requests waited and timed out. The first time a site you allow wants your location, macOS now asks, and if macOS is blocking Zepper you're told where to turn it on.
- Some sites (Discord, for one) could sign you out after you quit Zepper, updated it, closed its window or had a tab unloaded by Memory Saver: pages were closed without running their closing code, which is where some sites save what they need for next time. Pages now close themselves first, as in Chrome. Memory Saver also leaves a page loaded if it asks before you leave (unsaved changes).

## [0.1.3] - 2026-10-07

### Changed

- Releases are signed with the same certificate every time, so macOS knows each update as the same app and camera and microphone permissions carry over. (Zepper's Keychain item is still asked for once after each update: macOS remembers that by Apple developer team, which this certificate doesn't have.)
- Memory Saver works the way Chrome's and Brave's does, so tabs stay loaded far longer. Its modes are Moderate, Balanced (the default) and Maximum: a tab unloads after 6, 4 or 2 hours out of sight (it was 15 minutes to 4 hours), or sooner when your Mac runs short of memory. Time your Mac is asleep or locked no longer counts, so coming back finds your tabs as you left them, and tabs you keep coming back to, pinned tabs, tabs that update out of sight (an unread count), sites allowed to send notifications and tabs with something typed and not sent stay loaded.

### Fixed

- A call's floating window (Google Meet's, opened when you switch away from a call) stayed black: the call's tab was in the background, where pages get no animation frames, so the site never drew into it. The tab keeps drawing while its floating window is open, as in Chrome. The window's title also names the site instead of "Pop-up — about:blank".

## [0.1.2] - 2026-10-07

### Fixed

- With fingerprinting protection on, X answered "We've temporarily limited your login". The protection lowered the CPU core count pages see, but background workers still reported the real one, and X's sign-in check refuses that mismatch. The core count is no longer changed; the rest of the protection stays on, on X too.

## [0.1.1] - 2026-10-06

### Added

- Bring over your open tabs from Chrome and other Chromium browsers, Firefox and Arc (its spaces, pinned tabs, folders and favourites), in setup or from Settings → General → Import from another browser. Import All brings everything over in one go.
- Memory Saver, on by default: tabs you haven't looked at for a while (15 minutes, an hour or 4 hours) give back their memory and reload when you open them; tabs playing sound, in a call or in picture-in-picture stay. Inactive tabs show Chrome's dotted ring around their icon.
- Tabs that haven't been opened (in the background, imported) show their title and icon, fetched without loading the page, so nothing starts playing.
- New windows open with all your spaces and their Essentials, starting on the one you're in.
- The command bar suggests and completes popular sites you haven't visited yet (`yout` → youtube.com, `gmail`, `twitter`).
- Starting a download shows which file is downloading and from which site, with a button to open Downloads.
- Downloads can be moved to the Trash from the downloads panel, whose buttons are now always shown; each download lists the site it came from.

### Changed

- The Update button always shows its word, however narrow the sidebar: while an update waits, it takes the place of the extensions, back and forward buttons (⌘[ and ⌘] still go back and forward).
- The downloads panel no longer has Clear list or Remove from list (Move to Trash and Cancel stay), and shows a clearer empty state.

### Fixed

- Sign-in checks that look for automated browsers (X's "We've temporarily limited your login") could flag Zepper: its user agent carried Chrome's full version (Chrome sends a reduced one) and \`window.chrome\` was empty. Both now match Chrome, along with the Sec-CH-UA-Full-Version-List header, \`userAgentData.toJSON()\`, and the blank and srcdoc frames fingerprinting scripts create to look past a browser's patches.
- Calls' floating windows (Google Meet's picture-in-picture, Teams, Zoom) never appeared: Electron accepted them but never showed them. Zepper now opens them as a small window above everything, opens Meet's by itself when you switch away from a call (as Chrome does), and closes it when you come back.
- Zepper's own floating player took over calls (showing your screen-share preview); calls now get the site's call window instead, and don't flicker an audio icon on the tab or show up in the now-playing card. That's any call site (Meet, Zoom, Teams, Discord, Slack…), including calls you're only listening to: a page receiving other people's audio or video counts as a call.
- Notification sounds (Discord's pings, say) put the site in the now-playing card and offered to pause your music. Only media counts now: sound that lasts, from a page that says what's playing or a real video or audio player (embedded ones too).
- A page waiting on its own alert (Google Calendar's reminders, say) set off "Page isn't responding". Pages with a dialog open or waiting aren't checked, and the notice now closes by itself when a page recovers.
- In the command bar, ⌘A then Delete brought back what you'd typed instead of clearing the field. Look-alike history rows (several "YouTube" pages) now show once.

## [0.1.0] - 2026-10-06

The first public version.

### Added

- A welcome and setup on first launch: import history and passwords from other browsers, pick a look, review privacy, and set Zepper as the default browser.
- Automatic updates: new versions download in the background, an Update button restarts into them, and quitting installs them too.
- Screen sharing like Chrome's: choose a tab, a window or a whole screen, with the tab's sound or the Mac's (macOS 14.2 and later).
- Tabs show when they're using the camera, microphone or screen.
- Essentials can be rearranged anywhere in the grid and given an emoji instead of the site's icon.
- A light and dark app icon (and macOS's clear and tinted styles) that follows your Mac's icon style, open or not.
- Pop-up blocking that only stops floods: windows you open are never blocked, and sites can open a couple on their own. Always Allow from the notice, or Allow, Auto or Block per site from the lock icon.
- Settings for updates (status, Check Now, background downloads), each site's permissions (with a reset), and what macOS lets Zepper use.
- Spaces with gradient themes and optional separate sign-ins (profiles).
- A vertical sidebar with Essentials, pinned tabs, nestable folders, drag and drop, split view and compact mode.
- Tidy Tabs: groups tabs into folders with Apple Intelligence (macOS 26 and later), or by site.
- On-device intelligence: summarise or ask about a page, translate pages, search history by meaning, and suggestions to close tabs you haven't opened lately.
- Arc-style captures of elements, regions, the visible page or the whole page.
- Per-site switches for each privacy protection; Essentials per space.
- A built-in password manager: saving and filling passwords, strong password suggestions, passkeys with Touch ID (including passkey autofill), import from Chromium browsers and CSV exports, and export.
- Passkeys from a phone: scan a QR code with an iPhone or Android phone to sign in with its passkeys.
- Chrome Web Store extensions in every space.
- A command bar with search suggestions, open-tab switching and local DuckDuckGo bangs.
- Privacy protections on by default: ad, tracker and cookie-banner blocking, fingerprinting protection, cross-site cookie blocking, HTTPS upgrades, clean links, Secure DNS and Global Privacy Control, switchable per site.
- Private windows, history, downloads, Chrome Web Store extensions and a default-browser option.
- Now-playing card, automatic picture-in-picture and opt-in Widevine for protected video.
- Print, Save Page As, Export as PDF, a PDF viewer, per-site zoom and the usual browser shortcuts.

[Unreleased]: https://github.com/imdewan/zepper-browser/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/imdewan/zepper-browser/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/imdewan/zepper-browser/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/imdewan/zepper-browser/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/imdewan/zepper-browser/releases/tag/v0.1.0
