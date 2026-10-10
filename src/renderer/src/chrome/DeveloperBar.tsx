import type { DevToolsPanel, Pane, Snapshot, Tab } from '@shared/types'
import { zepper } from '../bridge'
import {
  IconClose,
  IconConsole,
  IconFrame,
  IconInfo,
  IconInspect,
  IconLink,
  IconNetwork,
  IconPuzzle,
  IconScreenshot,
  IconSplit
} from '../icons'
import { cx, rectOf, shortcut } from '../util'

/**
 * Developer Mode, as in Arc: over the page of a site you're building, a bar with its full address
 * and the tools you reach for (copy the address, Portrait Mode, a capture, DevTools' Console,
 * Network and Inspect, extensions, split view).
 */
export function DeveloperLayer({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  return (
    <>
      {snapshot.panes.map((pane) => {
        const tab = snapshot.tabs.find((t) => t.id === pane.tabId)
        if (!tab) return null
        const panel = snapshot.devtools.find((d) => d.tabId === pane.tabId)?.panel ?? null
        return (
          <div key={pane.tabId}>
            {pane.bar && <DeveloperBar pane={pane} tab={tab} active={tab.id === snapshot.activeTabId} panel={panel} />}
          </div>
        )
      })}
    </>
  )
}

function DeveloperBar({
  pane,
  tab,
  active,
  panel
}: {
  pane: Pane
  tab: Tab
  /** The pane you're in (in a split, the others' buttons bring theirs forward first). */
  active: boolean
  panel: DevToolsPanel | null
}): React.JSX.Element {
  const bar = pane.bar!
  const address = parts(tab.url)
  const focus = (): void => {
    if (!active) zepper.send({ type: 'tab.activate', tabId: tab.id })
  }
  const devtools = (which: DevToolsPanel): void => zepper.send({ type: 'devtools.show', tabId: tab.id, panel: which })

  return (
    <div className="dev-bar" style={{ left: bar.x, top: bar.y, width: bar.width, height: bar.height }}>
      <button
        className="dev-button"
        title="Site information"
        onClick={(e) => {
          focus()
          zepper.send({ type: 'ui.siteInfo', anchor: rectOf(e.currentTarget) })
        }}
      >
        <IconInfo size={15} />
      </button>
      <div className="dev-url" title={tab.url}>
        <span className="dev-url-scheme">{address.scheme}</span>
        <span className="dev-url-host">{address.host}</span>
        <span className="dev-url-rest">{address.rest}</span>
      </div>
      <div className="dev-tools">
        <button className="dev-button" title="Copy address" onClick={() => zepper.send({ type: 'developer.copyUrl', tabId: tab.id })}>
          <IconLink size={15} />
        </button>
        <span className="dev-separator" />
        <button
          className="dev-button"
          title="Capture in Portrait Mode"
          onClick={(e) => zepper.send({ type: 'developer.portrait', tabId: tab.id, anchor: rectOf(e.currentTarget) })}
        >
          <IconFrame size={15} />
        </button>
        <button
          className="dev-button"
          title={`Capture (${shortcut('⇧⌘2')})`}
          onClick={() => zepper.send({ type: 'developer.capture', tabId: tab.id })}
        >
          <IconScreenshot size={15} />
        </button>
        <span className="dev-separator" />
        <button
          className={cx('dev-button', panel === 'console' && 'on')}
          title={`Console (${shortcut('⌥⌘J')})`}
          onClick={() => devtools('console')}
        >
          <IconConsole size={15} />
        </button>
        <button className={cx('dev-button', panel === 'network' && 'on')} title="Network" onClick={() => devtools('network')}>
          <IconNetwork size={15} />
        </button>
        <button
          className={cx('dev-button', (panel === 'inspect' || panel === 'elements') && 'on')}
          title={`Inspect an element (${shortcut('⌥⌘I')} for Elements)`}
          onClick={() => devtools('inspect')}
        >
          <IconInspect size={15} />
        </button>
        <span className="dev-separator" />
        <button
          className="dev-button"
          title="Extensions"
          onClick={(e) => {
            focus()
            zepper.send({ type: 'ui.openPopover', popover: { kind: 'extensions', anchor: rectOf(e.currentTarget) } })
          }}
        >
          <IconPuzzle size={15} />
        </button>
        <button
          className="dev-button"
          title="Open a page beside it"
          onClick={() => {
            focus()
            zepper.send({ type: 'ui.openPalette', mode: 'split' })
          }}
        >
          <IconSplit size={15} />
        </button>
        <button
          className="dev-button"
          title={`Turn off Developer Mode for ${address.hostname} (${shortcut('⌥⇧⌘D')})`}
          onClick={() => zepper.send({ type: 'developer.toggle', tabId: tab.id })}
        >
          <IconClose size={13} />
        </button>
      </div>
    </div>
  )
}

/** The address in parts: its scheme (dimmed), host and port (the part that matters), and the rest. */
function parts(url: string): { scheme: string; host: string; hostname: string; rest: string } {
  try {
    const parsed = new URL(url)
    return {
      scheme: `${parsed.protocol}//`,
      host: parsed.host,
      hostname: parsed.hostname.replace(/^www\./, ''),
      rest: `${parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
    }
  } catch {
    return { scheme: '', host: url, hostname: url, rest: '' }
  }
}
