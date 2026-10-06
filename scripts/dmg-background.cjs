// Renders the installer window's background (build/background.tiff, 1x and 2x) from the HTML
// below. Run after changing it: npx electron scripts/dmg-background.cjs
// Icon positions in package.json (build.dmg.contents) line up with the arrow here. Everything sits
// in the top 300 points, so Finder's tab and path bars (if someone shows them) cover nothing.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const WIDTH = 660
const HEIGHT = 400

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    position: relative;
    font-family: -apple-system, 'SF Pro Text', system-ui, sans-serif;
    background:
      radial-gradient(ellipse 380px 300px at 8% 0%, rgba(95, 134, 245, 0.30), transparent 70%),
      radial-gradient(ellipse 340px 280px at 100% 100%, rgba(192, 108, 246, 0.22), transparent 70%),
      radial-gradient(ellipse 300px 220px at 96% 4%, rgba(246, 108, 180, 0.14), transparent 70%),
      radial-gradient(ellipse 320px 240px at 0% 100%, rgba(31, 182, 201, 0.12), transparent 70%),
      linear-gradient(180deg, #fbfbfe 0%, #f2f3fa 100%);
  }
  /* A whisper of grain, like the space themes. */
  .grain { position: absolute; inset: 0; opacity: 0.35; mix-blend-mode: soft-light; }
  .arrow { position: absolute; left: 0; top: 0; }
  .caption {
    position: absolute; left: 0; right: 0; top: 254px;
    text-align: center; font-size: 13px; font-weight: 500; letter-spacing: -0.005em; color: #6a7086;
  }
</style>
</head>
<body>
  <svg class="grain" width="${WIDTH}" height="${HEIGHT}">
    <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" /></filter>
    <rect width="100%" height="100%" filter="url(#n)" />
  </svg>
  <svg class="arrow" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
    <path d="M262 160 C 300 134, 360 134, 398 160" stroke="#8d97b8" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="1 9" />
    <path d="M397.4 150.8 L 402 163 L 389 163.1" stroke="#8d97b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
  <div class="caption">Drag Zepper into Applications</div>
</body>
</html>`

// Rendered at 2x whatever the display; the 1x image is scaled down from it.
app.commandLine.appendSwitch('force-device-scale-factor', '2')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: false }
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
  await new Promise((r) => setTimeout(r, 300))
  const dir = mkdtempSync(join(tmpdir(), 'zepper-dmg-'))
  const one = join(dir, 'background.png')
  const two = join(dir, 'background@2x.png')
  const image = await win.webContents.capturePage()
  writeFileSync(two, image.toPNG())
  writeFileSync(one, image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toPNG())
  const out = join(__dirname, '..', 'build', 'background.tiff')
  execFileSync('tiffutil', ['-cathidpicheck', one, two, '-out', out])
  console.log('Wrote', out)
  app.quit()
})
