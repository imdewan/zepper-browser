// Development only: makes the Electron runtime in node_modules look like Zepper on macOS
// (menu bar, Dock, ⌘Tab), which takes the app's name from the bundle, not from app.setName.
// Packaged builds already get this from electron-builder.
//
// Re-seals the bundle with an ad-hoc signature (as it came), then refreshes the Widevine VMP
// signature, which has to come after code signing on macOS. Run with Zepper closed:
//   npm run brand:dev
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/electron/dist')
const app = join(dist, 'Electron.app')
const plist = join(app, 'Contents/Info.plist')

if (process.platform !== 'darwin' || !existsSync(app)) {
  console.log('brand:dev: nothing to do (macOS development runtime not found)')
  process.exit(0)
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
for (const key of ['CFBundleName', 'CFBundleDisplayName']) run('plutil', ['-replace', key, '-string', 'Zepper', plist])
copyFileSync(join(root, 'build/icon.icns'), join(app, 'Contents/Resources/electron.icns'))
run('codesign', ['--force', '--deep', '--sign', '-', app])

const python = join(root, '.evs/bin/python')
if (existsSync(python)) {
  run(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', dist])
} else {
  console.warn('brand:dev: no .evs client, so protected video (Widevine VMP) will not play until you run "npm run vmp:sign"')
}
console.log('brand:dev: the development runtime is now "Zepper"')
