import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  Hand,
  KeyRound,
  Keyboard,
  Layers,
  Music,
  Palette,
  Puzzle,
  Search,
  Settings2,
  ShieldCheck,
  type LucideIcon
} from 'lucide-react'
import { motion } from 'motion/react'
import {
  PINNED_CLOSE_LABELS,
  PROTECTIONS,
  SEARCH_ENGINES,
  USER_AGENT_LABELS,
  type MemorySaverMode,
  type PinnedCloseBehavior,
  type SearchEngineId,
  type SecureDns,
  type Settings,
  type UserAgentChoice
} from '@shared/settings'
import type { AccessState, IntelligenceStatus, SiteDecisions, Snapshot, SystemAccess, UpdateStatus, WidevineStatus } from '@shared/types'
import { zepper } from '../bridge'
import { IconBack, IconClose } from '../icons'
import { cx, isMac, listNames } from '../util'
import { ExtensionsSettings } from './ExtensionsSettings'
import { PasswordsSettings } from './PasswordsSettings'
import { SiteListLink, SiteListPage, type SiteListItem } from './SiteListPage'
import { Toggle } from './Toggle'

/** What each Memory Saver mode does (Chrome's and Brave's timings). */
const MEMORY_SAVER_HINTS: Record<MemorySaverMode, string> = {
  moderate: 'Tabs unload after 6 hours out of sight, or sooner if your Mac runs short of memory.',
  balanced: 'Recommended. Tabs unload after 4 hours out of sight, or sooner if your Mac runs short of memory.',
  maximum: 'Tabs unload after 2 hours out of sight, or sooner if your Mac runs short of memory.'
}

/** Languages Apple's on-device translation supports. */
const TRANSLATION_LANGUAGES = [
  'ar',
  'zh',
  'nl',
  'en',
  'fr',
  'de',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'pl',
  'pt',
  'ru',
  'es',
  'th',
  'tr',
  'uk',
  'vi'
]

type Section =
  'general' | 'appearance' | 'tabs' | 'media' | 'search' | 'downloads' | 'gestures' | 'privacy' | 'passwords' | 'extensions' | 'shortcuts'

/** Sidebar sections, each with a Lucide glyph on a coloured square, like System Settings. */
/** The settings sections; `title` heads the page when it differs from the sidebar's label. */
const SECTIONS: { id: Section; label: string; title?: string; Icon: LucideIcon; color: string }[] = [
  { id: 'general', label: 'General', Icon: Settings2, color: '#8e8e93' },
  { id: 'appearance', label: 'Appearance', Icon: Palette, color: '#5e5ce6' },
  { id: 'tabs', label: 'Tabs', Icon: Layers, color: '#ff9f0a' },
  { id: 'media', label: 'Media', Icon: Music, color: '#ff375f' },
  { id: 'search', label: 'Search', Icon: Search, color: '#0a84ff' },
  { id: 'downloads', label: 'Downloads', Icon: ArrowDownToLine, color: '#30b0c7' },
  { id: 'gestures', label: 'Spaces & Gestures', Icon: Hand, color: '#bf5af2' },
  { id: 'privacy', label: 'Privacy', Icon: ShieldCheck, color: '#34c759' },
  { id: 'passwords', label: 'Passwords', Icon: KeyRound, color: '#636366' },
  { id: 'extensions', label: 'Extensions', Icon: Puzzle, color: '#ff453a' },
  { id: 'shortcuts', label: 'Shortcuts', title: 'Keyboard Shortcuts', Icon: Keyboard, color: '#48484a' }
]

/** Pages a section opens for its longer lists: what they're called, and the section they're in. */
type SubPage = 'sitePermissions' | 'protectionsOff' | 'neverSaved'
const SUB_PAGES: Record<SubPage, { title: string; section: Section }> = {
  sitePermissions: { title: 'Site permissions', section: 'privacy' },
  protectionsOff: { title: 'Sites with protections off', section: 'privacy' },
  neverSaved: { title: 'Passwords never saved', section: 'passwords' }
}

const SHORTCUTS: [string, string][] = [
  ['Command bar / new tab', '⌘T'],
  ['Open location', '⌘L'],
  ['Toggle sidebar (compact mode)', '⌘S'],
  ['Close tab / window', '⌘W / ⇧⌘W'],
  ['Reopen closed tab', '⇧⌘T'],
  ['Switch to recent tab', '⌃⇥'],
  ['Next / previous tab in sidebar', '⌥⌘↓ / ⌥⌘↑'],
  ['Pin / unpin tab', '⌘D'],
  ['Copy current URL', '⇧⌘C'],
  ['Copy URL as Markdown', '⌥⇧⌘C'],
  ['Clear unpinned tabs', '⇧⌘K'],
  ['New window / private window', '⌘N / ⇧⌘N'],
  ['Go to space 1–9', '⌃1 … ⌃9'],
  ['Go to Essential 1–9', '⌥1 … ⌥9'],
  ['Next / previous space', '⌥⌘→ / ⌥⌘←'],
  ['Go to tab 1–8 / last', '⌘1 … ⌘8 / ⌘9'],
  ['Add / remove split pane', '⌃⇧= / ⌃⇧−'],
  ['Split side by side / stacked / grid', '⌥⌘V / ⌥⌘H / ⌥⌘G'],
  ['Unsplit all', '⌥⌘U'],
  ['Screenshot', '⇧⌘2'],
  ['Print / save page as', '⌘P / ⇧⌘S'],
  ['Open file', '⌘O'],
  ['View page source', '⌥⌘U'],
  ['Find in page', '⌘F'],
  ['History / downloads', '⌘Y / ⌥⌘L'],
  ['Back / forward', '⌘[ / ⌘]'],
  ['Zoom in / out / reset', '⌘+ / ⌘− / ⌘0'],
  ['Developer tools', '⌥⌘I'],
  ['Settings', '⌘,']
]

interface SettingsPanelProps {
  settings: Settings
  widevine: WidevineStatus
  tidy: Snapshot['tidy']
  defaultBrowser: boolean
  intelligence: IntelligenceStatus
  update: UpdateStatus
  sitePermissions: SiteDecisions[]
  /** Whose passwords and site permissions these are (see Snapshot.profileScope). */
  profileScope: string[] | null
  systemAccess: SystemAccess
  /** The section to open on (e.g. "passwords" from the passwords popup). */
  initialSection?: string
  onClose: () => void
}

function widevineHint(status: WidevineStatus): string {
  switch (status.state) {
    case 'unavailable':
      return 'Not available in this build of Zepper.'
    case 'restart':
      return 'Restart Zepper to finish installing it (your tabs come back).'
    case 'installing':
      return 'Downloading from Google…'
    case 'ready':
      return `Installed${status.version ? ` · version ${status.version}` : ''}. Updated automatically.`
    case 'error':
      return 'Couldn’t install it. Check your connection, then turn it off and on again.'
    default:
      return 'Needed for protected video like Netflix or Crunchyroll. A component from Google; off until you turn it on.'
  }
}

/** Settings sheet: every change applies immediately. */
export function SettingsPanel({
  settings,
  widevine,
  tidy,
  defaultBrowser,
  intelligence,
  update,
  sitePermissions,
  profileScope,
  systemAccess,
  initialSection,
  onClose
}: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<Section>(() => SECTIONS.find((s) => s.id === initialSection)?.id ?? 'general')
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const body = useRef<HTMLDivElement>(null)
  // The bar's divider shows once the page scrolls under it.
  const [scrolled, setScrolled] = useState(false)
  // A list's own page within its section (site permissions…), with a way back.
  const [page, setPage] = useState<SubPage | null>(null)
  const set = (patch: Partial<Settings>): void => zepper.send({ type: 'settings.update', patch })
  const show = (next: Section, nextPage: SubPage | null = null): void => {
    setSection(next)
    setPage(nextPage)
    body.current?.scrollTo({ top: 0 })
    setScrolled(false)
  }
  const open = (next: Section): void => show(next)
  const openPage = (next: SubPage): void => show(SUB_PAGES[next].section, next)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Esc steps back out of a list's page first, then closes Settings.
      if (page) show(SUB_PAGES[page].section)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, page])

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="settings"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.35 }}
      >
        <nav className="settings-nav">
          <div className="settings-title">Settings</div>
          {SECTIONS.map((s) => (
            <button key={s.id} className={cx('settings-nav-item', section === s.id && 'active')} onClick={() => open(s.id)}>
              <span className="settings-nav-icon" style={{ background: s.color }}>
                <s.Icon size={12} strokeWidth={2.4} />
              </span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          {/* Stays put while the page scrolls, so closing is always one click away. */}
          <header className={cx('settings-bar', scrolled && 'scrolled', page && 'sub')}>
            {page && (
              <button className="settings-back" title={`Back to ${current.label} (Esc)`} onClick={() => show(section)}>
                <IconBack size={15} />
              </button>
            )}
            <h2>{page ? SUB_PAGES[page].title : (current.title ?? current.label)}</h2>
            <button className="settings-close" title="Close (Esc)" onClick={onClose}>
              <IconClose size={14} />
            </button>
          </header>
          <div className="settings-body" ref={body} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
            <motion.div
              key={page ?? section}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
            >
              {page === 'sitePermissions' && (
                <SiteListPage
                  items={sitePermissions.map((site) => ({ key: site.origin, site: site.host, detail: permissionSummary(site) }))}
                  action="Reset"
                  actionTitle={(item) => `Ask again on ${item.site}`}
                  empty="Sites you allow or block the camera, microphone, location, notifications or pop-ups for show up here."
                  onAction={(item) => zepper.send({ type: 'site.resetPermissions', origin: item.key })}
                />
              )}
              {page === 'protectionsOff' && (
                <SiteListPage
                  items={protectionsOff(settings)}
                  action="Turn On"
                  actionTitle={(item) => `Turn protections back on for ${item.site}`}
                  empty="Sites you turn protections off for (from the lock icon) show up here."
                  onAction={(item) => zepper.send({ type: 'site.resetProtections', domain: item.key })}
                />
              )}
              {page === 'neverSaved' && (
                <SiteListPage
                  items={settings.neverSavePasswords.map((domain) => ({ key: domain, site: domain }))}
                  action="Remove"
                  actionTitle={(item) => `Offer to save passwords on ${item.site} again`}
                  empty="Sites you choose Never for, when Zepper offers to save a password, show up here."
                  onAction={(item) => set({ neverSavePasswords: settings.neverSavePasswords.filter((d) => d !== item.key) })}
                />
              )}
              {!page && section === 'general' && (
                <>
                  <Row
                    label="Default browser"
                    hint={
                      defaultBrowser
                        ? 'Links you open in other apps open in Zepper.'
                        : 'Open links from other apps (Mail, Slack, Notes…) in Zepper.'
                    }
                  >
                    {defaultBrowser ? (
                      <span className="settings-status">Zepper is your default browser</span>
                    ) : (
                      <button className="panel-button" onClick={() => zepper.send({ type: 'app.makeDefaultBrowser' })}>
                        Make Default
                      </button>
                    )}
                  </Row>
                  <Row
                    label="Apple Intelligence features"
                    hint={
                      settings.aiFeatures && !intelligence.ai && !intelligence.translation
                        ? (intelligence.reason ?? 'Not available on this Mac.')
                        : 'Page summaries and questions, translation, history search by meaning and Tidy Tabs. Everything runs on your Mac.'
                    }
                  >
                    <Toggle checked={settings.aiFeatures} onChange={(aiFeatures) => set({ aiFeatures })} />
                  </Row>
                  <Row
                    label="Offer to translate pages"
                    hint="When a page isn’t in your language, a translate button appears in the address bar. Translation runs on your Mac."
                  >
                    <Toggle
                      checked={settings.aiFeatures && settings.offerTranslation}
                      disabled={!settings.aiFeatures}
                      onChange={(offerTranslation) => set({ offerTranslation })}
                    />
                  </Row>
                  <Row label="Translate into" hint="Your Mac’s language, or another one.">
                    <select value={settings.translateTo} onChange={(e) => set({ translateTo: e.target.value })}>
                      <option value="">My Mac’s language</option>
                      {TRANSLATION_LANGUAGES.map((code) => (
                        <option key={code} value={code}>
                          {new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code)}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row
                    label="New windows open"
                    hint="⌘N. With your spaces: every space, with its sign-ins and Essentials, starting on the one you're in (pinned and open tabs stay in your main window)."
                  >
                    <Segmented
                      value={settings.newWindowSpace}
                      options={[
                        ['current', 'With your spaces'],
                        ['empty', 'Empty']
                      ]}
                      onChange={(newWindowSpace) => set({ newWindowSpace })}
                    />
                  </Row>
                  <UpdatesRow update={update} />
                  <Row
                    label="Download updates automatically"
                    hint="Zepper looks for a new version every few hours and gets it ready; an Update button then appears in the sidebar."
                  >
                    <Toggle
                      checked={settings.autoUpdate}
                      disabled={update.state === 'off'}
                      onChange={(autoUpdate) => set({ autoUpdate })}
                    />
                  </Row>
                  <Row
                    label="Import from another browser"
                    hint="Open tabs (Arc’s spaces too), history and passwords from Chrome, Arc, Brave, Edge, Firefox, Safari and others."
                  >
                    <button className="panel-button" onClick={() => zepper.send({ type: 'ui.openOnboarding', step: 'import' })}>
                      Import…
                    </button>
                  </Row>
                  <Row label="Welcome and setup" hint="Import from other browsers, pick a look and see what Zepper can do.">
                    <button className="panel-button" onClick={() => zepper.send({ type: 'ui.openOnboarding' })}>
                      Show Again
                    </button>
                  </Row>
                </>
              )}

              {!page && section === 'appearance' && (
                <>
                  <Row label="Theme" hint="Websites follow this too.">
                    <Segmented
                      value={settings.colorScheme}
                      options={[
                        ['system', 'Auto'],
                        ['light', 'Light'],
                        ['dark', 'Dark']
                      ]}
                      onChange={(colorScheme) => set({ colorScheme })}
                    />
                  </Row>
                  <Row label="App icon" hint="Auto follows your Mac’s icon style (System Settings › Appearance), like your other apps.">
                    <Segmented
                      value={settings.appIcon}
                      options={[
                        ['auto', 'Auto'],
                        ['light', 'Light'],
                        ['dark', 'Dark']
                      ]}
                      onChange={(appIcon) => set({ appIcon })}
                    />
                  </Row>
                  <Row label="Sidebar position">
                    <Segmented
                      value={settings.sidebarPosition}
                      options={[
                        ['left', 'Left'],
                        ['right', 'Right']
                      ]}
                      onChange={(sidebarPosition) => set({ sidebarPosition })}
                    />
                  </Row>
                  <Row label="Tab density">
                    <Segmented
                      value={settings.density}
                      options={[
                        ['comfortable', 'Comfortable'],
                        ['compact', 'Compact']
                      ]}
                      onChange={(density) => set({ density })}
                    />
                  </Row>
                  <Row
                    label="Transparency"
                    hint={settings.transparency === 0 ? 'Solid window' : `${Math.round(settings.transparency * 100)}% see-through`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.transparency}
                      onChange={(e) => set({ transparency: Number(e.target.value) })}
                    />
                  </Row>
                  <Row label="Content gap" hint={`${settings.contentGap}px around the page`}>
                    <input
                      type="range"
                      min={0}
                      max={16}
                      step={1}
                      value={settings.contentGap}
                      onChange={(e) => set({ contentGap: Number(e.target.value) })}
                    />
                  </Row>
                  <Row label="Corner radius" hint={`${settings.cornerRadius}px`}>
                    <input
                      type="range"
                      min={0}
                      max={18}
                      step={1}
                      value={settings.cornerRadius}
                      onChange={(e) => set({ cornerRadius: Number(e.target.value) })}
                    />
                  </Row>
                  <Row label="Essentials glow" hint="Tint the active Essential with its icon’s colour.">
                    <Toggle checked={settings.essentialsGlow} onChange={(essentialsGlow) => set({ essentialsGlow })} />
                  </Row>
                  <Row label="Reduce motion" hint="Turn off animations.">
                    <Toggle checked={settings.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
                  </Row>
                </>
              )}

              {!page && section === 'tabs' && (
                <>
                  <Row label="New tabs open at">
                    <Segmented
                      value={settings.newTabPosition}
                      options={[
                        ['top', 'Top'],
                        ['bottom', 'Bottom']
                      ]}
                      onChange={(newTabPosition) => set({ newTabPosition })}
                    />
                  </Row>
                  <Row
                    label="Memory Saver"
                    hint="Tabs you haven’t looked at for a while give back their memory and reload when you open them. Time your Mac is asleep or locked doesn’t count. Tabs you keep coming back to, pinned tabs, and tabs playing sound, in a call or with something typed stay."
                  >
                    <Toggle checked={settings.memorySaver} onChange={(memorySaver) => set({ memorySaver })} />
                  </Row>
                  <Row label="How soon" hint={MEMORY_SAVER_HINTS[settings.memorySaverMode]}>
                    <Segmented
                      value={settings.memorySaverMode}
                      options={[
                        ['moderate', 'Moderate'],
                        ['balanced', 'Balanced'],
                        ['maximum', 'Maximum']
                      ]}
                      onChange={(memorySaverMode) => set({ memorySaverMode })}
                    />
                  </Row>
                  <Row label="Closing a pinned tab" hint="What ⌘W does on pinned tabs and Essentials.">
                    <select
                      value={settings.pinnedCloseBehavior}
                      onChange={(e) => set({ pinnedCloseBehavior: e.target.value as PinnedCloseBehavior })}
                    >
                      {Object.entries(PINNED_CLOSE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Reopen tabs from last time" hint="Your open tabs come back when Zepper starts. Pinned tabs always do.">
                    <Toggle checked={settings.restoreTabs} onChange={(restoreTabs) => set({ restoreTabs })} />
                  </Row>
                  <Row label="Keep Essentials" hint="Essentials stay between launches. Turn off to start each launch with none.">
                    <Toggle checked={settings.keepEssentials} onChange={(keepEssentials) => set({ keepEssentials })} />
                  </Row>
                  <Row
                    label="Suggest closing tabs you haven’t opened in"
                    hint="A card above your tabs offers to close them or put them in a folder."
                  >
                    <select value={settings.staleTabDays} onChange={(e) => set({ staleTabDays: Number(e.target.value) })}>
                      <option value={1}>A day</option>
                      <option value={3}>3 days</option>
                      <option value={7}>A week</option>
                      <option value={14}>Two weeks</option>
                      <option value={0}>Never</option>
                    </select>
                  </Row>
                  <Row label="After closing a tab, go to the most recently used tab" hint="Otherwise the tab next to it.">
                    <Toggle checked={settings.closeSelectsRecent} onChange={(closeSelectsRecent) => set({ closeSelectsRecent })} />
                  </Row>
                  <Row
                    label="Tidy button"
                    hint={
                      tidy.kind === 'ai'
                        ? 'Groups related tabs into folders with Apple Intelligence, on this Mac.'
                        : `Groups tabs from the same site into folders. ${tidy.reason}`
                    }
                  >
                    <Toggle checked={settings.showTidy} onChange={(showTidy) => set({ showTidy })} />
                  </Row>
                </>
              )}

              {!page && section === 'media' && (
                <>
                  <Row label="Now playing in the sidebar" hint="Controls for media playing in a tab you’re not looking at.">
                    <Toggle checked={settings.showMediaCard} onChange={(showMediaCard) => set({ showMediaCard })} />
                  </Row>
                  <Row label="When another tab starts playing" hint="What to do with media that’s already playing elsewhere.">
                    <Segmented
                      value={settings.otherMedia}
                      options={[
                        ['nothing', 'Keep playing'],
                        ['offer', 'Offer to pause'],
                        ['pause', 'Pause others']
                      ]}
                      onChange={(otherMedia) => set({ otherMedia })}
                    />
                  </Row>
                  <Row
                    label="Picture-in-picture when you leave a video"
                    hint="A playing video floats in a mini player until you come back."
                  >
                    <Toggle checked={settings.autoPictureInPicture} onChange={(autoPictureInPicture) => set({ autoPictureInPicture })} />
                  </Row>
                  <Row label="Play protected content (Google Widevine)" hint={widevineHint(widevine)}>
                    {settings.widevine && widevine.state === 'restart' && (
                      <button className="settings-inline-button" onClick={() => zepper.send({ type: 'app.relaunch' })}>
                        Restart now
                      </button>
                    )}
                    <Toggle checked={settings.widevine && widevine.state !== 'unavailable'} onChange={(on) => set({ widevine: on })} />
                  </Row>
                  {!settings.widevine && (
                    <Row label="Ask when a site needs it" hint="Offer to turn Widevine on when a page asks for it.">
                      <Toggle checked={settings.widevinePrompt} onChange={(widevinePrompt) => set({ widevinePrompt })} />
                    </Row>
                  )}
                  <Row label="Picture-in-picture size" hint="Relative to your screen. Resize the player to fine-tune it.">
                    <Segmented
                      value={settings.pipSize}
                      options={[
                        ['small', 'Small'],
                        ['medium', 'Medium'],
                        ['large', 'Large']
                      ]}
                      onChange={(pipSize) => set({ pipSize })}
                    />
                  </Row>
                </>
              )}

              {!page && section === 'search' && (
                <>
                  <Row label="Search engine">
                    <select value={settings.searchEngine} onChange={(e) => set({ searchEngine: e.target.value as SearchEngineId })}>
                      {Object.entries(SEARCH_ENGINES).map(([id, engine]) => (
                        <option key={id} value={id}>
                          {engine.name}
                        </option>
                      ))}
                    </select>
                  </Row>
                  <Row label="Search suggestions" hint="Ask the search engine for suggestions while you type.">
                    <Toggle checked={settings.searchSuggestions} onChange={(searchSuggestions) => set({ searchSuggestions })} />
                  </Row>
                  <Row label="DuckDuckGo bangs" hint="Type !yt cats or !gh zepper to go straight to the site's search, without a detour.">
                    <Toggle checked={settings.bangs} onChange={(bangs) => set({ bangs })} />
                  </Row>
                  <Row label="Recently visited sites" hint="An empty command bar lists sites you visited lately.">
                    <Toggle checked={settings.paletteRecents} onChange={(paletteRecents) => set({ paletteRecents })} />
                  </Row>
                </>
              )}

              {!page && section === 'downloads' && (
                <>
                  <Row label="Save downloads to" hint={settings.downloadPath || 'Downloads folder'}>
                    <button className="panel-button" onClick={() => zepper.send({ type: 'settings.chooseDownloadFolder' })}>
                      Change…
                    </button>
                    {settings.downloadPath && (
                      <button className="panel-button" onClick={() => set({ downloadPath: '' })}>
                        Reset
                      </button>
                    )}
                  </Row>
                  <Row label="Ask where to save each file">
                    <Toggle checked={settings.downloadAsk} onChange={(downloadAsk) => set({ downloadAsk })} />
                  </Row>
                  <Row label="Your downloads" hint="Progress, finished files and Show in Finder. ⌥⌘L">
                    <button className="panel-button" onClick={() => zepper.send({ type: 'ui.downloads' })}>
                      Show Downloads
                    </button>
                  </Row>
                </>
              )}

              {!page && section === 'gestures' && (
                <>
                  <Row label="Swipe between spaces" hint="Two-finger swipe on the sidebar.">
                    <Toggle checked={settings.swipeBetweenSpaces} onChange={(swipeBetweenSpaces) => set({ swipeBetweenSpaces })} />
                  </Row>
                  <Row label="Swipe to go back and forward" hint="Two-finger swipe on a page.">
                    <Toggle checked={settings.swipeToNavigate} onChange={(swipeToNavigate) => set({ swipeToNavigate })} />
                  </Row>
                  <Row label="Wrap around spaces" hint="Next space after the last one is the first.">
                    <Toggle checked={settings.wrapSpaces} onChange={(wrapSpaces) => set({ wrapSpaces })} />
                  </Row>
                  <Row label="Reveal sidebar on hover in compact mode">
                    <Toggle checked={settings.compactRevealOnHover} onChange={(compactRevealOnHover) => set({ compactRevealOnHover })} />
                  </Row>
                </>
              )}

              {!page && section === 'privacy' && (
                <>
                  <Row
                    label="Block ads and trackers"
                    hint="uBlock Origin’s filter lists, built in. Turn protections off for one site from the lock icon."
                  >
                    <Toggle checked={settings.adblock} onChange={(adblock) => set({ adblock })} />
                  </Row>
                  <SiteListLink
                    label="Sites with protections off"
                    hint="Sites you turned protections off for, from the lock icon. Turn them back on here."
                    count={protectionsOff(settings).length}
                    onOpen={() => openPage('protectionsOff')}
                  />
                  <Row label="Hide cookie banners" hint="Hides cookie consent pop-ups and other annoyances, using uBlock Origin’s lists.">
                    <Toggle checked={settings.hideCookieBanners} onChange={(hideCookieBanners) => set({ hideCookieBanners })} />
                  </Row>
                  <Row
                    label="Block fingerprinting"
                    hint="Adds tiny per-site noise to canvas, WebGL and audio readouts and hides local network addresses, so sites can’t recognise you."
                  >
                    <Toggle checked={settings.blockFingerprinting} onChange={(blockFingerprinting) => set({ blockFingerprinting })} />
                  </Row>
                  <Row
                    label="Block cross-site cookies"
                    hint="Embedded content from other sites can’t set or read cookies, so it can’t follow you around. Sign-in frames still work."
                  >
                    <Toggle checked={settings.blockCrossSiteCookies} onChange={(blockCrossSiteCookies) => set({ blockCrossSiteCookies })} />
                  </Row>
                  <Row
                    label="Upgrade connections to HTTPS"
                    hint="Loads sites over HTTPS when they support it, and falls back when they don’t."
                  >
                    <Toggle checked={settings.httpsUpgrade} onChange={(httpsUpgrade) => set({ httpsUpgrade })} />
                  </Row>
                  <Row
                    label="Remove trackers from links"
                    hint="Strips click identifiers like fbclid and gclid, and opens Google AMP pages on the real site."
                  >
                    <Toggle checked={settings.cleanLinks} onChange={(cleanLinks) => set({ cleanLinks })} />
                  </Row>
                  <Row
                    label="Secure DNS"
                    hint="Encrypts site lookups, so your network can’t see or change where you go. Automatic uses your DNS provider’s encryption when it offers it."
                  >
                    <select value={settings.secureDns} onChange={(e) => set({ secureDns: e.target.value as SecureDns })}>
                      <option value="automatic">Automatic</option>
                      <option value="cloudflare">Cloudflare</option>
                      <option value="quad9">Quad9</option>
                      <option value="google">Google</option>
                      <option value="off">Off</option>
                    </select>
                  </Row>
                  <Row
                    label="Block pop-up floods"
                    hint="Windows you open are never blocked, and sites can open a couple on their own; one that keeps opening them is stopped. Change it for a site from its lock icon."
                  >
                    <Toggle checked={settings.blockPopups} onChange={(blockPopups) => set({ blockPopups })} />
                  </Row>
                  <SiteListLink
                    label="Site permissions"
                    hint={`What you’ve allowed or blocked for each site${profileScope ? ` in ${listNames(profileScope)}` : ''} (camera, microphone, location, notifications, pop-ups).`}
                    count={sitePermissions.length}
                    onOpen={() => openPage('sitePermissions')}
                  />
                  <SystemAccessRows access={systemAccess} />
                  <Row label="Ask sites not to sell or share my data" hint="Sends Global Privacy Control and Do Not Track.">
                    <Toggle checked={settings.globalPrivacyControl} onChange={(globalPrivacyControl) => set({ globalPrivacyControl })} />
                  </Row>
                  <Row label="Clear history when Zepper quits" hint="Every space’s. Your tabs, spaces and sign-ins stay.">
                    <Toggle checked={settings.clearHistoryOnQuit} onChange={(clearHistoryOnQuit) => set({ clearHistoryOnQuit })} />
                  </Row>
                  <ClearBrowsingData />
                  <Row label="Browsing history" hint="Search it, open pages again or delete them. ⌘Y">
                    <button className="panel-button" onClick={() => zepper.send({ type: 'ui.openHistory' })}>
                      Show History
                    </button>
                  </Row>
                  <Row label="Identify as" hint="The browser websites think you’re using. Google sign-in needs Chrome or Edge.">
                    <select value={settings.userAgent} onChange={(e) => set({ userAgent: e.target.value as UserAgentChoice })}>
                      {Object.entries(USER_AGENT_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Row>
                  {settings.userAgent === 'custom' && (
                    <CustomUserAgent value={settings.customUserAgent} onChange={(customUserAgent) => set({ customUserAgent })} />
                  )}
                  <Row
                    label="Google sign-in compatibility"
                    hint="Lets Google’s sign-in page accept Zepper. Only affects accounts.google.com."
                  >
                    <Toggle checked={settings.googleSignInCompat} onChange={(googleSignInCompat) => set({ googleSignInCompat })} />
                  </Row>
                </>
              )}

              {!page && section === 'passwords' && (
                <PasswordsSettings settings={settings} scope={profileScope} onOpenNeverSaved={() => openPage('neverSaved')} />
              )}

              {!page && section === 'extensions' && <ExtensionsSettings settings={settings} />}

              {!page && section === 'shortcuts' && (
                <>
                  <div className="shortcut-list">
                    {SHORTCUTS.map(([label, keys]) => (
                      <div key={label} className="shortcut-row">
                        <span>{label}</span>
                        <kbd>{isMac ? keys : keys.replace(/⌘/g, 'Ctrl+')}</kbd>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </motion.div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Settings › Privacy: clear history, cookies, cache or the downloads list in one go. */
function ClearBrowsingData(): React.JSX.Element {
  const [range, setRange] = useState('hour')
  const [what, setWhat] = useState({ history: true, cookies: false, cache: true, downloads: false })
  const [confirming, setConfirming] = useState(false)
  const nothing = !Object.values(what).some(Boolean)
  const toggle = (key: keyof typeof what): void => setWhat((w) => ({ ...w, [key]: !w[key] }))
  const clear = (): void => {
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    const now = new Date()
    const since =
      range === 'hour'
        ? now.getTime() - 3_600_000
        : range === 'day'
          ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
          : range === 'week'
            ? now.getTime() - 7 * 86_400_000
            : 0
    zepper.send({ type: 'data.clear', since, ...what })
    setConfirming(false)
  }
  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-text">
        <div className="settings-row-label">Clear browsing data</div>
        <div className="settings-row-hint">
          Cookies, site data and cached files are cleared from every space, for all time. Clearing cookies signs you out of sites.
        </div>
      </div>
      <div className="clear-data">
        <label className="clear-data-option">
          <input type="checkbox" checked={what.history} onChange={() => toggle('history')} />
          History from
          <select value={range} onChange={(e) => setRange(e.target.value)} disabled={!what.history}>
            <option value="hour">the last hour</option>
            <option value="day">today</option>
            <option value="week">the last 7 days</option>
            <option value="all">all time</option>
          </select>
        </label>
        <label className="clear-data-option">
          <input type="checkbox" checked={what.cookies} onChange={() => toggle('cookies')} />
          Cookies and site data
        </label>
        <label className="clear-data-option">
          <input type="checkbox" checked={what.cache} onChange={() => toggle('cache')} />
          Cached images and files
        </label>
        <label className="clear-data-option">
          <input type="checkbox" checked={what.downloads} onChange={() => toggle('downloads')} />
          Downloads list
        </label>
        <button className={cx('panel-button', confirming && 'danger')} disabled={nothing} onClick={clear}>
          {confirming ? 'Click again to clear' : 'Clear Data'}
        </button>
      </div>
    </div>
  )
}

/** Settings › General: where Zepper's update is at, and what to do about it. */
function UpdatesRow({ update }: { update: UpdateStatus }): React.JSX.Element {
  const check = (): void => zepper.send({ type: 'app.checkForUpdates' })
  const restart = (): void => zepper.send({ type: 'app.restartToUpdate' })
  const [hint, control]: [string, React.ReactNode] = (() => {
    switch (update.state) {
      case 'off':
        return ['Updates are off in development builds.', null]
      case 'checking':
        return ['Checking for updates…', null]
      case 'downloading':
        return [`Downloading Zepper ${update.version}… ${Math.round(update.progress * 100)}%`, null]
      case 'ready':
        return [
          `Zepper ${update.version} is ready. Restart to update (quitting installs it too).`,
          <button key="restart" className="panel-button primary" onClick={restart}>
            Restart to Update
          </button>
        ]
      case 'manual':
        return [
          `Zepper ${update.version} is out. Zepper can’t update itself where it’s installed: download it and move it to Applications.`,
          <button key="download" className="panel-button primary" onClick={restart}>
            Download
          </button>
        ]
      case 'error':
        return [update.message + '.', <CheckButton key="check" onClick={check} />]
      case 'current':
        return ['Zepper is up to date.', <CheckButton key="check" onClick={check} />]
      default:
        return ['Zepper checks for new versions and downloads them in the background.', <CheckButton key="check" onClick={check} />]
    }
  })()
  return (
    <Row label="Updates" hint={hint}>
      {control}
    </Row>
  )
}

function CheckButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button className="panel-button" onClick={onClick}>
      Check Now
    </button>
  )
}

/** What's allowed and blocked for a site, in a line ("Camera, Microphone allowed · Notifications blocked"). */
function permissionSummary(site: SiteDecisions): string {
  const named = (state: 'allow' | 'block'): string[] => site.decisions.filter((d) => d.state === state).map((d) => d.label)
  const allowed = named('allow')
  const blocked = named('block')
  return [allowed.length ? `${allowed.join(', ')} allowed` : '', blocked.length ? `${blocked.join(', ')} blocked` : '']
    .filter(Boolean)
    .join(' · ')
}

/** Sites with protections off: every one (from the lock icon's main switch), or some. */
function protectionsOff(settings: Settings): SiteListItem[] {
  return [...new Set([...settings.adblockAllowlist, ...Object.keys(settings.siteExceptions)])].map((domain) => ({
    key: domain,
    site: domain,
    detail: settings.adblockAllowlist.includes(domain)
      ? 'All protections off'
      : `Off: ${(settings.siteExceptions[domain] ?? []).map((key) => PROTECTIONS.find((p) => p.key === key)?.label).join(', ')}`
  }))
}

const ACCESS_LABELS: [keyof SystemAccess, string, string][] = [
  ['camera', 'Camera', 'camera'],
  ['microphone', 'Microphone', 'microphone'],
  ['screen', 'Screen & System Audio Recording', 'screen'],
  ['location', 'Location Services', 'location']
]

function accessHint(state: AccessState): string {
  if (state === 'allowed') return 'Allowed. Sites still ask you first.'
  if (state === 'denied') return 'Turned off for Zepper in macOS. Turn it on in System Settings, then reload the page.'
  return 'macOS asks the first time a site you’ve allowed uses it.'
}

/** Settings › Privacy: what macOS lets Zepper use, with a way to change it there. */
function SystemAccessRows({ access }: { access: SystemAccess }): React.JSX.Element {
  return (
    <>
      {ACCESS_LABELS.map(([key, label]) => (
        <Row key={key} label={`macOS: ${label}`} hint={accessHint(access[key])}>
          <button
            className={cx('panel-button', access[key] === 'denied' && 'primary')}
            onClick={() => zepper.send({ type: 'app.openMediaPrivacySettings', kind: key })}
          >
            Open Settings
          </button>
        </Row>
      ))}
    </>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** The custom user agent field; saved when you leave it or press Return, not on every keystroke. */
function CustomUserAgent({ value, onChange }: { value: string; onChange: (value: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    if (draft.trim() !== value) onChange(draft.trim())
  }
  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-text">
        <div className="settings-row-label">Custom user agent</div>
        <div className="settings-row-hint">Takes effect as pages load. Leave empty to use Chrome’s.</div>
      </div>
      <input
        className="settings-input"
        value={draft}
        spellCheck={false}
        placeholder="Mozilla/5.0 (Macintosh; …)"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: [T, string][]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="segmented">
      {options.map(([option, label]) => (
        <button key={option} className={cx(value === option && 'selected')} onClick={() => onChange(option)}>
          {label}
        </button>
      ))}
    </div>
  )
}
