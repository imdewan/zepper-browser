import { useEffect, useState } from 'react'
import { IconGlobe } from './icons'
import { cx } from './util'

interface FaviconProps {
  src: string | null
  size?: number
  className?: string
}

/** A favicon that falls back to a neutral globe when missing or broken. */
export function Favicon({ src, size = 16, className }: FaviconProps): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (!src || failed) {
    return (
      <span className={cx('favicon', 'favicon-fallback', className)} style={{ width: size, height: size }}>
        <IconGlobe size={size * 0.85} />
      </span>
    )
  }
  return (
    <img
      className={cx('favicon', className)}
      src={src}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(true)}
      alt=""
    />
  )
}
