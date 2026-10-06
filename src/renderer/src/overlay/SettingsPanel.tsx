import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import {
  PINNED_CLOSE_LABELS,
  PROTECTIONS,
  SEARCH_ENGINES,
  USER_AGENT_LABELS,
  type PinnedCloseBehavior,
  type SearchEngineId,
  type SecureDns,
  type Settings,
  type UserAgentChoice
} from '@shared/settings'
import type { IntelligenceStatus, Snapshot, WidevineStatus } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose } from '../icons'
import { cx, isMac } from '../util'
import { ExtensionsSettings } from './ExtensionsSettings'
import { Toggle } from './Toggle'

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

type Section = 'general' | 'appearance' | 'tabs' | 'media' | 'search' | 'downloads' | 'gestures' | 'privacy' | 'extensions' | 'shortcuts'

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: '⚙️' },
  { id: 'appearance', label: 'Appearance', icon: '🎨' },
  { id: 'tabs', label: 'Tabs', icon: '🗂️' },
  { id: 'media', label: 'Media', icon: '🎵' },
  { id: 'search', label: 'Search', icon: '🔎' },
  { id: 'downloads', label: 'Downloads', icon: '⬇️' },
  { id: 'gestures', label: 'Spaces & Gestures', icon: '👆' },
  { id: 'privacy', label: 'Privacy', icon: '🛡️' },
  { id: 'extensions', label: 'Extensions', icon: '🧩' },
  { id: 'shortcuts', label: 'Shortcuts', icon: '⌨️' }
]

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
export function SettingsPanel({ settings, widevine, tidy, defaultBrowser, intelligence, onClose }: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<Section>('general')
  const set = (patch: Partial<Settings>): void => zepper.send({ type: 'settings.update', patch })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
            <button key={s.id} className={cx('settings-nav-item', section === s.id && 'active')} onClick={() => setSection(s.id)}>
              <span className="settings-nav-icon">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="settings-close" title="Close (Esc)" onClick={onClose}>
            <IconClose size={14} />
          </button>
          <motion.div
            key={section}
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
          >
            {section === 'general' && (
              <>
                <h2>General</h2>
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
                  hint="⌘N. On this space: the same space and sign-ins in a window of its own, without its tabs."
                >
                  <Segmented
                    value={settings.newWindowSpace}
                    options={[
                      ['current', 'On this space'],
                      ['empty', 'Empty']
                    ]}
                    onChange={(newWindowSpace) => set({ newWindowSpace })}
                  />
                </Row>
              </>
            )}

            {section === 'appearance' && (
              <>
                <h2>Appearance</h2>
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
                <Row label="App icon" hint="Auto follows your Mac’s appearance.">
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

            {section === 'tabs' && (
              <>
                <h2>Tabs</h2>
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

            {section === 'media' && (
              <>
                <h2>Media</h2>
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
                <Row label="Picture-in-picture when you leave a video" hint="A playing video floats in a mini player until you come back.">
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

            {section === 'search' && (
              <>
                <h2>Search</h2>
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

            {section === 'downloads' && (
              <>
                <h2>Downloads</h2>
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

            {section === 'gestures' && (
              <>
                <h2>Spaces &amp; Gestures</h2>
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

            {section === 'privacy' && (
              <>
                <h2>Privacy</h2>
                <Row
                  label="Block ads and trackers"
                  hint="uBlock Origin’s filter lists, built in. Turn protections off for one site from the lock icon."
                >
                  <Toggle checked={settings.adblock} onChange={(adblock) => set({ adblock })} />
                </Row>
                {(settings.adblockAllowlist.length > 0 || Object.keys(settings.siteExceptions).length > 0) && (
                  <div className="settings-row settings-row-stacked">
                    <div className="settings-row-text">
                      <div className="settings-row-label">Sites with protections off</div>
                      <div className="settings-row-hint">Change them from the lock icon on the site, or turn them all back on here.</div>
                    </div>
                    <div className="site-chips">
                      {[...new Set([...settings.adblockAllowlist, ...Object.keys(settings.siteExceptions)])].map((domain) => {
                        const off = settings.adblockAllowlist.includes(domain)
                          ? 'all'
                          : (settings.siteExceptions[domain] ?? []).map((key) => PROTECTIONS.find((p) => p.key === key)?.label).join(', ')
                        return (
                          <span key={domain} className="site-chip" title={`Off: ${off}`}>
                            {domain}
                            <span className="site-chip-detail">{off === 'all' ? 'all off' : off}</span>
                            <button
                              title={`Turn protections back on for ${domain}`}
                              onClick={() => zepper.send({ type: 'site.resetProtections', domain })}
                            >
                              <IconClose size={9} />
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                )}
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
                <Row label="Ask sites not to sell or share my data" hint="Sends Global Privacy Control and Do Not Track.">
                  <Toggle checked={settings.globalPrivacyControl} onChange={(globalPrivacyControl) => set({ globalPrivacyControl })} />
                </Row>
                <Row label="Clear history when Zepper quits" hint="Your tabs, spaces and sign-ins stay.">
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

            {section === 'extensions' && <ExtensionsSettings settings={settings} />}

            {section === 'shortcuts' && (
              <>
                <h2>Keyboard Shortcuts</h2>
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
