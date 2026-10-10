// Packaging only: the Electron runtime for each kind of Mac, as the zips electron-builder looks for in
// build.electronDist (electron-v<version>-darwin-<arch>.zip). Apple silicon's is this checkout's own
// runtime (`npm run brand:dev` renames it to Zepper.app; electron-builder expects Electron.app). Intel's
// is castLabs' release of the same version, downloaded once and checked against its published SHA-256.
// `stage-electron.mjs linux`: castLabs' Linux runtimes instead (x64 and arm64), the same way.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dist = join(root, 'node_modules', 'electron', 'dist')
const cache = join(root, 'node_modules', '.cache')
const staged = join(cache, 'zepper-electron-dist')
const version = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const zipName = (arch) => `electron-v${version}-darwin-${arch}.zip`
const RELEASES = `https://github.com/castlabs/electron-releases/releases/download/v${encodeURIComponent(version)}`

rmSync(staged, { recursive: true, force: true })
mkdirSync(staged, { recursive: true })

/** castLabs' zip for a platform and arch, as published: downloaded once, checked against its SHA-256, staged. */
async function stageRelease(platform, arch) {
  const name = `electron-v${version}-${platform}-${arch}.zip`
  const zip = join(cache, name)
  if (!existsSync(zip)) {
    console.log(`stage-electron: downloading ${name}`)
    const response = await fetch(`${RELEASES}/${encodeURIComponent(name)}`)
    if (!response.ok) throw new Error(`Couldn't download ${name}: ${response.status}`)
    writeFileSync(`${zip}.part`, Buffer.from(await response.arrayBuffer()))
    execFileSync('mv', [`${zip}.part`, zip])
  }
  const sums = await (await fetch(`${RELEASES}/SHASUMS256.txt`)).text()
  const expected = sums
    .split('\n')
    .find((line) => line.trim().endsWith(`*${name}`) || line.trim().endsWith(` ${name}`))
    ?.split(/\s+/)[0]
  const actual = createHash('sha256').update(readFileSync(zip)).digest('hex')
  if (!expected || expected !== actual) {
    rmSync(zip, { force: true })
    throw new Error(`${name} doesn't match castLabs' published SHA-256 (${expected ?? 'not listed'}); removed it, run again`)
  }
  execFileSync('cp', [zip, join(staged, name)])
}

if (process.argv[2] === 'linux') {
  await stageRelease('linux', 'x64')
  await stageRelease('linux', 'arm64')
  console.log('stage-electron: runtimes staged for Linux (x64 and arm64)')
  process.exit(0)
}

// Apple silicon: the runtime in node_modules, laid out as in Electron's own zips.
const app = ['Electron.app', 'Zepper.app'].map((name) => join(dist, name)).find((path) => existsSync(path))
if (!app) throw new Error('No Electron runtime in node_modules/electron/dist (run npm install)')
const layout = join(cache, 'zepper-electron-arm64')
rmSync(layout, { recursive: true, force: true })
mkdirSync(layout, { recursive: true })
execFileSync('cp', ['-cR', app, join(layout, 'Electron.app')])
for (const file of ['LICENSE', 'LICENSES.chromium.html', 'version']) {
  if (existsSync(join(dist, file))) execFileSync('cp', ['-c', join(dist, file), layout])
}
// zip -y keeps the frameworks' symlinks, as Electron's own zips do (electron-builder can't read ditto's).
execFileSync('zip', ['-qry', join(staged, zipName('arm64')), '.'], { cwd: layout })
rmSync(layout, { recursive: true, force: true })

// Intel: castLabs' zip, as published.
await stageRelease('darwin', 'x64')
console.log('stage-electron: runtimes staged for Apple silicon and Intel')
