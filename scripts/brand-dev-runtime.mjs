// Development only: makes the Electron runtime in node_modules look like Zepper on macOS
// (menu bar, Dock, ⌘Tab), which takes the app's name from the bundle, not from app.setName.
// The Dock labels a running app by its bundle's folder name, so Electron.app becomes Zepper.app
// (and the electron package is pointed at it). Packaged builds already get this from electron-builder.
//
// Re-seals the bundle with an ad-hoc signature (as it came), then refreshes the Widevine VMP
// signature, which has to come after code signing on macOS. Run with Zepper closed:
//   npm run brand:dev
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/electron/dist')
const pathFile = join(root, 'node_modules/electron/path.txt')
const original = join(dist, 'Electron.app')
const app = join(dist, 'Zepper.app')
const plist = join(app, 'Contents/Info.plist')

if (process.platform !== 'darwin' || (!existsSync(original) && !existsSync(app))) {
  console.log('brand:dev: nothing to do (macOS development runtime not found)')
  process.exit(0)
}
if (existsSync(original)) renameSync(original, app)
const executable = 'Zepper.app/Contents/MacOS/Electron'
if (readFileSync(pathFile, 'utf8').trim() !== executable) writeFileSync(pathFile, executable)

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
for (const key of ['CFBundleName', 'CFBundleDisplayName']) run('plutil', ['-replace', key, '-string', 'Zepper', plist])
copyFileSync(join(root, 'build/icon.icns'), join(app, 'Contents/Resources/electron.icns'))
run('codesign', ['--force', '--deep', '--sign', '-', app])
// Tell Launch Services about the renamed bundle, so the Dock and ⌘Tab use the new name straight away.
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (existsSync(lsregister)) run(lsregister, ['-f', app])

const python = join(root, '.evs/bin/python')
if (existsSync(python)) {
  run(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', dist])
} else {
  console.warn('brand:dev: no .evs client, so protected video (Widevine VMP) will not play until you run "npm run vmp:sign"')
}
console.log('brand:dev: the development runtime is now "Zepper"')
