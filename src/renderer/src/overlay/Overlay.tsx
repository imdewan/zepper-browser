import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { SEARCH_ENGINES } from '@shared/settings'
import { prefersDarkUi, themeAccent } from '@shared/theme'
import type { AboutInfo, FindResult, OverlayMode, PopoverSpec, ToastSpec, UiEvent } from '@shared/types'
import { zepper } from '../bridge'
import { useSnapshot, useSystemDark, useUiEvents } from '../useSnapshot'
import { uiAttributes } from '../chrome/App'
import { CaptureOverlay, CaptureResult, type CaptureResultInfo, type CaptureSession } from './Capture'
import { CreateSpaceDialog } from './CreateSpaceDialog'
import { FindBar } from './FindBar'
import { Palette } from './Palette'
import { Peek } from './Peek'
import { SettingsPanel } from './SettingsPanel'
import { AboutPanel } from './AboutPanel'
import { DownloadsPanel } from './DownloadsPanel'
import { HistoryPanel } from './HistoryPanel'
import { Popover } from './Popovers'
import { Toasts } from './Toasts'
import { cx, setViewOffsetX } from '../util'

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
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [creatingSpace, setCreatingSpace] = useState(false)
  const [peek, setPeek] = useState<'shown' | 'exiting' | null>(null)
  const [capture, setCapture] = useState<CaptureSession | null>(null)
  const [captureResult, setCaptureResult] = useState<CaptureResultInfo | null>(null)
  const [exiting, setExiting] = useState(false)
  const lastMode = useRef<OverlayMode | null>(null)

  useUiEvents(
    useCallback((event: UiEvent) => {
      if (event.type === 'palette.open') {
        setPopover(null)
        setPalette({ mode: event.mode, currentUrl: event.currentUrl, key: Date.now() })
      } else if (event.type === 'capture.start') {
        setPalette(null)
        setPopover(null)
        setCaptureResult(null)
        setCapture({ page: event.page, targets: event.targets, scrolls: event.scrolls })
      } else if (event.type === 'capture.result') {
        setCaptureResult({ thumbnail: event.thumbnail, width: event.width, height: event.height, saved: event.saved })
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
        setHistoryOpen(false)
        setDownloadsOpen(false)
        setAbout(null)
        setSettingsSection(event.section)
        setSettingsOpen(true)
      } else if (event.type === 'space.startCreate') {
        setPalette(null)
        setPopover(null)
        setCreatingSpace(true)
      } else if (event.type === 'downloads.open') {
        // One panel at a time: a new one replaces whatever was open.
        setPalette(null)
        setPopover(null)
        setSettingsOpen(false)
        setHistoryOpen(false)
        setAbout(null)
        setDownloadsOpen(true)
      } else if (event.type === 'about.open') {
        setPalette(null)
        setPopover(null)
        setSettingsOpen(false)
        setHistoryOpen(false)
        setDownloadsOpen(false)
        setAbout(event.info)
      } else if (event.type === 'history.open') {
        setPalette(null)
        setPopover(null)
        setSettingsOpen(false)
        setDownloadsOpen(false)
        setAbout(null)
        setHistoryOpen(true)
      } else if (event.type === 'peek.show') {
        setPeek('shown')
      } else if (event.type === 'overlay.dismiss') {
        setPalette(null)
        setPopover(null)
        setSettingsOpen(false)
        setHistoryOpen(false)
        setAbout(null)
        setDownloadsOpen(false)
        setCreatingSpace(false)
        setPeek((p) => (p ? 'exiting' : p))
        zepper.send({ type: 'ui.closePalette', refocus: true })
      }
    }, [])
  )

  const wantsFull =
    capture !== null ||
    palette !== null ||
    popover !== null ||
    settingsOpen ||
    historyOpen ||
    downloadsOpen ||
    about !== null ||
    creatingSpace ||
    exiting
  // During a right-hand peek this view sits at the window's right edge; rects sent to main are in window coordinates.
  const peekOffset =
    peek === 'shown' && !wantsFull && snapshot?.settings.sidebarPosition === 'right'
      ? snapshot.windowSize.width - (snapshot.sidebarWidth + 24)
      : 0
  useEffect(() => setViewOffsetX(peekOffset), [peekOffset])
  const mode: OverlayMode = wantsFull ? 'full' : peek ? 'peek' : toasts.length > 0 || find || captureResult ? 'corner' : 'hidden'
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
  const closeDownloads = useCallback(() => {
    setExiting(true)
    setDownloadsOpen(false)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closeAbout = useCallback(() => {
    setExiting(true)
    setAbout(null)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closeHistory = useCallback(() => {
    setExiting(true)
    setHistoryOpen(false)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])
  const closePopover = useCallback(() => {
    setExiting(true)
    setPopover(null)
    zepper.send({ type: 'ui.closePalette', refocus: true })
  }, [])

  if (!snapshot) return null
  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId)
  const popoverSpace = popover && 'spaceId' in popover ? snapshot.spaces.find((s) => s.id === popover.spaceId) : undefined
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
        {peek === 'shown' && !wantsFull && (
          <Peek key="peek" snapshot={snapshot} onHide={() => setPeek('exiting')} onShow={() => setPeek('shown')} />
        )}
      </AnimatePresence>
      <AnimatePresence onExitComplete={() => setExiting(false)}>
        {settingsOpen && (
          <SettingsPanel
            key="settings"
            settings={snapshot.settings}
            widevine={snapshot.widevine}
            tidy={snapshot.tidy}
            defaultBrowser={snapshot.defaultBrowser}
            intelligence={snapshot.intelligence}
            initialSection={settingsSection}
            onClose={closeSettings}
          />
        )}
        {historyOpen && <HistoryPanel key="history" meaning={snapshot.intelligence.embeddings} onClose={closeHistory} />}
        {about && <AboutPanel key="about" info={about} onClose={closeAbout} />}
        {downloadsOpen && <DownloadsPanel key="downloads" downloads={snapshot.downloads} onClose={closeDownloads} />}
        {creatingSpace && (
          <CreateSpaceDialog
            key="create"
            systemDark={systemDark}
            spaces={snapshot.spaces}
            activeSpaceId={snapshot.activeSpaceId}
            windowKind={snapshot.kind}
            onClose={closeCreate}
          />
        )}
        {palette && (
          <Palette
            key={palette.key}
            mode={palette.mode}
            currentUrl={palette.currentUrl}
            engineName={SEARCH_ENGINES[snapshot.settings.searchEngine].name}
            onClose={closePalette}
            // Centred on the page area, not the whole window (the sidebar takes the rest).
            insetLeft={!snapshot.compact && snapshot.settings.sidebarPosition === 'left' ? snapshot.sidebarWidth : 0}
            insetRight={!snapshot.compact && snapshot.settings.sidebarPosition === 'right' ? snapshot.sidebarWidth : 0}
          />
        )}
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
      <AnimatePresence>{capture && <CaptureOverlay key="capture" session={capture} onDone={() => setCapture(null)} />}</AnimatePresence>
      <div className={cx('corner', peek === 'shown' && !wantsFull && 'corner-in-peek')}>
        <AnimatePresence>{find && <FindBar key="find" result={find.result} focusKey={find.key} onClose={closeFind} />}</AnimatePresence>
        <AnimatePresence>
          {captureResult && <CaptureResult key="capture-result" result={captureResult} onDismiss={() => setCaptureResult(null)} />}
        </AnimatePresence>
        <Toasts toasts={toasts} onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))} />
      </div>
    </div>
  )
}
