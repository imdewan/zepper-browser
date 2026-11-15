const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_LIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?(\/.*)?$/i

/** Whether typed text starts with a scheme (https:, file:…), not a host and port (localhost:3000). */
export function hasScheme(text: string): boolean {
  return SCHEME.test(text) && !/^[a-z0-9-]+:\d+/i.test(text)
}

/**
 * Whether typed text should be treated as a URL rather than a search. As in Chrome, a space in the
 * host makes it a search, but a link with its scheme can have spaces after its host (a pasted
 * `https://…?trackNo= 123`). Without a scheme, any space still means a search.
 */
export function looksLikeUrl(input: string): boolean {
  const text = input.trim()
  if (!text) return false
  if (hasScheme(text)) {
    const host = text.replace(SCHEME, '').replace(/^\/\//, '').split(/[/?#]/)[0]
    return /^(https?|file|about|data|chrome|view-source):/i.test(text) && !/\s/.test(host)
  }
  return !/\s/.test(text) && HOST_LIKE.test(text)
}

/** A typed URL as it's loaded: its spaces escaped (%20), as Chrome does. */
export function escapeSpaces(url: string): string {
  if (!/\s/.test(url)) return url
  try {
    return new URL(url).href
  } catch {
    return url.replace(/\s/g, '%20')
  }
}
