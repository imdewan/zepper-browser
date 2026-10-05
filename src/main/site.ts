import type { Certificate, Session } from 'electron'
import type { CertificateInfo, PermissionState } from '@shared/types'
import { JsonFile } from './persist'

/** Permissions granted silently; everything else sensitive asks first. */
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access'
])

/** Site-setting keys shown in the site info panel, in display order. */
const LISTED: { key: string; label: string }[] = [
  { key: 'camera', label: 'Camera' },
  { key: 'microphone', label: 'Microphone' },
  { key: 'geolocation', label: 'Location' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'display-capture', label: 'Screen sharing' },
  { key: 'clipboard-read', label: 'Clipboard' }
]

const PROMPT_LABELS: Record<string, string> = {
  geolocation: 'Know your location',
  notifications: 'Show notifications',
  'clipboard-read': 'See text and images you copy',
  'display-capture': 'Share your screen',
  midiSysex: 'Control your MIDI devices',
  midi: 'Use your MIDI devices',
  'idle-detection': 'Know when you’re actively using this device',
  'window-management': 'Manage windows on all your displays',
  openExternal: 'Open an app on your computer',
  hid: 'Connect to HID devices',
  serial: 'Connect to serial ports',
  usb: 'Connect to USB devices'
}

/** Maps an Electron permission request to the site-setting keys it needs. */
export function settingKeys(permission: string, mediaTypes?: string[]): string[] | null {
  if (permission === 'media') {
    const types = mediaTypes?.length ? mediaTypes : ['audio', 'video']
    return types.map((t) => (t === 'video' ? 'camera' : 'microphone'))
  }
  return PROMPT_LABELS[permission] ? [permission] : null
}

export function promptLabel(permission: string, keys: string[]): string {
  if (permission === 'media') {
    const camera = keys.includes('camera')
    const mic = keys.includes('microphone')
    return camera && mic ? 'Use your camera and microphone' : camera ? 'Use your camera' : 'Use your microphone'
  }
  return PROMPT_LABELS[permission] ?? `Use “${permission}”`
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Remembered per-origin permission decisions. */
export class SitePermissions {
  private readonly file = new JsonFile<Record<string, Record<string, 'allow' | 'block'>>>('site-settings.json', 500)
  private readonly data: Record<string, Record<string, 'allow' | 'block'>>

  constructor() {
    this.data = this.file.read() ?? {}
  }

  get(origin: string, key: string): PermissionState {
    return this.data[origin]?.[key] ?? 'ask'
  }

  set(origin: string, key: string, state: PermissionState): void {
    const site = (this.data[origin] ??= {})
    if (state === 'ask') delete site[key]
    else site[key] = state
    if (Object.keys(site).length === 0) delete this.data[origin]
    this.file.schedule(this.data)
  }

  list(origin: string): { permission: string; label: string; state: PermissionState }[] {
    return LISTED.map(({ key, label }) => ({ permission: key, label, state: this.get(origin, key) }))
  }

  isAlwaysAllowed(permission: string): boolean {
    return ALWAYS_ALLOW.has(permission)
  }

  flush(): void {
    this.file.flush()
  }
}

interface CapturedCert {
  certificate: Certificate
  trusted: boolean
}

/** Remembers the certificate each host presented, for the site info panel. */
export class CertificateStore {
  private readonly certs = new Map<string, CapturedCert>()

  attach(session: Session): void {
    session.setCertificateVerifyProc((request, callback) => {
      this.certs.set(request.hostname, {
        certificate: request.certificate,
        trusted: request.verificationResult === 'net::OK'
      })
      // -3: use Chromium's own verification result.
      callback(-3)
    })
  }

  get(host: string): CapturedCert | undefined {
    return this.certs.get(host)
  }

  info(host: string): CertificateInfo | null {
    const captured = this.certs.get(host)
    if (!captured) return null
    const { certificate } = captured
    const issuer = [certificate.issuer.commonName, certificate.issuer.organizations?.[0]]
      .filter(Boolean)
      .join(' · ')
    return {
      subject: certificate.subject.commonName || certificate.subjectName,
      issuer: issuer || certificate.issuerName,
      validFrom: certificate.validStart * 1000,
      validTo: certificate.validExpiry * 1000,
      fingerprint: certificate.fingerprint
    }
  }
}

