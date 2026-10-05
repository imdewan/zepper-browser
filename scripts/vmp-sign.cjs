// electron-builder afterPack hook: VMP-sign the packaged app with castLabs EVS, so
// Widevine licence servers (Netflix, Crunchyroll…) accept it. On macOS this has to
// happen before Apple code signing, which is when afterPack runs.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function vmpSign(context) {
  const python = join(__dirname, '..', '.evs', 'bin', 'python')
  if (!existsSync(python)) {
    console.warn('  • VMP signing skipped (no .evs client): protected video will not play in this build. See README "Protected video".')
    return
  }
  try {
    execFileSync(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', context.appOutDir], { stdio: 'inherit' })
  } catch {
    console.warn('  • VMP signing failed (run "npm run vmp:login"?): protected video will not play in this build.')
  }
}
