import { useEffect, useState } from 'react'
import { useApp } from '../state/app'
import { Icon } from '../ui/Icon'

const MAXIMIZED_KEY = 'dola.maximized'

export function TitleBar(): JSX.Element {
  const page = useApp((s) => s.page)
  const [maximized, setMaximized] = useState(() => localStorage.getItem(MAXIMIZED_KEY) === '1')

  useEffect(() => {
    const on = (): void => setMaximized(localStorage.getItem(MAXIMIZED_KEY) === '1')
    window.addEventListener('dola:maximized', on)
    return () => window.removeEventListener('dola:maximized', on)
  }, [])

  const title = PAGE_TITLES[page] ?? 'Dola Toolkit'

  return (
    <header className="titlebar">
      <div className="titlebar-title">
        <span className="strong">{title}</span>
        {page !== 'home' ? <span className="crumb">Dola Toolkit</span> : null}
      </div>
      <div className="titlebar-spacer" />
      <div className="win-controls">
        <button
          className="win-btn"
          onClick={() => window.api.app.minimize()}
          title="最小化"
          aria-label="最小化"
        >
          <Icon name="winMin" size={15} />
        </button>
        <button
          className="win-btn"
          onClick={() => window.api.app.toggleMaximize()}
          title={maximized ? '还原' : '最大化'}
          aria-label="最大化"
        >
          <Icon name={maximized ? 'winRestore' : 'winMax'} size={14} />
        </button>
        <button
          className="win-btn close"
          onClick={() => window.api.app.close()}
          title="关闭"
          aria-label="关闭"
        >
          <Icon name="winClose" size={15} />
        </button>
      </div>
    </header>
  )
}

export const PAGE_TITLES: Record<string, string> = {
  home: 'Dola Toolkit',
  proxy: '代理',
  library: '书库',
  settings: '设置'
}

/** Exposed for the preload-free maximized state sync. */
export function notifyMaximized(v: boolean): void {
  localStorage.setItem(MAXIMIZED_KEY, v ? '1' : '0')
  window.dispatchEvent(new Event('dola:maximized'))
}
