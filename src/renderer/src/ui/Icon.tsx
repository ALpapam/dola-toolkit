import type { CSSProperties, ReactNode } from 'react'
import { ICONS, type IconName } from './icons.generated'

export type { IconName }

interface IconProps {
  name: IconName | (string & {})
  size?: number | string
  className?: string
  style?: CSSProperties
  title?: string
}

export function Icon({ name, size = 20, className = '', style, title }: IconProps): JSX.Element {
  const def = ICONS[name] ?? ICONS.info
  return (
    <span
      className={`icon ${className}`}
      style={{ fontSize: typeof size === 'number' ? `${size}px` : size, ...style }}
      title={title}
      aria-hidden={title ? undefined : true}
      dangerouslySetInnerHTML={{
        __html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${def.viewBox}" fill="currentColor">${def.body}</svg>`
      }}
    />
  )
}

export function hasIcon(name: string): boolean {
  return name in ICONS
}

export type { ReactNode }
