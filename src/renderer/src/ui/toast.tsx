import { create } from 'zustand'
import type { ToastEvent } from '@shared/types'
import { Icon } from '../ui/Icon'

interface ToastStore {
  items: ToastEvent[]
  push: (kind: ToastEvent['kind'], message: string, ttl?: number) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (kind, message, ttl = 3200) => {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ items: [...s.items, { id, kind, message }] }))
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    }, ttl)
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
}))

export const toast = {
  info: (m: string): void => useToasts.getState().push('info', m),
  success: (m: string): void => useToasts.getState().push('success', m),
  warn: (m: string): void => useToasts.getState().push('warning', m),
  error: (m: string): void => useToasts.getState().push('error', m)
}

const ICON_FOR: Record<ToastEvent['kind'], string> = {
  info: 'info',
  success: 'checkCircle',
  warning: 'warning',
  error: 'error'
}

export function ToastHost(): JSX.Element {
  const items = useToasts((s) => s.items)
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => useToasts.getState().dismiss(t.id)}>
          <Icon name={ICON_FOR[t.kind]} size={18} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
