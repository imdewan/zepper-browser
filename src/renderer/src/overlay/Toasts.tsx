import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ToastSpec } from '@shared/types'
import { zepper } from '../bridge'
import { IconClose } from '../icons'

interface ToastsProps {
  toasts: ToastSpec[]
  onDismiss: (id: string) => void
}

export function Toasts({ toasts, onDismiss }: ToastsProps): React.JSX.Element {
  return (
    <div className="toasts">
      <AnimatePresence>
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

/** A Zen toast: eases in, auto-hides (2s unless it says otherwise), pauses while hovered, and can be closed. */
function Toast({ toast, onDismiss }: { toast: ToastSpec; onDismiss: () => void }): React.JSX.Element {
  const timer = useRef(0)
  const start = (): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(onDismiss, toast.timeout ?? 2000)
  }
  useEffect(() => {
    start()
    return () => window.clearTimeout(timer.current)
  }, [toast])

  return (
    <motion.div
      className="toast"
      layout
      initial={{ opacity: 0, y: -10, scale: 0.96, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -6, scale: 0.97, filter: 'blur(2px)', transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
      transition={{ type: 'spring', bounce: 0.12, duration: 0.42 }}
      onMouseEnter={() => window.clearTimeout(timer.current)}
      onMouseLeave={start}
    >
      <div className="toast-text">
        <div className="toast-message">{toast.message}</div>
        {toast.description && <div className="toast-description">{toast.description}</div>}
      </div>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            zepper.send(toast.action!.command)
            onDismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" title="Dismiss" onClick={onDismiss}>
        <IconClose size={10} />
      </button>
    </motion.div>
  )
}
