# Security policy

A browser handles your accounts, passwords and browsing, so security reports are taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[Security › Report a vulnerability](https://github.com/imdewan/zepper-browser/security/advisories/new).

Include what you can of:

- what the problem is and what an attacker could do with it,
- steps or a page that reproduces it,
- the Zepper and macOS versions.

You'll get a reply within a few days. Once there's a fix, it's released and the advisory is published, with credit to you if you'd like it.

## What's in scope

- Zepper's own code: the main process, the browser UI, the page preload, IPC between them, and the build configuration.
- Ways a web page can reach Zepper's UI or main process, read other sites' data, get around permissions or site isolation, or bypass the privacy protections.

## What isn't

- Bugs in Chromium itself. Zepper uses Electron's Chromium; report those to the [Chromium project](https://www.chromium.org/Home/chromium-security/reporting-security-bugs/) or [Electron](https://github.com/electron/electron/security/policy). Zepper picks up their fixes by updating Electron.
- The development-only debug server (`npm run dev`), which isn't part of packaged builds.

## Supported versions

Only the latest release gets security fixes.
