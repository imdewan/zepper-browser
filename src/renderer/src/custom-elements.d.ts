import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        partition?: string
        alignment?: string
      }
    }
  }
}
