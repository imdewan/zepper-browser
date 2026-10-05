import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { prefersDarkUi, themeAccent } from '@shared/theme'
import type { FindResult, OverlayMode, PopoverSpec, ToastSpec, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { useSnapshot, useSystemDark, useUiEvents } from '../useSnapshot'
import { uiAttributes } from '../chrome/App'
import { CreateSpaceDialog } from './CreateSpaceDialog'
import { FindBar } from './FindBar'
import { Palette } from './Palette'
import { Peek } from './Peek'
import { SettingsPanel } from './SettingsPanel'
import { Popover } from './Popovers'
import { Toasts } from './Toasts'

/**
 * The transparent view stacked above web content. It tells the main process
 * how much of the window it needs: everything while the palette or a popover
 * is open, only the toast corner while toasts show, otherwise nothing.
 */
export function Overlay(): React.JSX.Element | null {
  const snapshot = useSnapshot()
  const systemDark = useSystemDark()
  const [palette, setPalette] = useState<{ mode: 'new' | 'current' | 'split'; currentUrl: string | null; key: number } | null>(null)
  const [popover, setPopover] = useState<PopoverSpec | null>(null)
  const [toasts, setToasts] = useState<ToastSpec[]>([])
  const [find, setFind] = useState<{ key: number; result: FindResult } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [creatingSpace, setCreatingSpace] = useState(false)
  const [peek, setPeek] = useState<'shown' | 'exiting' | null>(null)
  const [exiting, setExiting] = useState(false)
  const lastMode = useRef<OverlayMode | null>(null)

  useUiEvents(
    useCallback((event: UiEvent) => {
      if (event.type === 'palette.open') {
        setPopover(null)
        setPalette({ mode: event.mode, currentUrl: event.currentUrl, key: Date.now() })
      } else if (event.type === 'toast') {
        setToasts((list) => [...list.filter((t) => t.id !== event.toast.id), event.toast])
      } else if (event.type === 'popover.open') {
        setPalette(null)
        setPopover(event.popover)
      } else if (event.type === 'find.open') {
        setFind((f) => ({ key: Date.now(), result: f?.result ?? { active: 0, matches: 0 } }))
      } else if (event.type === 'find.result') {
        setFind((f) => (f ? { ...f, result: event.result } : f))
      } else if (event.type === 'settings.open') {
        setPalette(null)
        setPopover(null)
        setSettingsOpen(true)
      } else if (event.type === 'space.startCreate') {
        setPalette(null)
        setPopover(null)
        setCreatingSpace(true)
      } else if (event.type === 'peek.show') {
        setPeek('shown')
      } else if (event.type === 'overlay.dismiss') {
        setPalette(null)
        setPopover(null)
        setSettingsOpen(false)
        setCreatingSpace(false)
        setPeek((p) => (p ? 'exiting' : p))
        zepper.send({ type: 'ui.closePalette', refocus: true })
      }
    }, [])
  )

  const wantsFull = palette !== null || popover !== null || settingsOpen || creatingSpace || exiting
  const mode: OverlayMode = wantsFull
    ? 'full'
    : peek
      ? 'peek'
      : toasts.length > 0 || find
        ? 'corner'
        : 'hidden'
  useEffect(() => {
    if (lastMode.current === mode) return
    lastMode.current = mode
    zepper.send({ type: 'ui.overlayMode', mode })
  }, [mode])

  const closePalette = useCallback(() => {
    setExiting(true)
    setPalette(null)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closeFind = useCallback(() => {
    setFind(null)
    zepper.send({ type: 'find.stop' })
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closeCreate = useCallback(() => {
    setExiting(true)
    setCreatingSpace(false)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closeSettings = useCallback(() => {
    setExiting(true)
    setSettingsOpen(false)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closePopover = useCallback(() => {
    setExiting(true)
    setPopover(null)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])

  if (!snapshot) return null
  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId)
  const popoverSpace =
    popover && 'spaceId' in popover ? snapshot.spaces.find((s) => s.id === popover.spaceId) : undefined
  const dark = space ? prefersDarkUi(space.theme, systemDark) : systemDark
  const accent = space ? themeAccent(space.theme) : null

  return (
    <div
      className="overlay"
      data-ui={dark ? 'dark' : 'light'}
      {...uiAttributes(snapshot.settings)}
      style={accent ? ({ '--accent': accent } as React.CSSProperties) : undefined}
    >
      <AnimatePresence
        onExitComplete={() => {
          setPeek(null)
          zepper.send({ type: 'ui.peekSidebar', show: false })
        }}
      >
        {peek === 'shown' && !wantsFull && <Peek key="peek" snapshot={snapshot} onHide={() => setPeek('exiting')} />}
      </AnimatePresence>
      <AnimatePresence onExitComplete={() => setExiting(false)}>
        {settingsOpen && <SettingsPanel key="settings" settings={snapshot.settings} widevine={snapshot.widevine} onClose={closeSettings} />}
        {creatingSpace && <CreateSpaceDialog key="create" systemDark={systemDark} onClose={closeCreate} />}
        {palette && <Palette key={palette.key} mode={palette.mode} currentUrl={palette.currentUrl} onClose={closePalette} />}
        {popover && (
          <Popover
            key="popover"
            popover={popover}
            space={popoverSpace}
            snapshot={snapshot}
            pinnedExtensions={snapshot?.settings.pinnedExtensions ?? []}
            onClose={closePopover}
          />
        )}
      </AnimatePresence>
      <div className="corner">
        <AnimatePresence>{find && <FindBar key="find" result={find.result} focusKey={find.key} onClose={closeFind} />}</AnimatePresence>
        <Toasts toasts={toasts} onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))} />
      </div>
    </div>
  )
}
