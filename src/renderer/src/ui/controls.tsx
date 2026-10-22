import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */
type BtnVariant = 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated' | 'danger'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  icon?: IconName | string
  size?: 'sm' | 'md' | 'xs'
  loading?: boolean
}

export function Button({
  variant = 'filled',
  icon,
  size = 'md',
  loading,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : size === 'xs' ? 'btn-xs' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : null}
      {icon && !loading ? <Icon name={icon} /> : null}
      {children}
    </button>
  )
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName | string
  size?: number
  small?: boolean
  active?: boolean
  label?: string
}

export function IconButton({
  icon,
  size = 20,
  small,
  active,
  label,
  className = '',
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      className={`btn-icon ${small ? 'sm' : ''} ${active ? 'active' : ''} ${className}`}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Text field                                                          */
/* ------------------------------------------------------------------ */
interface FieldProps {
  label?: string
  hint?: string
  error?: string | null
  prefixIcon?: IconName | string
  suffix?: ReactNode
  outlined?: boolean
  className?: string
  children: ReactNode
}

export function Field({
  label,
  hint,
  error,
  prefixIcon,
  suffix,
  outlined,
  className = '',
  children
}: FieldProps): JSX.Element {
  return (
    <label className={`field ${className}`}>
      {label ? <span className="field-label">{label}</span> : null}
      <span className={`input-wrap ${outlined ? 'input-outlined' : ''} ${error ? 'error' : ''}`}>
        {prefixIcon ? (
          <span className="icon-prefix">
            <Icon name={prefixIcon} size={19} />
          </span>
        ) : null}
        {children}
        {suffix ? <span className="suffix">{suffix}</span> : null}
      </span>
      {error ? <span className="field-hint error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  hint?: string
  error?: string | null
  prefixIcon?: IconName | string
  suffix?: ReactNode
  outlined?: boolean
}

export function TextInput({ label, hint, error, prefixIcon, suffix, outlined, ...rest }: TextInputProps): JSX.Element {
  return (
    <Field label={label} hint={hint} error={error} prefixIcon={prefixIcon} suffix={suffix} outlined={outlined}>
      <input className="input" spellCheck={false} {...rest} />
    </Field>
  )
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  outlined?: boolean
}

export function TextArea({ label, hint, outlined, ...rest }: TextAreaProps): JSX.Element {
  return (
    <Field label={label} hint={hint} outlined={outlined}>
      <textarea className="input" spellCheck={false} {...rest} />
    </Field>
  )
}

/**
 * Dropdown select.
 *
 * A native <select> cannot be styled beyond its closed state — Windows renders
 * the popup itself, so it ignored the theme and looked like a browser default.
 * This is a button plus a positioned listbox: fully themed, animated open/close,
 * keyboard operable (↑/↓/Enter/Esc/Home/End), and it flips upward when there is
 * no room below.
 */
export function Select({
  label,
  hint,
  value,
  onChange,
  options,
  outlined
}: {
  label?: string
  hint?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  outlined?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  /**
   * Menu geometry in viewport coordinates.
   *
   * The list is rendered into a portal rather than inside `.select`, because
   * dialogs and panels set `overflow: hidden/auto` and would clip it. Fixed
   * positioning plus a portal keeps it above everything, the way a native popup
   * behaves.
   */
  const [box, setBox] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const current = options[selectedIndex]

  const measure = (): void => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const menuHeight = Math.min(options.length * 38 + 16, 288)
    const up = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight + 12
    setBox({
      left: rect.left,
      top: up ? rect.top - 6 : rect.bottom + 6,
      width: rect.width,
      up
    })
  }

  const openMenu = (): void => {
    setActive(selectedIndex)
    measure()
    setOpen(true)
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (option) onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(options.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setActive(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setActive(options.length - 1)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        commit(active)
      } else if (e.key === 'Tab') {
        setOpen(false)
      }
    }
    // keep the popup attached to its trigger while the page scrolls or resizes
    const onReflow = (): void => measure()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, active, options.length])

  const menu =
    open && box
      ? createPortal(
          <div
            className={`select-menu ${box.up ? 'up' : 'down'}`}
            role="listbox"
            ref={menuRef}
            style={{
              position: 'fixed',
              left: box.left,
              width: box.width,
              ...(box.up
                ? { bottom: Math.max(8, window.innerHeight - box.top) }
                : { top: box.top })
            }}
          >
            {options.map((o, i) => (
              <button
                type="button"
                key={o.value}
                data-idx={i}
                role="option"
                aria-selected={o.value === value}
                className={`select-option ${o.value === value ? 'sel' : ''} ${i === active ? 'active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
              >
                <span className="select-option-label">{o.label}</span>
                {o.value === value ? <Icon name="check" size={17} /> : null}
              </button>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    /*
     * Deliberately NOT wrapped in <Field>: Field always draws an `.input-wrap`
     * (filled surface + bottom border), and the trigger already has its own
     * outline — nesting them produced a box inside a box. The label and hint are
     * recreated here without that frame.
     */
    <div className={`field ${outlined ? 'field-outlined' : ''}`}>
      {label ? <span className="field-label">{label}</span> : null}
      <div className={`select ${open ? 'is-open' : ''}`} ref={rootRef}>
        <button
          type="button"
          ref={triggerRef}
          className="select-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              openMenu()
            }
          }}
        >
          <span className="select-value">{current?.label ?? '请选择'}</span>
          <span className="select-caret" aria-hidden>
            <Icon name="expandMore" size={20} />
          </span>
        </button>
      </div>
      {menu}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */
export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="thumb" />
    </button>
  )
}

export function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className="hstack"
      style={{ gap: 8 }}
      onClick={() => onChange(!checked)}
    >
      <span className={`check ${checked ? 'on' : ''}`}>
        <Icon name="check" size={12} />
      </span>
      {label ? <span style={{ fontSize: 13 }}>{label}</span> : null}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  style
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  style?: CSSProperties
}): JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--pct' as string]: `${pct}%`, ...style }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Chips / segmented control / tabs                                    */
/* ------------------------------------------------------------------ */
export function Chip({
  selected,
  onClick,
  icon,
  children,
  danger
}: {
  selected?: boolean
  onClick?: () => void
  icon?: IconName | string
  children: ReactNode
  danger?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={`chip ${selected ? 'selected' : ''} ${danger ? 'danger' : ''}`}
      onClick={onClick}
    >
      {selected ? <Icon name="check" size={15} /> : icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; icon?: IconName | string; label?: string }[]
}): JSX.Element {
  const textOnly = options.some((o) => !o.icon)
  return (
    <div className={`icon-seg ${textOnly ? 'has-text' : ''}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`btn-icon ${value === o.value ? 'active' : ''}`}
          title={o.label}
          onClick={() => onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} size={18} /> : <span className="seg-text">{o.label}</span>}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  onChange,
  items
}: {
  value: T
  onChange: (v: T) => void
  items: { value: T; label: string; icon?: IconName | string }[]
}): JSX.Element {
  return (
    <div className="tabs">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          className={`tab ${value === it.value ? 'active' : ''}`}
          onClick={() => onChange(it.value)}
        >
          {it.icon ? <Icon name={it.icon} size={17} /> : null}
          {it.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  width = 'normal'
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  icon?: IconName | string
  children: ReactNode
  footer?: ReactNode
  width?: 'normal' | 'wide' | 'slim'
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`dialog ${width === 'wide' ? 'wide' : width === 'slim' ? 'slim' : ''}`}
        role="dialog"
        aria-modal="true"
      >
        <div className="dialog-head">
          {icon ? (
            <span className="dialog-icon">
              <Icon name={icon} size={24} />
            </span>
          ) : null}
          <div style={{ minWidth: 0 }}>
            <div className="dialog-title">{title}</div>
            {subtitle ? <div className="dialog-sub">{subtitle}</div> : null}
          </div>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* Bottom sheet                                                        */
/* ------------------------------------------------------------------ */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  icon
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  icon?: IconName | string
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div
      className="sheet-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-handle" />
        <div className="sheet-head">
          {icon ? <Icon name={icon} size={20} /> : null}
          <h3>{title}</h3>
          <span className="spacer" />
          <IconButton icon="close" small onClick={onClose} label="关闭" />
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */
export interface MenuItem {
  label: string
  icon?: IconName | string
  onClick?: () => void
  danger?: boolean
  separator?: boolean
  disabled?: boolean
}

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (x + r.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - r.width - 8)
    if (y + r.height > window.innerHeight - 8) ny = Math.max(8, y - r.height - 28)
    setPos({ x: nx, y: ny })
  }, [x, y])
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
          >
            {it.icon ? <Icon name={it.icon} size={18} /> : null}
            {it.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------------ */
/* misc atoms                                                          */
/* ------------------------------------------------------------------ */
export function Badge({
  children,
  tone = 'default',
  dot
}: {
  children: ReactNode
  tone?: 'default' | 'ok' | 'err' | 'warn'
  dot?: boolean
}): JSX.Element {
  return (
    <span className={`badge ${tone === 'default' ? '' : tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  )
}

export function Empty({
  icon = 'autoAi',
  title,
  desc,
  action
}: {
  icon?: IconName | string
  title: string
  desc?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <span className="empty-glyph">
        <Icon name={icon} size={56} />
      </span>
      <h3>{title}</h3>
      {desc ? <p>{desc}</p> : null}
      {action}
    </div>
  )
}

export function Progress({ value, indeterminate }: { value?: number; indeterminate?: boolean }): JSX.Element {
  return (
    <div className={`progress-linear ${indeterminate ? 'indeterminate' : ''}`}>
      <i style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%` }} />
    </div>
  )
}

export function Spinner({ size = 18 }: { size?: number }): JSX.Element {
  return <span className="spinner" style={{ width: size, height: size }} />
}

/* convenience: labelled setting row */
export function SettingRow({
  title,
  desc,
  children,
  stacked
}: {
  title: string
  desc?: string
  children?: ReactNode
  stacked?: boolean
}): JSX.Element {
  return (
    <div className={`set-item ${stacked ? 'stacked' : ''}`}>
      <div className="set-item-main">
        <div className="set-item-title">{title}</div>
        {desc ? <div className="set-item-desc">{desc}</div> : null}
      </div>
      {children ? <div className="set-item-ctrl">{children}</div> : null}
    </div>
  )
}
