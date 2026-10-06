// Builds Zepper signed with Apple's browser entitlement (com.apple.developer.web-browser.public-key-credential).
// macOS only lets apps with it use Apple Passwords and the system's passkeys. Apple grants it on request
// (developer.apple.com/contact/request/macos-browsers-passkeys) and issues a Developer ID provisioning
// profile that carries it. With that profile:
//
//   ZEPPER_PROVISIONING_PROFILE=~/Downloads/Zepper.provisionprofile npm run dist:browser
//
// The entitlement goes on the main app only: Electron's helper apps have no profile, and macOS stops any
// process that claims a restricted entitlement without one.
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENTITLEMENT = 'com.apple.developer.web-browser.public-key-credential'
const root = join(import.meta.dirname, '..')
const profile = process.env.ZEPPER_PROVISIONING_PROFILE

if (!profile) {
  console.error('Set ZEPPER_PROVISIONING_PROFILE to the Developer ID provisioning profile Apple issued with the browser entitlement.')
  process.exit(1)
}

const plist = execFileSync('security', ['cms', '-D', '-i', profile])
const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist }).toString())
const entitlements = info.Entitlements ?? {}
const appId = entitlements['com.apple.application-identifier']
const team = info.TeamIdentifier?.[0]
const bundleId = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build.appId

if (!entitlements[ENTITLEMENT]) {
  console.error(`This profile doesn't include ${ENTITLEMENT}. Ask Apple for it, then download the profile again.`)
  process.exit(1)
}
if (!team || appId !== `${team}.${bundleId}`) {
  console.error(`This profile is for ${appId}, but Zepper's bundle ID is ${bundleId}.`)
  process.exit(1)
}

// The usual entitlements, plus the app identity and the browser entitlement from the profile.
const base = readFileSync(join(root, 'build', 'entitlements.mac.plist'), 'utf8')
const extra = `  <key>com.apple.application-identifier</key>
  <string>${appId}</string>
  <key>com.apple.developer.team-identifier</key>
  <string>${team}</string>
  <key>${ENTITLEMENT}</key>
  <true/>
</dict>`
const generated = join(root, 'build', 'entitlements.browser.plist')
writeFileSync(generated, base.replace(/<\/dict>\s*<\/plist>\s*$/, `${extra}\n</plist>\n`))

const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })
run('npx', ['electron-vite', 'build'])
run('npm', ['run', 'build:native'])
run('node', ['scripts/stage-electron.mjs'])
run('npx', ['electron-builder', '--mac', `-c.mac.entitlements=${generated}`, `-c.mac.provisioningProfile=${profile}`])
// The update feed, under the name the app looks for (see FEED_FILE in src/main/updater.ts).
copyFileSync(join(root, 'dist', 'latest-mac.yml'), join(root, 'dist', 'Zepper-update-mac.yml'))
