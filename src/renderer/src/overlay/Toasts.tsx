import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ToastSpec } from '@shared/types'
import { zepper } from '../bridge'

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

/** A Zen toast: springs in from scale 0, auto-hides after 2s, pauses while hovered. */
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
      initial={{ scale: 0, opacity: 1 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.5, opacity: 0, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
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
    </motion.div>
  )
}
