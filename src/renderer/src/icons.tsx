import type { SVGProps } from 'react'
import {
  Camera,
  CircleArrowUp,
  CodeXml,
  Columns2,
  Crosshair,
  Globe,
  Info,
  KeyRound,
  Link,
  Mic,
  Monitor,
  MonitorUp,
  Smartphone,
  SquareTerminal,
  UserRoundKey,
  Video,
  type LucideProps
} from 'lucide-react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const IconBack = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
)
export const IconForward = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M9 18l6-6-6-6" />
  </Icon>
)
export const IconReload = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
)
export const IconSidebar = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16" />
  </Icon>
)
export const IconDownload = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19h14" />
  </Icon>
)
export const IconFolder = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Icon>
)
export const IconFolderOpen = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 17.5v-10A1.5 1.5 0 0 1 5 6h4l2 2h7a1.5 1.5 0 0 1 1.5 1.5V11" />
    <path d="M3.5 17.5l2.2-5.6A1.5 1.5 0 0 1 7.1 11H20a1 1 0 0 1 .94 1.33l-1.9 5.5A1.5 1.5 0 0 1 17.6 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Icon>
)
export const IconCopy = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5" />
    <path d="M15.5 5.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h.5" />
  </Icon>
)
export const IconCheck = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
export const IconPuzzle = (p: IconProps): React.JSX.Element => (
  <Icon {...p} strokeWidth={1.7}>
    <path
      transform="translate(1.2 1.2) scale(0.9)"
      d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"
    />
  </Icon>
)
export const IconPin = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z" />
    <path d="M12 14v6" />
  </Icon>
)

/** Hat and glasses: private browsing. */
export const IconPrivate = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M3 11h18" />
    <path d="M5.5 11l1.6-5.2a1.5 1.5 0 0 1 2-.9L12 6l2.9-1.1a1.5 1.5 0 0 1 2 .9l1.6 5.2" />
    <circle cx="7.5" cy="16.5" r="2.5" />
    <circle cx="16.5" cy="16.5" r="2.5" />
    <path d="M10 16.5c1.3-.8 2.7-.8 4 0" />
  </Icon>
)
export const IconLockOpen = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 7.7-1.5" />
  </Icon>
)
export const IconLock = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
)
// Password manager glyphs come from Lucide, the icon pack Settings uses.
export const IconKey = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <KeyRound size={size} strokeWidth={1.9} aria-hidden="true" {...(p as LucideProps)} />
)
export const IconChevronRight = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
)
export const IconPhone = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <Smartphone size={size} strokeWidth={1.9} aria-hidden="true" {...(p as LucideProps)} />
)
/** A person with a key: passkeys. */
export const IconPasskey = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <UserRoundKey size={size} strokeWidth={1.9} aria-hidden="true" {...(p as LucideProps)} />
)
export const IconGlobe = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
)
export const IconSearch = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
)
export const IconPlus = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)
export const IconClose = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
)
export const IconMinus = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M6 12h12" />
  </Icon>
)
export const IconSettings = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
)
export const IconSpeaker = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </Icon>
)
export const IconMuted = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M11 5L6 9H3v6h3l5 4V5z" />
    <path d="M22 9l-6 6M16 9l6 6" />
  </Icon>
)
export const IconChevronDown = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
)
/** A pop-up selector's up-and-down chevrons (choose one of several). */
export const IconChevronUpDown = (p: IconProps): React.JSX.Element => (
  <Icon {...p} strokeWidth={2.2}>
    <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />
  </Icon>
)
export const IconDots = (p: IconProps): React.JSX.Element => (
  <Icon {...p} strokeWidth={2.6}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Icon>
)
export const IconArrowDown = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
)
export const IconTranslate = (p: IconProps): React.JSX.Element => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" />
  </Icon>
)
export const IconSparkle = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9L12 3zM19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
  </Icon>
)
export const IconShield = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
  </Icon>
)
export const IconArrowRight = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
)
export const IconClock = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
)

/** Animated "now playing" bars. */
export function Equalizer({ paused = false }: { paused?: boolean }): React.JSX.Element {
  return (
    <span className={`equalizer${paused ? ' paused' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

export const IconPlay = (p: IconProps): React.JSX.Element => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
  </Icon>
)
export const IconPause = (p: IconProps): React.JSX.Element => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4.2" height="14" rx="1.2" />
    <rect x="13.8" y="5" width="4.2" height="14" rx="1.2" />
  </Icon>
)

/** Circular arrow with "10" inside: skip back / forward ten seconds. */
export const IconSkipBack = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 4.5v5h5" />
    <path d="M4.2 14.5A8.5 8.5 0 1 0 6.1 6.1L3.5 9.5" />
    <text x="12.6" y="15.3" fontSize="7.6" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none">
      10
    </text>
  </Icon>
)
export const IconSkipForward = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M20.5 4.5v5h-5" />
    <path d="M19.8 14.5A8.5 8.5 0 1 1 17.9 6.1L20.5 9.5" />
    <text x="11.4" y="15.3" fontSize="7.6" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none">
      10
    </text>
  </Icon>
)

export const IconTrash = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7" />
    <path d="M10 11v5M14 11v5" />
  </Icon>
)
export const IconCookie = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M12 3a9 9 0 1 0 9 9 4 4 0 0 1-4-4 4 4 0 0 1-5-5z" />
    <path d="M8.5 11.5h.01M12 16h.01M15.5 13.5h.01M9 15.5h.01" />
  </Icon>
)

/** Back to the tab: an arrow up into the window's corner. */
export const IconPopIn = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M14 14l-4-4M10 14v-4h4" />
  </Icon>
)
/** An update is ready. */
export const IconUpdate = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <CircleArrowUp size={size} strokeWidth={2.1} aria-hidden="true" {...(p as LucideProps)} />
)
export const IconMonitor = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <Monitor size={size} strokeWidth={1.9} aria-hidden="true" {...(p as LucideProps)} />
)
/** In use by a tab: camera, microphone, screen. */
export const IconCamera = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <Video size={size} strokeWidth={2.2} aria-hidden="true" {...(p as LucideProps)} />
)
export const IconMic = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <Mic size={size} strokeWidth={2.2} aria-hidden="true" {...(p as LucideProps)} />
)
export const IconScreenShare = ({ size = 16, ...p }: IconProps): React.JSX.Element => (
  <MonitorUp size={size} strokeWidth={2.2} aria-hidden="true" {...(p as LucideProps)} />
)

// ---- Developer Mode's bar ----
const lucide = (Glyph: React.ComponentType<LucideProps>, strokeWidth = 1.9) =>
  function DeveloperIcon({ size = 16, ...p }: IconProps): React.JSX.Element {
    return <Glyph size={size} strokeWidth={strokeWidth} aria-hidden="true" {...(p as LucideProps)} />
  }
/** Copy the address. */
export const IconLink = lucide(Link)
/** Portrait Mode: a picture of the page, set on a backdrop. */
export const IconFrame = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="19" height="17" rx="3.5" />
    <rect x="6.5" y="7.5" width="11" height="9" rx="1.5" />
    <path d="M8.5 15l2.5-2.75 1.75 1.75 1.25-1.25 1.5 1.5" />
    <circle cx="14.6" cy="10.1" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
)
/** A screenshot (Zepper's capture). */
export const IconScreenshot = lucide(Camera)
export const IconConsole = lucide(SquareTerminal)
export const IconNetwork = lucide(Globe)
/** Inspect an element. */
export const IconInspect = lucide(Crosshair)
export const IconSplit = lucide(Columns2)
export const IconInfo = lucide(Info)
/** Developer Mode. */
export const IconCode = lucide(CodeXml, 2)
