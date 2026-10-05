import { app, type Certificate, type Session } from 'electron'
import { X509Certificate } from 'node:crypto'
import type { CertificateChain, CertificateEntry, CertificateInfo, NameField, PermissionState } from '@shared/types'
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
export function settingKeys(permission: string, mediaTypes?: string[], externalURL?: string): string[] | null {
  if (permission === 'openExternal') {
    // Allowing one app (say, Zoom) doesn't allow every other app.
    const scheme = schemeOf(externalURL)
    return scheme ? [`openExternal:${scheme}`] : null
  }
  if (permission === 'media') {
    const types = mediaTypes?.length ? mediaTypes : ['audio', 'video']
    return types.map((t) => (t === 'video' ? 'camera' : 'microphone'))
  }
  return PROMPT_LABELS[permission] ? [permission] : null
}

export function promptLabel(permission: string, keys: string[], externalURL?: string): string {
  if (permission === 'openExternal' && externalURL) {
    const name = app.getApplicationNameForProtocol(externalURL).replace(/\.app$/, '')
    return name ? `Open ${name}` : `Open “${schemeOf(externalURL)}:” links in another app`
  }
  if (permission === 'media') {
    const camera = keys.includes('camera')
    const mic = keys.includes('microphone')
    return camera && mic ? 'Use your camera and microphone' : camera ? 'Use your camera' : 'Use your microphone'
  }
  return PROMPT_LABELS[permission] ?? `Use “${permission}”`
}

function schemeOf(url: string | undefined): string {
  try {
    return url ? new URL(url).protocol.slice(0, -1).toLowerCase() : ''
  } catch {
    return ''
  }
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
  private readonly file: JsonFile<Record<string, Record<string, 'allow' | 'block'>>> | null
  private readonly data: Record<string, Record<string, 'allow' | 'block'>>

  /** `persist: false` keeps decisions in memory only (private windows). */
  constructor(persist = true) {
    this.file = persist ? new JsonFile('site-settings.json', 500) : null
    this.data = this.file?.read() ?? {}
  }

  get(origin: string, key: string): PermissionState {
    return this.data[origin]?.[key] ?? 'ask'
  }

  set(origin: string, key: string, state: PermissionState): void {
    const site = (this.data[origin] ??= {})
    if (state === 'ask') delete site[key]
    else site[key] = state
    if (Object.keys(site).length === 0) delete this.data[origin]
    this.file?.schedule(this.data)
  }

  list(origin: string): { permission: string; label: string; state: PermissionState }[] {
    return LISTED.map(({ key, label }) => ({ permission: key, label, state: this.get(origin, key) }))
  }

  isAlwaysAllowed(permission: string): boolean {
    return ALWAYS_ALLOW.has(permission)
  }

  flush(): void {
    this.file?.flush()
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

  /** The full chain (leaf to root) parsed for the certificate viewer. */
  chain(host: string): CertificateChain | null {
    const captured = this.certs.get(host)
    if (!captured) return null
    const entries: CertificateEntry[] = []
    const seen = new Set<string>()
    for (let cert: Certificate | undefined = captured.certificate; cert && !seen.has(cert.fingerprint); cert = cert.issuerCert) {
      seen.add(cert.fingerprint)
      entries.push(parseCertificate(cert))
    }
    return { host, trusted: captured.trusted, entries }
  }

  /** PEM of the n-th certificate in the chain, for export. */
  pem(host: string, index: number): string | null {
    let cert: Certificate | undefined = this.certs.get(host)?.certificate
    for (let i = 0; cert && i < index; i++) cert = cert.issuerCert
    return cert?.data ?? null
  }

  info(host: string): CertificateInfo | null {
    const captured = this.certs.get(host)
    if (!captured) return null
    const { certificate } = captured
    const issuer = [certificate.issuer.commonName, certificate.issuer.organizations?.[0]].filter(Boolean).join(' · ')
    return {
      subject: certificate.subject.commonName || certificate.subjectName,
      issuer: issuer || certificate.issuerName,
      validFrom: certificate.validStart * 1000,
      validTo: certificate.validExpiry * 1000,
      fingerprint: certificate.fingerprint
    }
  }
}

const NAME_LABELS: Record<string, string> = {
  CN: 'Common Name',
  O: 'Organization',
  OU: 'Organizational Unit',
  L: 'Locality',
  ST: 'State',
  C: 'Country'
}

function parseName(dn: string): NameField[] {
  return dn
    .split('\n')
    .map((line) => {
      const i = line.indexOf('=')
      return { key: line.slice(0, i), value: line.slice(i + 1) }
    })
    .filter((f) => NAME_LABELS[f.key])
    .sort((a, b) => Object.keys(NAME_LABELS).indexOf(a.key) - Object.keys(NAME_LABELS).indexOf(b.key))
    .map((f) => ({ label: NAME_LABELS[f.key], value: f.value }))
}

function describeKey(x509: X509Certificate): string {
  const key = x509.publicKey
  const details = key.asymmetricKeyDetails
  if (key.asymmetricKeyType === 'ec') return `Elliptic Curve ${details?.namedCurve ?? ''}`.trim()
  if (key.asymmetricKeyType === 'rsa') return `RSA ${details?.modulusLength ?? ''}-bit`
  return (key.asymmetricKeyType ?? 'Unknown').toUpperCase()
}

function parseCertificate(cert: Certificate): CertificateEntry {
  const fallback: CertificateEntry = {
    commonName: cert.subject.commonName || cert.subjectName,
    subject: [{ label: 'Common Name', value: cert.subjectName }],
    issuer: [{ label: 'Common Name', value: cert.issuerName }],
    serialNumber: cert.serialNumber,
    validFrom: cert.validStart * 1000,
    validTo: cert.validExpiry * 1000,
    sha256: cert.fingerprint.replace(/^sha256\//, ''),
    sha1: '',
    altNames: [],
    publicKey: '',
    signatureAlgorithm: '',
    isCA: false
  }
  try {
    const x509 = new X509Certificate(cert.data)
    return {
      ...fallback,
      subject: parseName(x509.subject),
      issuer: parseName(x509.issuer),
      serialNumber: x509.serialNumber.replace(/(..)(?!$)/g, '$1:'),
      sha256: x509.fingerprint256,
      sha1: x509.fingerprint,
      altNames: (x509.subjectAltName ?? '')
        .split(', ')
        .filter(Boolean)
        .map((n) => n.replace(/^(DNS|IP Address):/, '')),
      publicKey: describeKey(x509),
      signatureAlgorithm: x509.signatureAlgorithm ?? '',
      isCA: x509.ca
    }
  } catch {
    return fallback
  }
}
