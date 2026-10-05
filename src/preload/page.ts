/// <reference lib="dom" />
import { ipcRenderer } from 'electron'

/**
 * Runs in every web page (top frame only). Reports two-finger horizontal
 * trackpad swipes that the page itself can't scroll, so the browser can
 * slide the page and navigate back or forward.
 */
const SWIPE_CHANNEL = 'zepper:swipe'
const END_AFTER_MS = 140

function canScrollHorizontally(target: EventTarget | null, delta: number): boolean {
  const scrollable = (el: Element): boolean => {
    if (el.scrollWidth <= el.clientWidth + 1) return false
    return delta < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  }
  for (let node = target instanceof Element ? target : null; node && node !== document.documentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX
    if ((overflow === 'auto' || overflow === 'scroll') && scrollable(node)) return true
  }
  const root = document.scrollingElement
  return !!root && scrollable(root)
}

if (window.top === window) {
  let active = false
  let dx = 0
  let timer = 0

  window.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.deltaMode !== 0) return
      if (!active) {
        const horizontal = Math.abs(event.deltaX) > 3 && Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.5
        if (!horizontal || canScrollHorizontally(event.target, event.deltaX)) return
        active = true
        dx = 0
      }
      dx += event.deltaX
      ipcRenderer.send(SWIPE_CHANNEL, 'update', dx)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        ipcRenderer.send(SWIPE_CHANNEL, 'end', dx)
        active = false
        dx = 0
      }, END_AFTER_MS)
    },
    { passive: true, capture: true }
  )
}
