import { JsonFile } from './persist'

/** Chrome's zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

/** The next zoom step in or out from a factor (or back to 100%). */
export function nextZoom(current: number, direction: 1 | -1 | 0): number {
  if (direction === 0) return 1
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0]
}

/** Page zoom chosen per site, remembered across restarts and profiles. */
export class ZoomLevels {
  private readonly file = new JsonFile<Record<string, number>>('zoom.json', 500)
  private readonly levels: Record<string, number> = this.file.read() ?? {}

  get(host: string): number {
    return this.levels[host] ?? 1
  }

  set(host: string, factor: number): void {
    if (!host) return
    if (Math.abs(factor - 1) < 0.001) delete this.levels[host]
    else this.levels[host] = factor
    this.file.schedule(this.levels)
  }

  flush(): void {
    this.file.flush()
  }
}
