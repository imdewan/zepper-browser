// Builds Zepper's two native helpers for each kind of Mac it ships for (Apple silicon and Intel), into
// build/bin/<arch>/ for packaging, and copies this Mac's own to build/bin/ for development:
// - zepper-ai, the on-device intelligence helper (Apple Intelligence needs Apple silicon; on an Intel
//   Mac the helper says it isn't available, and the rest of it still works);
// - zepper_credentials.node, passkeys, Touch ID, Bluetooth and location (a Node-API addon, so it runs
//   in any Electron).
// ZEPPER_ARCHS=arm64 builds just one.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// They're macOS's (Swift and Objective-C++); on Linux Zepper runs without them.
if (process.platform !== 'darwin') {
  console.log('build-native: nothing to build here (the native helpers are macOS-only)')
  process.exit(0)
}

const root = join(import.meta.dirname, '..')
const bin = join(root, 'build', 'bin')
const archs = (process.env.ZEPPER_ARCHS || 'arm64,x64').split(',')
const SWIFT_ARCH = { arm64: 'arm64', x64: 'x86_64' }
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })

/** Copies over a fresh file, so a running Zepper's mapped copy (and macOS's signature cache for it) isn't touched. */
function replace(from, to) {
  rmSync(to, { force: true })
  copyFileSync(from, to)
}

for (const arch of archs) {
  if (!SWIFT_ARCH[arch]) throw new Error(`build-native: unknown arch "${arch}" (arm64 or x64)`)
  const out = join(bin, arch)
  mkdirSync(out, { recursive: true })
  const target = `${SWIFT_ARCH[arch]}-apple-macos26.0`
  run('swiftc', [
    '-O',
    '-parse-as-library',
    '-swift-version',
    '5',
    '-target',
    target,
    'native/zepper-ai/main.swift',
    '-o',
    join(out, 'zepper-ai')
  ])
  run('node-gyp', ['rebuild', '-C', 'native/credentials', `--arch=${arch}`])
  replace(join(root, 'native', 'credentials', 'build', 'Release', 'zepper_credentials.node'), join(out, 'zepper_credentials.node'))
}

for (const file of ['zepper-ai', 'zepper_credentials.node']) {
  const own = join(bin, process.arch, file)
  if (existsSync(own)) replace(own, join(bin, file))
}
console.log(`build-native: built for ${archs.join(' and ')}`)
