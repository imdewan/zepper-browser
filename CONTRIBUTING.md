# Contributing to Zepper

Thanks for helping make Zepper better. Bug reports, ideas, docs fixes and code are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/imdewan/zepper-browser/issues) first. For anything bigger than a small fix, agreeing on the approach before you write code saves everyone time.
- **Security problems:** please don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Your own flavour of Zepper:** you don't need to upstream anything. Fork it and make it yours; [docs/CUSTOMIZING.md](docs/CUSTOMIZING.md) shows where everything lives.

## Setting up

You need macOS or Linux, Node.js 22 or later and npm 11.

```bash
git clone https://github.com/<you>/zepper-browser.git
cd zepper-browser
npm install
npm run dev
```

`npm run dev` starts Zepper with hot reload for the UI. Changes in `src/main/` (the main process) need a restart: stop it with Ctrl-C and run it again.

There's no Chromium to compile. Zepper runs on a prebuilt Electron, so a fresh clone is running in a couple of minutes.

## How the code is organised

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pieces. In short:

- `src/main/` owns all state (windows, spaces, tabs, settings) and talks to Chromium.
- The UI (`src/renderer/`) is React. It receives snapshots of that state and sends commands back; it never changes state itself.
- `src/preload/page.ts` runs in every web page (cosmetic filtering, privacy shims, dialogs, swipes).

## Making a change

1. Create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Match the code around you. Comments explain _why_, not _what_; names are plain words.
4. Run the checks:

   ```bash
   npm run check    # types, ESLint and Prettier
   npm run format   # fixes formatting
   ```

5. Try it in `npm run dev`. For UI changes, check light and dark mode, the sidebar on the left and on the right, and compact mode.
6. Update the docs if behaviour changed: `docs/FEATURES.md` and, for visible features, the README.

### Testing without disturbing your own browser

In development a debug server listens on `127.0.0.1:9876` (only local tools can use it). It can capture each layer, send commands and run code in the active page, which makes automated checks easy. To test against a throwaway profile, run a second, isolated instance after `npm run build`:

```bash
ZEPPER_PROFILE=/tmp/zepper-test ZEPPER_DEBUG_PORT=9877 node_modules/.bin/electron .
```

Stop it by the process listening on its port: `kill $(lsof -ti tcp:9877 -sTCP:LISTEN)`.

## Commit messages

Write the subject as what the change does, in the imperative ("Add per-site zoom", "Fix the peek on the right"), under about 70 characters. Use the body to explain why, when it isn't obvious.

## Pull requests

- Describe what changed and how you tested it (the template asks for both).
- Screenshots or a short recording help a lot for UI changes.
- CI runs the same checks as `npm run check` and a build; it needs to pass.

## License

Zepper is licensed under the [GNU General Public License v3.0 only](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
