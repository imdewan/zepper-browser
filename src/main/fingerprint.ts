import { availableParallelism } from 'node:os'
import type { WebContents } from 'electron'
import { CHIP_PATTERN, UNMASKED_RENDERER } from '@shared/fingerprint'

/**
 * Fingerprinting protection's values that must agree everywhere a site's code runs: the page, its
 * frames and its workers (sign-in checks compare them: X refused a page whose workers disagreed).
 * As in Brave, each site sees its own values this session, so they can't link you across sites:
 * - the CPU core count, between 2 and the real one;
 * - on Apple silicon, which chip the graphics card says it is, one of the common ones.
 * They're set through the DevTools protocol, before any of the page's (or a worker's) code runs.
 */

const REAL_CORES = availableParallelism()
const CHIPS = ['Apple M1', 'Apple M2', 'Apple M3', 'Apple M1 Pro', 'Apple M2 Pro', 'Apple M3 Pro', 'Apple M4', 'Apple M1 Max']

export interface Disguise {
  cores: number
  chip: string
}

/** A site's values for this session, from its fingerprinting seed (see shields.fingerprintSeed). */
export function disguiseFor(seed: number): Disguise {
  return {
    cores: REAL_CORES <= 2 ? REAL_CORES : 2 + ((seed >>> 3) % (REAL_CORES - 1)),
    chip: CHIPS[(seed >>> 11) % CHIPS.length]
  }
}

/**
 * Run in each worker before its own code: the core count and chip it reports, through Proxies of the
 * real getters so they still look native (Function.prototype.toString shows the original's source).
 */
function workerScript(d: Disguise): string {
  return `(() => {
  const originals = new WeakMap()
  const disguise = (original, handler) => { const proxy = new Proxy(original, handler); originals.set(proxy, original); return proxy }
  const toString = Object.getOwnPropertyDescriptor(Function.prototype, 'toString')
  Object.defineProperty(Function.prototype, 'toString', { ...toString, value: disguise(toString.value, { apply: (t, self, a) => Reflect.apply(t, originals.get(self) ?? self, a) }) })
  const cores = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'hardwareConcurrency')
  if (cores && cores.get) Object.defineProperty(WorkerNavigator.prototype, 'hardwareConcurrency', { ...cores, get: disguise(cores.get, { apply: () => ${d.cores} }) })
  const chip = new RegExp(${JSON.stringify(CHIP_PATTERN)})
  for (const proto of [self.WebGLRenderingContext && WebGLRenderingContext.prototype, self.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
    if (!proto) continue
    const get = Object.getOwnPropertyDescriptor(proto, 'getParameter')
    Object.defineProperty(proto, 'getParameter', { ...get, value: disguise(get.value, { apply: (t, self, a) => {
      const value = Reflect.apply(t, self, a)
      return a[0] === ${UNMASKED_RENDERER} && typeof value === 'string' ? value.replace(chip, ${JSON.stringify(d.chip)}) : value
    } }) })
  }
})()`
}

/**
 * Keeps a tab's page, frames and workers on its site's values (`decide` gives them for an address,
 * or null where the protection is off). Workers and frames are held as they start, given the values,
 * and let go; one that can't be set up still starts.
 */
const guarded = new WeakSet<WebContents>()

export function guardTab(wc: WebContents, decide: (url: string) => Disguise | null): void {
  // Once per page, wherever it moves (a tab dragged to another window keeps its watcher).
  if (guarded.has(wc)) return
  guarded.add(wc)
  const debug = wc.debugger
  let current: Disguise | null = null
  let site: string | null = null

  const attach = (): boolean => {
    if (debug.isAttached()) return true
    try {
      debug.attach('1.3')
      void debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  const prepare = async (sessionId: string, type: string): Promise<void> => {
    try {
      if (current && type === 'worker') await debug.sendCommand('Runtime.evaluate', { expression: workerScript(current) }, sessionId)
      if (type === 'iframe') {
        await debug.sendCommand('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: current?.cores ?? REAL_CORES }, sessionId)
      }
      // Their own workers and frames, the same way.
      if (type === 'worker' || type === 'iframe') {
        await debug.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
      }
    } catch {
      // Gone already, or not one Zepper can set up.
    } finally {
      await debug.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
    }
  }

  debug.on('message', (_event, method, params: { sessionId?: string; targetInfo?: { type: string } }) => {
    if (method === 'Target.attachedToTarget' && params.sessionId) void prepare(params.sessionId, params.targetInfo?.type ?? '')
  })

  const apply = (url: string): void => {
    if (url === site) return
    site = url
    current = decide(url)
    // Nothing to change (protection off): no need to be attached.
    if ((!current && !debug.isAttached()) || !attach()) return
    void debug
      .sendCommand('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: current?.cores ?? REAL_CORES })
      .catch(() => {})
  }
  // A new page (or a redirect to another): its site's values, set before its code runs; once it has
  // committed, the address it ended up at (a navigation that never committed leaves the page as it was).
  const onNavigation = (details: { url: string; isMainFrame: boolean; isSameDocument?: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) apply(details.url)
  }
  wc.on('did-start-navigation', onNavigation)
  wc.on('did-redirect-navigation', onNavigation)
  wc.on('did-navigate', (_event, url) => apply(url))
  // One that didn't (a link that turned out to be a download): back to the page's own.
  wc.on('did-stop-loading', () => apply(wc.getURL()))
}
