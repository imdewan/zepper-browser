# Changelog

Notable changes to Zepper. The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- Bring over your open tabs from Chrome and other Chromium browsers, Firefox and Arc (its spaces, pinned tabs, folders and favourites), in setup or from Settings → General → Import from another browser. Import All brings everything over in one go.
- New windows open with all your spaces and their Essentials, starting on the one you're in.
- The command bar suggests and completes popular sites you haven't visited yet (`yout` → youtube.com, `gmail`, `twitter`).

### Changed

- The downloads panel no longer has Clear list or Remove from list (Move to Trash and Cancel stay), and shows a clearer empty state.

### Fixed

- Sign-in checks that look for automated browsers (X's "We've temporarily limited your login") could flag Zepper: its user agent carried Chrome's full version (Chrome sends a reduced one) and \`window.chrome\` was empty. Both now match Chrome, along with the Sec-CH-UA-Full-Version-List header, \`userAgentData.toJSON()\`, and the blank and srcdoc frames fingerprinting scripts create to look past a browser's patches.
- In the command bar, ⌘A then Delete brought back what you'd typed instead of clearing the field. Look-alike history rows (several "YouTube" pages) now show once.

### Added

- Starting a download shows which file is downloading and from which site, with a button to open Downloads.
- Downloads can be moved to the Trash from the downloads panel, whose buttons are now always shown; each download lists the site it came from.

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

[Unreleased]: https://github.com/imdewan/zepper-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/imdewan/zepper-browser/releases/tag/v0.1.0
