import type { ZepperApi } from '../shared/types'

declare global {
  interface Window {
    zepper: ZepperApi
  }
}

export {}
