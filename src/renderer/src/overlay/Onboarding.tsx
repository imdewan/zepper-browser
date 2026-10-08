import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Cookie, Fingerprint, Globe, Languages, Link2, Lock, ScanSearch, ShieldCheck, Sparkles, Wand2, type LucideIcon } from 'lucide-react'
import type { Settings } from '@shared/settings'
import { THEME_PRESETS, themeBackground } from '@shared/theme'
import type { ImportKind, ImportSource, Snapshot } from '@shared/types'
import logo from '../assets/logo.png'
import { zepper } from '../bridge'
import { IconCheck } from '../icons'
import { cx, isMac } from '../util'
import { Toggle } from './Toggle'

/**
 * The first-launch welcome and setup: what Zepper is, bringing history and passwords over from
 * other browsers, choosing a look, the privacy protections, on-device intelligence, and becoming
 * the default browser. Every step can be skipped; Settings › General shows it again.
 */

const STEPS = ['welcome', 'import', 'look', 'privacy', 'intelligence', 'ready'] as const
type Step = (typeof STEPS)[number]

/** Steps slide in the direction you're going; `custom` reaches the leaving step too. */
const SLIDE = {
  enter: (direction: number) => ({ opacity: 0, x: 24 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: -24 * direction, transition: { duration: 0.12 } })
}

export function Onboarding({
  snapshot,
  startAt,
  onClose
}: {
  snapshot: Snapshot
  /** Open at a step (Settings opens it at importing from other browsers). */
  startAt?: Step
  onClose: () => void
}): React.JSX.Element {
  const [index, setIndex] = useState(() => Math.max(0, STEPS.indexOf(startAt ?? 'welcome')))
  const [direction, setDirection] = useState(1)
  const step: Step = STEPS[index]
  const set = (patch: Partial<Settings>): void => zepper.send({ type: 'settings.update', patch })

  const finish = (): void => {
    set({ onboarded: true })
    onClose()
  }
  const go = (delta: number): void => {
    setDirection(delta)
    setIndex((i) => Math.max(0, Math.min(STEPS.length - 1, i + delta)))
  }

  // Escape skips the rest, like "Skip setup".
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      zepper.send({ type: 'settings.update', patch: { onboarded: true } })
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <motion.div
      className="settings-backdrop ob-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
    >
      <motion.div
        className="ob"
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
        transition={{ type: 'spring', bounce: 0.12, duration: 0.45 }}
      >
        <div className="ob-body">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={step}
              className="ob-step"
              custom={direction}
              variants={SLIDE}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: 'spring', bounce: 0, duration: 0.35 }}
            >
              {step === 'welcome' && <Welcome />}
              {step === 'import' && <ImportStep />}
              {step === 'look' && <LookStep snapshot={snapshot} />}
              {step === 'privacy' && <PrivacyStep settings={snapshot.settings} />}
              {step === 'intelligence' && <IntelligenceStep snapshot={snapshot} />}
              {step === 'ready' && <ReadyStep snapshot={snapshot} />}
            </motion.div>
          </AnimatePresence>
        </div>

        <footer className="ob-footer">
          <div className="ob-dots" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s} className={cx('ob-dot', i === index && 'current', i < index && 'done')} />
            ))}
          </div>
          <div className="ob-buttons">
            {index === 0 ? (
              <button className="ob-quiet" onClick={finish}>
                Skip setup
              </button>
            ) : (
              <button className="ob-secondary" onClick={() => go(-1)}>
                Back
              </button>
            )}
            {index < STEPS.length - 1 ? (
              <button className="ob-primary" onClick={() => go(1)}>
                {index === 0 ? 'Get started' : 'Continue'}
              </button>
            ) : (
              <button className="ob-primary" onClick={finish}>
                Start browsing
              </button>
            )}
          </div>
        </footer>
      </motion.div>
    </motion.div>
  )
}

function Heading({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="ob-heading">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  )
}

function Welcome(): React.JSX.Element {
  return (
    <div className="ob-welcome">
      <img className="ob-logo" src={logo} alt="" draggable={false} />
      <Heading title="Welcome to Zepper">
        Your new browser for the Mac: spaces for each part of your life, a sidebar built for tabs, and privacy that’s on from the start.
      </Heading>
      <p className="ob-note">This takes about a minute. You can change everything later in Settings.</p>
    </div>
  )
}

type Pick = { history: boolean; passwords: boolean; tabs: boolean; profile: string }

const KIND_LABELS: Record<ImportKind, string> = { tabs: 'Open tabs', history: 'History', passwords: 'Passwords' }
/** Tabs first (quick), passwords last (macOS asks about the Keychain for those). */
const KIND_ORDER: ImportKind[] = ['tabs', 'history', 'passwords']

/** Open tabs, history and passwords from the browsers on this Mac. */
function ImportStep(): React.JSX.Element {
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [results, setResults] = useState<Record<string, { text: string; error?: boolean }>>({})
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void zepper.vault({ type: 'sources' }).then((list) => {
      setSources(list)
      setPicks(
        Object.fromEntries(
          list.map((s) => [
            s.id,
            {
              tabs: s.kinds.includes('tabs'),
              history: s.kinds.includes('history'),
              passwords: s.kinds.includes('passwords'),
              profile: s.profiles[0]?.dir ?? '.'
            }
          ])
        )
      )
    })
  }, [])

  const chosen = (pick: Pick | undefined): boolean => !!pick && (pick.tabs || pick.history || pick.passwords)
  const runnable = (sources ?? []).filter((s) => !s.blocked && chosen(picks[s.id]) && !(results[s.id] && !results[s.id].error))

  const run = async (source: ImportSource): Promise<void> => {
    const pick = picks[source.id]
    if (!chosen(pick)) return
    setBusy(source.id)
    const parts: string[] = []
    const errors: string[] = []
    for (const kind of KIND_ORDER) {
      if (!pick[kind] || !source.kinds.includes(kind)) continue
      if (kind === 'tabs') {
        const reply = await zepper.vault({ type: 'importTabs', source: source.id, profile: pick.profile })
        if ('error' in reply) errors.push(reply.error)
        else
          parts.push(
            `${reply.tabs.toLocaleString()} tab${reply.tabs === 1 ? '' : 's'}` +
              (reply.spaces ? ` in ${reply.spaces} new space${reply.spaces === 1 ? '' : 's'}` : '')
          )
      } else if (kind === 'history') {
        const reply = await zepper.vault({ type: 'importHistory', source: source.id, profile: pick.profile })
        if ('error' in reply) errors.push(reply.error)
        else parts.push(`${(reply.added + reply.updated).toLocaleString()} pages`)
      } else {
        // macOS asks to allow access to the browser's key in the Keychain here.
        const reply = await zepper.vault({ type: 'importBrowser', source: source.id, profile: pick.profile })
        if ('error' in reply) errors.push(reply.error)
        else parts.push(`${reply.added.toLocaleString()} password${reply.added === 1 ? '' : 's'}`)
      }
    }
    const done = parts.length
      ? `Imported ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' and ' : ''}${parts[parts.length - 1]}.`
      : ''
    setResults((r) => ({
      ...r,
      [source.id]: { text: [done, ...errors].filter(Boolean).join(' '), error: errors.length > 0 && !parts.length }
    }))
    setBusy(null)
  }

  const runAll = async (): Promise<void> => {
    for (const source of runnable) await run(source)
  }

  const fromFile = async (): Promise<void> => {
    setBusy('file')
    const reply = await zepper.vault({ type: 'importFile' })
    setBusy(null)
    if (!reply) return
    setResults((r) => ({
      ...r,
      file: 'error' in reply ? { text: reply.error, error: true } : { text: `Imported ${reply.added.toLocaleString()} passwords.` }
    }))
  }

  const toggle = (id: string, key: ImportKind): void => setPicks((p) => ({ ...p, [id]: { ...p[id], [key]: !p[id][key] } }))

  return (
    <div>
      <div className="ob-heading-row">
        <Heading title="Bring your things">
          Your open tabs, history and passwords from the browsers you use now. Everything stays on this Mac.
        </Heading>
        {runnable.length > 1 && (
          <button className="ob-secondary small" disabled={busy !== null} onClick={() => void runAll()}>
            {busy && busy !== 'file' ? 'Importing…' : 'Import All'}
          </button>
        )}
      </div>
      <div className="ob-sources">
        {sources === null && <p className="ob-note">Looking for browsers…</p>}
        {sources?.length === 0 && <p className="ob-note">No other browsers found on this Mac.</p>}
        {sources?.map((source) => {
          const pick = picks[source.id]
          const result = results[source.id]
          return (
            <div key={source.id} className="ob-source">
              <div className="ob-source-main">
                <span className="ob-source-name">{source.name}</span>
                {source.blocked ? (
                  <span className="ob-source-detail">Needs Full Disk Access</span>
                ) : result ? (
                  <span className={cx('ob-source-detail', result.error ? 'error' : 'done')}>{result.text}</span>
                ) : (
                  <span className="ob-source-kinds">
                    {KIND_ORDER.filter((kind) => source.kinds.includes(kind)).map((kind) => (
                      <label key={kind} className="ob-check">
                        <input type="checkbox" checked={pick?.[kind] ?? false} onChange={() => toggle(source.id, kind)} />
                        {kind === 'tabs' && source.id === 'arc' ? 'Spaces & tabs' : KIND_LABELS[kind]}
                      </label>
                    ))}
                    {source.profiles.length > 1 && (
                      <select
                        value={pick?.profile}
                        onChange={(e) => setPicks((p) => ({ ...p, [source.id]: { ...p[source.id], profile: e.target.value } }))}
                      >
                        {source.profiles.map((profile) => (
                          <option key={profile.dir} value={profile.dir}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </span>
                )}
              </div>
              {source.blocked ? (
                <button className="ob-secondary small" onClick={() => void zepper.vault({ type: 'openPrivacySettings' })}>
                  Allow…
                </button>
              ) : result && !result.error ? (
                <span className="ob-done">
                  <IconCheck size={14} />
                </span>
              ) : (
                <button className="ob-secondary small" disabled={busy !== null || !chosen(pick)} onClick={() => void run(source)}>
                  {busy === source.id ? 'Importing…' : result?.error ? 'Try again' : 'Import'}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <p className="ob-note">
        Open tabs come in as tabs in your space (other windows get spaces of their own, and Arc&rsquo;s spaces stay spaces); they load when
        you open them.{' '}
        {sources?.some((s) => s.blocked) &&
          'Allow… opens Privacy & Security: turn on Zepper there and reopen it (already on? Remove Zepper with − and add it again: macOS may be remembering an older Zepper). '}
        Passwords in Apple Passwords or Safari?{' '}
        <button className="ob-link" disabled={busy !== null} onClick={() => void fromFile()}>
          Import a passwords file
        </button>
        {results.file && <span className={cx(' ob-inline', results.file.error && 'error')}> {results.file.text}</span>}
      </p>
    </div>
  )
}

/** A mix of quiet and vivid presets. */
const SWATCHES = [0, 1, 3, 7, 10, 13, 14, 15, 17, 18, 21, 23].map((i) => THEME_PRESETS[i])

/** The look of the space you're in, and light or dark. */
function LookStep({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  const space = snapshot.spaces.find((s) => s.id === snapshot.activeSpaceId) ?? snapshot.spaces[0]
  const set = (patch: Partial<Settings>): void => zepper.send({ type: 'settings.update', patch })
  return (
    <div>
      <Heading title="Make it yours">Each space has its own colours. Pick one for this space; you can change it any time.</Heading>
      <div className="ob-swatches">
        {SWATCHES.map((preset, i) => (
          <button
            key={i}
            className={cx(
              'ob-swatch',
              space && preset.colors.join() === space.theme.colors.join() && 'selected',
              preset.colors.length === 0 && 'plain'
            )}
            style={{ background: preset.colors.length ? themeBackground({ ...preset, opacity: 1 }) : undefined }}
            title={preset.colors.length ? 'Gradient' : 'No colour'}
            onClick={() => space && zepper.send({ type: 'space.update', spaceId: space.id, patch: { theme: preset } })}
          />
        ))}
      </div>
      <div className="ob-rows">
        <div className="ob-row">
          <span>Appearance</span>
          <div className="segmented">
            {(
              [
                ['system', 'Auto'],
                ['light', 'Light'],
                ['dark', 'Dark']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={cx(snapshot.settings.colorScheme === value && 'selected')}
                onClick={() => set({ colorScheme: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="ob-row">
          <span>Sidebar</span>
          <div className="segmented">
            {(
              [
                ['left', 'Left'],
                ['right', 'Right']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={cx(snapshot.settings.sidebarPosition === value && 'selected')}
                onClick={() => set({ sidebarPosition: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const PROTECTIONS: { key: keyof Settings; icon: LucideIcon; title: string; detail: string }[] = [
  { key: 'adblock', icon: ShieldCheck, title: 'Ads and trackers blocked', detail: 'uBlock Origin’s lists, including YouTube ads' },
  { key: 'hideCookieBanners', icon: Cookie, title: 'Cookie banners hidden', detail: 'No more consent pop-ups on every site' },
  { key: 'blockFingerprinting', icon: Fingerprint, title: 'Fingerprinting protection', detail: 'Sites can’t recognise you by your device' },
  { key: 'blockCrossSiteCookies', icon: Lock, title: 'Cross-site cookies blocked', detail: 'Embedded trackers can’t follow you around' },
  { key: 'httpsUpgrade', icon: Globe, title: 'HTTPS upgrades', detail: 'Encrypted connections whenever a site has them' },
  { key: 'cleanLinks', icon: Link2, title: 'Clean links', detail: 'Tracking parameters removed from links you open' }
]

function PrivacyStep({ settings }: { settings: Settings }): React.JSX.Element {
  return (
    <div>
      <Heading title="Private by default">Everything here is already on. Turn any of them off for one site from the lock icon.</Heading>
      <div className="ob-rows ob-list">
        {PROTECTIONS.map(({ key, icon: Icon, title, detail }) => (
          <div key={key} className="ob-row">
            <span className="ob-feature-icon">
              <Icon size={15} strokeWidth={2} />
            </span>
            <span className="ob-feature-text">
              <span className="ob-feature-title">{title}</span>
              <span className="ob-feature-detail">{detail}</span>
            </span>
            <Toggle
              small
              checked={settings[key] === true}
              onChange={(on) => zepper.send({ type: 'settings.update', patch: { [key]: on } })}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

const INTELLIGENCE: { icon: LucideIcon; title: string; detail: string }[] = [
  {
    icon: Sparkles,
    title: 'Summarise or ask the page',
    detail: `A summary, then answers about what you’re reading (${isMac ? '⇧⌘A' : 'Ctrl+Shift+A'})`
  },
  { icon: Languages, title: 'Translate pages', detail: 'In place, keeping links and formatting' },
  { icon: ScanSearch, title: 'Search history by meaning', detail: '“that article about async Rust” finds it' },
  { icon: Wand2, title: 'Tidy Tabs', detail: 'Sorts a messy space into named folders' }
]

function IntelligenceStep({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  const available = snapshot.intelligence.ai || snapshot.intelligence.translation || snapshot.intelligence.embeddings
  return (
    <div>
      <Heading title="Apple Intelligence, on your Mac">
        Helpful features that run entirely on this Mac. Nothing you read is sent anywhere.
      </Heading>
      <div className="ob-features">
        {INTELLIGENCE.map(({ icon: Icon, title, detail }) => (
          <div key={title} className="ob-feature">
            <span className="ob-feature-icon">
              <Icon size={15} strokeWidth={2} />
            </span>
            <span className="ob-feature-text">
              <span className="ob-feature-title">{title}</span>
              <span className="ob-feature-detail">{detail}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="ob-rows">
        <div className="ob-row">
          <span>{available ? 'Use on-device intelligence' : (snapshot.intelligence.reason ?? 'Not available on this Mac')}</span>
          <Toggle
            checked={available && snapshot.settings.aiFeatures}
            disabled={!available}
            onChange={(aiFeatures) => zepper.send({ type: 'settings.update', patch: { aiFeatures } })}
          />
        </div>
      </div>
    </div>
  )
}

const TIPS: [string, string][] = [
  ['⌘T', 'Search, open a site or jump to a tab'],
  ['⌘S', 'Show or hide the sidebar'],
  ['⌃1 – 9', 'Switch spaces, or swipe on the sidebar'],
  ['⌘D', 'Pin a tab to this space'],
  ['⇧⌘2', 'Capture part of a page'],
  ['⌘,', 'Settings']
]

function ReadyStep({ snapshot }: { snapshot: Snapshot }): React.JSX.Element {
  return (
    <div>
      <Heading title="You’re all set">A few shortcuts worth knowing. They’re all in the menu bar too.</Heading>
      <div className="ob-rows ob-tips">
        {TIPS.map(([keys, label]) => (
          <div key={keys} className="ob-row">
            <span>{label}</span>
            <kbd>{isMac ? keys : keys.replace(/⌘/g, 'Ctrl+')}</kbd>
          </div>
        ))}
      </div>
      <div className="ob-default">
        {snapshot.defaultBrowser ? (
          <span className="ob-default-done">
            <IconCheck size={14} /> Zepper is your default browser
          </span>
        ) : (
          <>
            <span>Open links from other apps in Zepper</span>
            <button className="ob-secondary small" onClick={() => zepper.send({ type: 'app.makeDefaultBrowser' })}>
              Make default browser
            </button>
          </>
        )}
      </div>
    </div>
  )
}
