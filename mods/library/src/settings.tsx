// ---------------------------------------------------------------------------
// 书库 mod — settings screen
//
// This is the 书库与阅读 + 翻页 settings that used to live in the host's settings page.
// It is part of the mod now, so the options travel with the tool instead of being
// hard-coded into the shell. The host only provides the page frame and the back
// affordance (`mountSettings` in the registry).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { Icon, Segmented, Select, SettingRow, Slider, Switch, toast, useApp } from './host'

export function LibrarySettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [local, setLocal] = useState<Settings | null>(settings)

  // the store can arrive after the mod mounts
  useEffect(() => {
    if (settings) setLocal(settings)
  }, [settings])

  useEffect(() => {
    if (local) return
    void window.api.settings.get().then((s) => {
      setLocal(s)
      setSettings(s)
    })
  }, [local, setSettings])

  /**
   * Persists a slice of settings.
   *
   * The main process is the source of truth; the store is updated with the reply so the
   * rest of the app (including the reader, which reads the same store) sees the change
   * immediately.
   */
  const patch = async (p: Parameters<typeof window.api.settings.patch>[0]): Promise<void> => {
    try {
      const next = await window.api.settings.patch(p)
      setLocal(next)
      setSettings(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  if (!local) {
    return (
      <div className="stack-sm" style={{ padding: 8 }}>
        <span className="muted tiny">正在读取设置…</span>
      </div>
    )
  }

  const l = local.library
  const rd = local.reader

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="bookOpen" size={20} /> 书库与阅读
      </h2>
      <p className="set-section-desc">控制书籍导入方式、书架显示与翻页交互。</p>
      <div className="set-card">
        <SettingRow title="导入方式" desc="托管会将文件复制到 Dola Toolkit 数据目录，引用则保留原路径">
          <Select
            value={l.importMode}
            onChange={(v) => void patch({ library: { importMode: v as typeof l.importMode } })}
            options={[
              { value: 'managed', label: '托管副本' },
              { value: 'reference', label: '引用原文件' }
            ]}
          />
        </SettingRow>
        <SettingRow title="双页模式" desc="宽窗口自动双页；也可强制单页或双页">
          <Segmented
            value={l.spreadMode}
            onChange={(v) => void patch({ library: { spreadMode: v as typeof l.spreadMode } })}
            options={[
              { value: 'auto', icon: 'dualScreen', label: '自动' },
              { value: 'always', icon: 'splitscreen', label: '双页' },
              { value: 'never', icon: 'readerMode', label: '单页' }
            ]}
          />
        </SettingRow>
        <SettingRow title="封面尺寸" desc={`${l.coverWidth}px`}>
          <div style={{ width: 200 }}>
            <Slider
              value={l.coverWidth}
              min={120}
              max={260}
              step={10}
              onChange={(v) => void patch({ library: { coverWidth: v } })}
            />
          </div>
        </SettingRow>
        <SettingRow title="AI 自动归类" desc="导入后自动判断系列（需要配置 AI）">
          <Switch
            checked={l.aiAutoClassify}
            onChange={(v) => void patch({ library: { aiAutoClassify: v } })}
          />
        </SettingRow>
        <SettingRow title="默认视图">
          <Segmented
            value={l.defaultView}
            onChange={(v) => void patch({ library: { defaultView: v as typeof l.defaultView } })}
            options={[
              { value: 'grid', icon: 'grid', label: '网格' },
              { value: 'list', icon: 'list', label: '列表' }
            ]}
          />
        </SettingRow>
      </div>

      <h3 className="set-section-title" style={{ fontSize: 14 }}>
        <Icon name="bookOpen" size={18} /> 翻页
      </h3>
      <p className="set-section-desc">
        点按页面右侧 1/3 看下一页、左侧 1/3 看上一页；中间 1/3 不翻页，可正常选中文字。
      </p>
      <div className="set-card">
        <SettingRow title="翻页动画" desc="翻页时使用的过渡效果">
          <Segmented
            value={rd.flipAnimation}
            onChange={(v) => void patch({ reader: { flipAnimation: v as typeof rd.flipAnimation } })}
            options={[
              { value: 'cover', label: '仿真翻页' },
              { value: 'slide', label: '平移' },
              { value: 'curl', label: '卷曲' },
              { value: 'none', label: '无' }
            ]}
          />
        </SettingRow>
        <SettingRow
          title="启用 GPU 加速"
          desc={
            rd.gpuAcceleration
              ? '使用硬件加速渲染，动画最流畅。显卡驱动异常或画面撕裂时请关闭'
              : '已关闭硬件加速：软件渲染 + 低开销翻页，兼容性最好。更改需重启应用生效'
          }
        >
          <Switch
            checked={rd.gpuAcceleration}
            onChange={(v) => {
              void patch({ reader: { gpuAcceleration: v } })
              toast.info(v ? 'GPU 加速已开启，重启后生效' : 'GPU 加速已关闭，重启后生效')
            }}
          />
        </SettingRow>
      </div>
    </>
  )
}
