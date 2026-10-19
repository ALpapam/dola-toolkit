import { useEffect, useRef, useState, type ReactNode } from 'react'

/* ------------------------------------------------------------------ */
/* useLocalStorage-ish helper for UI-only prefs (no main round trip)    */
/* ------------------------------------------------------------------ */
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`dola.${key}`)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = (v: T | ((old: T) => T)): void => {
    setValue((old) => {
      const next = typeof v === 'function' ? (v as (o: T) => T)(old) : v
      try {
        localStorage.setItem(`dola.${key}`, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  return [value, set]
}

/* ------------------------------------------------------------------ */
/* window size hook                                                     */
/* ------------------------------------------------------------------ */
export function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const on = (): void => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return size
}

/* ------------------------------------------------------------------ */
/* click-outside hook                                                   */
/* ------------------------------------------------------------------ */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  handler: () => void,
  active = true
): void {
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) handler()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handler()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, handler, active])
}

/* ------------------------------------------------------------------ */
/* debounce                                                             */
/* ------------------------------------------------------------------ */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/* ------------------------------------------------------------------ */
/* hotkey hook                                                          */
/* ------------------------------------------------------------------ */
export function useHotkey(combo: string, handler: () => void, enabled = true): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled) return
    const parts = combo.toLowerCase().split('+')
    const key = parts[parts.length - 1]
    const needCtrl = parts.includes('ctrl') || parts.includes('mod')
    const needShift = parts.includes('shift')
    const needAlt = parts.includes('alt')
    const on = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return
      if (e.key.toLowerCase() !== key) return
      if (needCtrl !== (e.ctrlKey || e.metaKey)) return
      if (needShift !== e.shiftKey) return
      if (needAlt !== e.altKey) return
      e.preventDefault()
      ref.current()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [combo, enabled])
}

/* ------------------------------------------------------------------ */
/* click-anchored dropdown                                              */
/* ------------------------------------------------------------------ */
export interface AnchorState {
  x: number
  y: number
}

export function useAnchoredMenu(): {
  anchor: AnchorState | null
  open: (e: React.MouseEvent) => void
  close: () => void
} {
  const [anchor, setAnchor] = useState<AnchorState | null>(null)
  return {
    anchor,
    open: (e) => {
      e.stopPropagation()
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setAnchor({ x: Math.min(r.left, window.innerWidth - 200), y: r.bottom + 4 })
    },
    close: () => setAnchor(null)
  }
}

/* ------------------------------------------------------------------ */
/* crude markdown renderer for AI answers (safe: escapes HTML)          */
/* ------------------------------------------------------------------ */
export function renderRich(text: string): ReactNode {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const blocks = esc(text).split(/\n{2,}/)
  return blocks.map((block, i) => {
    const lineBreakSplit = block.split('\n')
    if (lineBreakSplit.every((l) => /^\s*[-*•]\s+/.test(l))) {
      return (
        <ul key={i} style={{ margin: '4px 0', paddingLeft: 18 }}>
          {lineBreakSplit.map((l, j) => (
            <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
          ))}
        </ul>
      )
    }
    return (
      <p key={i} style={{ margin: '0 0 6px' }}>
        {lineBreakSplit.map((l, j) => (
          <span key={j}>
            {inline(l)}
            {j < lineBreakSplit.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    )
  })
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>)
    else out.push(<code key={k++}>{tok.slice(1, -1)}</code>)
    last = m.index + tok.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
