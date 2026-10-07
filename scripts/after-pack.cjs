// electron-builder afterPack hook, in this order (both change the app, so both must come
// before Apple code signing, which runs after this hook):
// 1. Flip Electron's fuses: no running as plain Node, no Node debugging flags, app code
//    only from the (integrity-checked) asar, and cookies encrypted on disk.
// 2. VMP-sign with castLabs EVS so Widevine licence servers (Netflix, Crunchyroll…) accept
//    the app. Flipping fuses rewrites the framework binary, so it has to happen first.
// 3. Re-seal: VMP signing adds a .sig file inside the framework, which breaks the seal the fuses
//    step made, and a downloaded app with a broken seal is reported as "damaged". It's signed with
//    the "Zepper Signing" certificate when this Mac has it (see "Signing releases" in the README), so macOS
//    knows each update as the same app and camera/microphone permissions carry over (the Keychain
//    still asks once per update without an Apple team). Without it, an ad-hoc signature (a new app
//    to macOS every build).
//    Apple code signing (when there's a Developer ID) replaces this afterwards.
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

  vmpSign(context.appOutDir)

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const identity = signingIdentity()
  if (identity === '-') console.warn(`  • No "${SIGNING_IDENTITY}" certificate: signed ad hoc, so updates ask for the Keychain again.`)
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' })
}

/** The certificate releases are signed with (a self-signed code-signing certificate in the login keychain). */
const SIGNING_IDENTITY = process.env.ZEPPER_SIGNING_IDENTITY || 'Zepper Signing'

function signingIdentity() {
  try {
    const found = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
    return found.includes(`"${SIGNING_IDENTITY}"`) ? SIGNING_IDENTITY : '-'
  } catch {
    return '-'
  }
}

function vmpSign(appOutDir) {
  const python = join(__dirname, '..', '.evs', 'bin', 'python')
  if (!existsSync(python)) {
    console.warn('  • VMP signing skipped (no .evs client): protected video will not play in this build. See README "Protected video".')
    return
  }
  try {
    execFileSync(python, ['-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', appOutDir], { stdio: 'inherit' })
  } catch {
    console.warn('  • VMP signing failed (run "npm run vmp:login"?): protected video will not play in this build.')
  }
}
