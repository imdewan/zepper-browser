/**
 * Zepper's page for an address that didn't load, explained as Chrome explains it: what went wrong
 * (Chromium's network error codes, net/base/net_error_list.h), what to try, and the error's code.
 */

export type ErrorIcon = 'reach' | 'offline' | 'broken' | 'secure' | 'file' | 'blocked' | 'crash'

export interface ErrorText {
  title: string
  icon: ErrorIcon
  /** With {host} where the site's name goes. */
  message: string
  tips: string[]
  /** 'online': also tries again by itself once the Mac is back online. */
  retry: 'reload' | 'online' | 'none'
  certificate?: boolean
}

const REACH = 'This site can’t be reached'
const BROKEN = 'This page isn’t working'
const SECURE = 'This site can’t provide a secure connection'
const PRIVATE = 'Your connection isn’t private'
const FILE = 'Your file couldn’t be opened'
const BLOCKED = 'This page has been blocked'

const CONNECTION = ['Check your internet connection', 'Check your proxy and firewall']
const RISK = 'Someone could be trying to intercept your connection, or the site is set up incorrectly.'

const reach = (message: string, tips = CONNECTION, retry: ErrorText['retry'] = 'online'): ErrorText => ({
  title: REACH,
  icon: 'reach',
  message,
  tips,
  retry
})
const broken = (message: string, tips: string[] = []): ErrorText => ({ title: BROKEN, icon: 'broken', message, tips, retry: 'reload' })
const secure = (message: string): ErrorText => ({ title: SECURE, icon: 'secure', message, tips: [], retry: 'reload' })
const certificate = (message: string, tips: string[] = []): ErrorText => ({
  title: PRIVATE,
  icon: 'secure',
  message: `${message} ${RISK}`,
  tips,
  retry: 'none',
  certificate: true
})

const ERRORS: Record<number, ErrorText> = {
  [-2]: reach('Zepper couldn’t connect to {host}.'),
  [-6]: { title: FILE, icon: 'file', message: 'It may have been moved, renamed or deleted.', tips: [], retry: 'none' },
  [-7]: reach('{host} took too long to respond.'),
  [-10]: {
    title: FILE,
    icon: 'file',
    message: 'Zepper isn’t allowed to open it.',
    tips: ['Check that Zepper can open files there, in System Settings › Privacy & Security'],
    retry: 'none'
  },
  [-20]: { title: BLOCKED, icon: 'blocked', message: 'An extension blocked {host}.', tips: ['Check your extensions'], retry: 'reload' },
  [-21]: {
    title: 'Your connection was interrupted',
    icon: 'offline',
    message: 'A change in your network stopped the page loading.',
    tips: CONNECTION,
    retry: 'online'
  },
  [-22]: { title: BLOCKED, icon: 'blocked', message: 'Your administrator blocked {host}.', tips: [], retry: 'none' },
  [-100]: reach('{host} closed the connection unexpectedly.'),
  [-101]: reach('The connection to {host} was reset.'),
  [-102]: reach('{host} refused to connect.', ['Check the address', 'Check your proxy and firewall'], 'reload'),
  [-104]: reach('Zepper couldn’t connect to {host}.'),
  [-105]: reach('{host}’s server address couldn’t be found.', ['Check the address for a typo', ...CONNECTION]),
  [-106]: {
    title: 'No internet',
    icon: 'offline',
    message: 'You’re not connected to the internet. The page loads again once you are.',
    tips: ['Check your Wi-Fi or network cable', 'Turn Wi-Fi off and on again'],
    retry: 'online'
  },
  [-107]: secure('{host} sent an invalid response.'),
  [-109]: reach('{host} is unreachable.'),
  [-113]: secure('{host} uses a security protocol Zepper doesn’t support.'),
  [-118]: reach('{host} took too long to respond.'),
  [-130]: {
    title: 'No internet',
    icon: 'offline',
    message: 'The proxy server isn’t responding.',
    tips: ['Check your proxy in System Settings › Network'],
    retry: 'online'
  },
  [-138]: {
    title: 'Your internet access is blocked',
    icon: 'blocked',
    message: 'A firewall or security app may be blocking Zepper.',
    tips: ['Check that Zepper is allowed in your firewall or security app'],
    retry: 'reload'
  },
  [-300]: reach('The address isn’t valid.', [], 'none'),
  [-301]: reach('Zepper can’t open this kind of address.', [], 'none'),
  [-302]: reach('Zepper can’t open this kind of address.', [], 'none'),
  [-312]: reach('{host} uses a port Zepper doesn’t open web pages on.', [], 'none'),
  [-310]: broken('{host} redirected you too many times.', ['Clear this site’s cookies, then try again']),
  [-320]: broken('{host} sent an invalid response.'),
  [-324]: broken('{host} didn’t send any data.'),
  [-379]: broken('{host} can’t handle this request right now.'),
  [-200]: certificate('This site’s certificate is for a different address than {host}.'),
  [-201]: certificate('{host}’s certificate has expired or isn’t valid yet.', ['Check that your Mac’s date and time are right']),
  [-202]: certificate('{host}’s certificate isn’t from an authority your Mac trusts.'),
  [-206]: certificate('{host}’s certificate has been revoked.'),
  [-207]: certificate('{host}’s certificate isn’t valid.'),
  [-208]: certificate('{host} uses a weak security certificate.'),
  [-211]: certificate('{host} uses a weak security certificate.')
}
// The rest of Chromium's name-resolution failures read as the "not found" they are.
ERRORS[-137] = ERRORS[-105]

/** What to say about an address that failed to load, by Chromium's error code. */
export function describeError(code: number): ErrorText {
  const known = ERRORS[code]
  if (known) return known
  if (code <= -200 && code > -300) return certificate('Zepper couldn’t confirm this site’s identity, so it didn’t load the page.')
  return reach('Zepper couldn’t load {host}.')
}

/** A page whose process went away. */
export function crashError(): ErrorText {
  return { title: 'This page crashed', icon: 'crash', message: 'Something went wrong while showing {host}.', tips: [], retry: 'reload' }
}

/** Every title an error page can have (tabs restored from before took them on as their own). */
export const ERROR_TITLES = new Set([
  ...Object.values(ERRORS).map((e) => e.title),
  describeError(-299).title,
  describeError(-1).title,
  crashError().title,
  'Can’t reach this page'
])

/** The site's name, as the page says it (a file's name for a file). */
function hostOf(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname.split('/').pop() || parsed.pathname)
    return parsed.hostname || url
  } catch {
    return url
  }
}

/** Simple line drawings, one for each kind of trouble (drawn for Zepper, on a 48-point grid). */
const PAGE = '<path d="M12 6h14l10 10v26H12z"/><path d="M26 6v10h10"/>'
const ICONS: Record<ErrorIcon, string> = {
  reach: '<circle cx="24" cy="24" r="16"/><ellipse cx="24" cy="24" rx="7" ry="16"/><path d="M8 24h32"/><path d="M11 11l26 26"/>',
  offline:
    '<path d="M8 19a23 23 0 0 1 32 0"/><path d="M14 25.5a14 14 0 0 1 20 0"/><path d="M20 32a5.5 5.5 0 0 1 8 0"/><circle cx="24" cy="37" r="1.6" fill="currentColor" stroke="none"/><path d="M10 10l28 28"/>',
  broken: `${PAGE}<path d="M24 21v9"/><circle cx="24" cy="35" r="1.6" fill="currentColor" stroke="none"/>`,
  secure:
    '<rect x="12" y="21" width="24" height="19" rx="3"/><path d="M17 21v-5a7 7 0 0 1 14 0v5"/><path d="M24 26.5v5"/><circle cx="24" cy="35.5" r="1.6" fill="currentColor" stroke="none"/>',
  file: `${PAGE}<path d="M20.5 25.5a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.3-1.5 2.3v.5"/><circle cx="24" cy="36" r="1.6" fill="currentColor" stroke="none"/>`,
  blocked: '<circle cx="24" cy="24" r="16"/><path d="M12.7 12.7l22.6 22.6"/>',
  crash: `${PAGE}<path d="M16 31l4-4 3.5 3.5L28 26l4 4"/>`
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The page, as a data URL. `code` is what's shown small underneath (ERR_NAME_NOT_RESOLVED, or
 * NET::ERR_CERT_DATE_INVALID for a certificate). Reload tries the address again, as ⌘R does.
 */
export function errorPage(url: string, error: ErrorText, code: string): string {
  const host = `<strong>${escape(hostOf(url))}</strong>`
  const message = escape(error.message).replace('{host}', host)
  const tips = error.tips.length ? `<p class="try">Try:</p><ul>${error.tips.map((t) => `<li>${escape(t)}</li>`).join('')}</ul>` : ''
  const label = error.certificate && code && !code.startsWith('NET::') ? `NET::${code}` : code
  const button = error.retry === 'none' ? '' : '<button id="reload">Reload</button>'
  // The address in a script, where "</script>" mustn't appear.
  const target = JSON.stringify(url).replace(/</g, '\\u003c')
  const script =
    error.retry === 'none'
      ? ''
      : `<script>
  const retry = () => location.replace(${target})
  document.getElementById('reload').addEventListener('click', retry)
  ${error.retry === 'online' ? "addEventListener('online', retry)" : ''}
</script>`
  const html = `<!doctype html><meta charset="utf-8"><title>${escape(error.title)}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: light-dark(#fafafa, #1c1c1e); color: light-dark(#333, #ddd); }
  main { width: min(480px, 100vw - 48px); padding: 24px 0; }
  .icon { width: 56px; height: 56px; margin-bottom: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; color: light-dark(#8e8e93, #8e8e93); }
  .icon.danger { color: light-dark(#ff3b30, #ff453a); }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; color: light-dark(#111, #f2f2f2); }
  p { margin: 0 0 10px; line-height: 1.5; }
  strong { font-weight: 600; word-break: break-all; }
  .try { margin: 16px 0 4px; }
  ul { margin: 0 0 14px; padding-left: 20px; line-height: 1.7; opacity: .85; }
  .code { font-size: 12px; letter-spacing: .02em; opacity: .55; margin-top: 16px; }
  button { margin-top: 18px; height: 34px; padding: 0 18px; border: 0; border-radius: 9px; font: inherit; font-size: 13px; font-weight: 600; color: #fff; background: light-dark(#007aff, #0a84ff); cursor: pointer; }
  button:hover { filter: brightness(1.08); }
</style>
<main><svg class="icon${error.icon === 'secure' ? ' danger' : ''}" viewBox="0 0 48 48" aria-hidden="true">${ICONS[error.icon]}</svg><h1>${escape(error.title)}</h1><p>${message}</p>${tips}${label ? `<p class="code">${escape(label)}</p>` : ''}${button}</main>${script}`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
