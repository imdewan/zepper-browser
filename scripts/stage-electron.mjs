// Packaging only: electron-builder expects the runtime as Electron.app, but `npm run brand:dev`
// renames the development copy to Zepper.app. This stages the runtime under its original name
// (an APFS clone, so it's instant and takes no extra space) for build.electronDist.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/electron/dist')
const staged = join(root, 'node_modules/.cache/zepper-electron-dist')
const app = ['Electron.app', 'Zepper.app'].map((name) => join(dist, name)).find((path) => existsSync(path))
if (!app) throw new Error('No Electron runtime in node_modules/electron/dist (run npm install)')

rmSync(staged, { recursive: true, force: true })
mkdirSync(staged, { recursive: true })
execFileSync('cp', ['-cR', app, join(staged, 'Electron.app')])
for (const file of ['LICENSE', 'LICENSES.chromium.html', 'version']) {
  if (existsSync(join(dist, file))) execFileSync('cp', ['-c', join(dist, file), staged])
}
console.log('stage-electron: runtime staged for packaging')
