import { CheckCircle2, CircleAlert, Info } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type ToastKind = 'success' | 'error' | 'info'

type ToastItem = {
  id: number
  kind: ToastKind
  message: string
  leaving?: boolean
}

type ToastContextValue = {
  toast: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined })

export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}

const TOAST_DURATION = 3400
const TOAST_LEAVE = 220

// Sonner-style stack: bottom-right, slide/fade in, auto-dismiss with a soft
// leave animation. Pure transform/opacity so it never janks.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts(current => current.map(item => item.id === id ? { ...item, leaving: true } : item))
    window.setTimeout(() => {
      setToasts(current => current.filter(item => item.id !== id))
    }, TOAST_LEAVE)
  }, [])

  const toast = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = nextId.current++
    setToasts(current => [...current.slice(-3), { id, kind, message }])
    window.setTimeout(() => dismiss(id), TOAST_DURATION)
  }, [dismiss])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map(item => (
            <button
              key={item.id}
              type="button"
              className={`toast toast--${item.kind} ${item.leaving ? 'is-leaving' : ''}`}
              onClick={() => dismiss(item.id)}
            >
              <span className="toast-icon" aria-hidden="true">
                {item.kind === 'success' && <CheckCircle2 size={15} />}
                {item.kind === 'error' && <CircleAlert size={15} />}
                {item.kind === 'info' && <Info size={15} />}
              </span>
              {item.message}
            </button>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}
