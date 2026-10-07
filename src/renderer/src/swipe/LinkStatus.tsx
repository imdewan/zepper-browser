import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { zepper } from '../bridge'
import { cx } from '../util'

/**
 * A link's address as Chrome shows it: http:// left off (https:// kept), no slash after a bare
 * host, escapes decoded. Split into scheme, host and the rest, so the site stands out and a long
 * path is what gets cut short.
 */
export function linkAddress(url: string): { scheme: string; host: string; rest: string } {
  let text = url
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') text = text.replace(/^http:\/\//i, '')
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) text = text.replace(/\/$/, '')
  } catch {
    // Not a URL we can read: shown as it is.
  }
  try {
    text = decodeURI(text)
  } catch {
    // Malformed escapes stay escaped.
  }
  const [lead = '', scheme = '', host = ''] = /^([a-z][\w+.-]*:\/\/)?([^/?#]*)/i.exec(text) ?? []
  return { scheme, host, rest: text.slice(lead.length) }
}

/**
 * The address of the link you're pointing at, in the page's bottom corner (see Browser.onTargetUrl).
 * Main sizes its view to the bubble, so the bubble reports its size whenever it changes.
 */
export function LinkStatus(): React.JSX.Element | null {
  const [link, setLink] = useState<{ url: string; maxWidth: number } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      zepper.onEvent((event) => {
        if (event.type !== 'link.status') return
        if (event.url === null) return setLeaving(true)
        setLink({ url: event.url, maxWidth: event.maxWidth })
        setLeaving(false)
      }),
    []
  )
  useLayoutEffect(() => {
    if (!link || !box.current) return
    const { width, height } = box.current.getBoundingClientRect()
    zepper.send({ type: 'ui.linkStatusSize', width, height })
  }, [link])
  if (!link) return null
  const { scheme, host, rest } = linkAddress(link.url)
  return (
    <div ref={box} className={cx('link-status', leaving && 'leaving')} style={{ '--max': `${link.maxWidth}px` } as React.CSSProperties}>
      <div className="link-status-pill">
        <span className="link-status-site">
          {scheme && <span className="link-status-scheme">{scheme}</span>}
          <span className="link-status-host">{host}</span>
        </span>
        {rest && <span className="link-status-rest">{rest}</span>}
      </div>
    </div>
  )
}
