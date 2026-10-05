import { useEffect, useState } from 'react'
import type { Snapshot, UiEvent } from '@shared/types'
import { zepper } from './bridge'

export function useSnapshot(): Snapshot | null {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  useEffect(() => {
    let alive = true
    const off = zepper.onSnapshot((s) => alive && setSnapshot(s))
    void zepper.getSnapshot().then((s) => alive && setSnapshot((prev) => prev ?? s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return snapshot
}

export function useUiEvents(handler: (event: UiEvent) => void): void {
  useEffect(() => zepper.onEvent(handler), [handler])
}

/** Tracks the OS light/dark appearance. */
export function useSystemDark(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark
}
