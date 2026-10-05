// electron-builder afterPack hook, in this order (both change the app, so both must come
// before Apple code signing, which runs after this hook):
// 1. Flip Electron's fuses: no running as plain Node, no Node debugging flags, app code
//    only from the (integrity-checked) asar, and cookies encrypted on disk.
// 2. VMP-sign with castLabs EVS so Widevine licence servers (Netflix, Crunchyroll…) accept
//    the app. Flipping fuses rewrites the framework binary, so it has to happen first.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  // Unsigned builds still need a valid ad-hoc signature to launch on Apple silicon.
  resetAdHocDarwinSignature: true
}

exports.default = async function afterPack(context) {
  const fuses = await context.packager.generateFuseConfig(FUSES)
  await context.packager.addElectronFuses(context, fuses)

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
