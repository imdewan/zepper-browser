import { useRef } from 'react'
import type { DevToolsPanel, Pane, Snapshot, Tab } from '@shared/types'
import { zepper } from '../bridge'
import type { Settings } from '@shared/settings'
import {
  IconClose,
  IconConsole,
  IconDockBottom,
  IconDockRight,
  IconOwnWindow,
  IconFrame,
  IconInfo,
  IconInspect,
  IconLink,
  IconNetwork,
  IconPuzzle,
  IconScreenshot,
  IconSplit
} from '../icons'
import { cx, rectOf } from '../util'

/**
 * Developer Mode, as in Arc: over the page of a site you're building, a bar with its full address
 * and the tools you reach for (copy the address, Portrait Mode, a capture, DevTools' Console,
 * Network and Inspect, extensions, split view). And for any page with DevTools docked: their own
 * bar (dock side, a window of their own, close) and the divider to resize them.
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
            {pane.devtoolsHeader && <DevToolsHeader pane={pane} dock={snapshot.settings.devtoolsDock} />}
            {pane.devtools && <DevToolsDivider pane={pane} dock={snapshot.settings.devtoolsDock} />}
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
        <button className="dev-button" title="Capture (⇧⌘2)" onClick={() => zepper.send({ type: 'developer.capture', tabId: tab.id })}>
          <IconScreenshot size={15} />
        </button>
        <span className="dev-separator" />
        <button className={cx('dev-button', panel === 'console' && 'on')} title="Console (⌥⌘J)" onClick={() => devtools('console')}>
          <IconConsole size={15} />
        </button>
        <button className={cx('dev-button', panel === 'network' && 'on')} title="Network" onClick={() => devtools('network')}>
          <IconNetwork size={15} />
        </button>
        <button
          className={cx('dev-button', (panel === 'inspect' || panel === 'elements') && 'on')}
          title="Inspect an element (⌥⌘I for Elements)"
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
          title={`Turn off Developer Mode for ${address.hostname} (⌥⇧⌘D)`}
          onClick={() => zepper.send({ type: 'developer.toggle', tabId: tab.id })}
        >
          <IconClose size={13} />
        </button>
      </div>
    </div>
  )
}

/** Docked DevTools' own bar: where they go (beside the page, below it, or a window of their own) and close. */
function DevToolsHeader({ pane, dock }: { pane: Pane; dock: Settings['devtoolsDock'] }): React.JSX.Element {
  const rect = pane.devtoolsHeader!
  const place = (where: Settings['devtoolsDock']): void => zepper.send({ type: 'devtools.dock', tabId: pane.tabId, dock: where })
  return (
    <div className="devtools-header" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <span className="devtools-title">DevTools</span>
      <button className={cx('dev-button', 'small', dock === 'right' && 'on')} title="Dock to the right" onClick={() => place('right')}>
        <IconDockRight size={14} />
      </button>
      <button className={cx('dev-button', 'small', dock === 'bottom' && 'on')} title="Dock to the bottom" onClick={() => place('bottom')}>
        <IconDockBottom size={14} />
      </button>
      <button className="dev-button small" title="Open in a window of their own" onClick={() => place('window')}>
        <IconOwnWindow size={14} />
      </button>
      <span className="dev-separator" />
      <button
        className="dev-button small"
        title="Close DevTools (⌥⌘I)"
        onClick={() => zepper.send({ type: 'devtools.close', tabId: pane.tabId })}
      >
        <IconClose size={12} />
      </button>
    </div>
  )
}

/** Between the page and docked DevTools: drag it to give either more room. */
function DevToolsDivider({ pane, dock }: { pane: Pane; dock: Settings['devtoolsDock'] }): React.JSX.Element {
  const page = pane.page
  const header = pane.devtoolsHeader!
  const frame = useRef(0)
  const below = dock === 'bottom'
  // The gap between the page and the DevTools area (their bar and them).
  const style = below
    ? { left: page.x, top: page.y + page.height, width: page.width, height: header.y - (page.y + page.height) }
    : {
        left: page.x + page.width,
        top: header.y,
        width: header.x - (page.x + page.width),
        height: pane.devtools!.y + pane.devtools!.height - header.y
      }
  const end = below ? pane.rect.y + pane.rect.height : pane.rect.x + pane.rect.width
  const gap = below ? style.height : style.width
  return (
    <div
      className={cx('devtools-divider', below && 'horizontal')}
      style={style}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const size = end - (below ? e.clientY : e.clientX) - gap / 2
        cancelAnimationFrame(frame.current)
        frame.current = requestAnimationFrame(() => zepper.send({ type: 'devtools.resize', size }))
      }}
    />
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
