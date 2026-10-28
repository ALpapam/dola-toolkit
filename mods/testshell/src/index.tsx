// ---------------------------------------------------------------------------
// 测试空壳 mod
//
// One bundle serves all of the Test1…Test10 packages: it reads its own id from the
// <script> URL the host used (`dola-mod://<id>/index.js`), so the same file can back
// several mods with different manifests. That keeps ten placeholder tools cheap to
// ship without ten near-identical bundles.
// ---------------------------------------------------------------------------

import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Icon, SettingRow, Switch, toast } from './host'

/** `document.currentScript` is only available while this file evaluates. */
const SCRIPT_SRC = (document.currentScript as HTMLScriptElement | null)?.src ?? ''

function selfIdentity(): { id: string; name: string } {
  let id = ''
  try {
    if (SCRIPT_SRC) id = new URL(SCRIPT_SRC).hostname
  } catch {
    /* not loaded through dola-mod:// */
  }
  if (!id) id = (window as unknown as { __TEST_MOD_ID__?: string }).__TEST_MOD_ID__ ?? 'test'
  return { id, name: id.replace(/^test/i, 'Test') }
}

const SELF = selfIdentity()

function ShellPage(): JSX.Element {
  const [count, setCount] = useState(0)
  const title = SELF.name
  return (
    <div className="page" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="hstack" style={{ gap: 12, alignItems: 'center' }}>
        <span
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 48,
            height: 48,
            borderRadius: 14,
            background: 'color-mix(in srgb, var(--md-primary) 14%, transparent)',
            color: 'var(--md-primary)'
          }}
        >
          <Icon name="widgets" size={26} />
        </span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
          <div className="tiny muted">测试用空壳模块 · id: {SELF.id}</div>
        </div>
      </div>

      <div className="set-card" style={{ padding: 16 }}>
        <p style={{ margin: 0, lineHeight: 1.7 }}>
          这是一个用于验证插件系统的占位工具。它没有实际功能，用来测试侧边栏排序、
          首页快捷方式布局、首次安装引导与二级设置页。
        </p>
      </div>

      <div className="hstack" style={{ gap: 10 }}>
        <Button variant="filled" onClick={() => setCount((n) => n + 1)}>
          点击次数 {count}
        </Button>
        <Button variant="text" onClick={() => toast.success(`${title} 的提示消息`)}>
          弹一个提示
        </Button>
      </div>

      <div className="tiny muted">
        入口脚本：<span className="mono">{SCRIPT_SRC || '(unknown)'}</span>
      </div>
    </div>
  )
}

function ShellSettings(): JSX.Element {
  const [on, setOn] = useState(true)
  return (
    <>
      <h2 className="set-section-title">
        <Icon name="settings" size={20} /> {SELF.name} 设置
      </h2>
      <p className="set-section-desc">用于验证「设置 → 工具 → 设置」的二级页面。</p>
      <div className="set-card">
        <SettingRow title="示例开关" desc="仅用于展示控件，不影响任何行为">
          <Switch checked={on} onChange={setOn} />
        </SettingRow>
        <SettingRow title="模块标识" desc="这个空壳包自己的 id">
          <span className="mono tiny">{SELF.id}</span>
        </SettingRow>
      </div>
    </>
  )
}

interface ModModule {
  mount: (c: HTMLElement) => () => void
  mountSettings: (c: HTMLElement) => () => void
}

export function mount(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(ShellPage))
  return () => root.unmount()
}

export function mountSettings(container: HTMLElement): () => void {
  const root = createRoot(container)
  root.render(createElement(ShellSettings))
  return () => root.unmount()
}

const registry = ((window as unknown as { __DOLA_MODS__?: Record<string, ModModule> }).__DOLA_MODS__ ??= {})
registry[SELF.id] = { mount, mountSettings }
