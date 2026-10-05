import type { SVGProps } from 'react'

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
export const IconCheck = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)
export const IconPuzzle = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <path d="M10 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h-1.5a2 2 0 1 0 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3h1.5a2 2 0 1 0 0-4H6V7a1 1 0 0 1 1-1h3z" />
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
export const IconLock = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
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

export const IconPopIn = (p: IconProps): React.JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M14 10l-4 4M10 10v4h4" />
  </Icon>
)
