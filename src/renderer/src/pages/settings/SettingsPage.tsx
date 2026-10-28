import { useEffect, useMemo, useState } from 'react'
import type { AIChatResult, AIStatus, AppInfo, AppUpdateInfo, CoreUpdateInfo, Settings, SettingsPatch, SyncStatus } from '@shared/types'
import { useApp } from '../../state/app'
import { useTheme } from '../../theme/store'
import { Button, Dialog, IconButton, Segmented, Select, SettingRow, Slider, Spinner, Switch, TextArea, TextInput } from '../../ui/controls'
import { Icon, type IconName } from '../../ui/Icon'
import { toast } from '../../ui/toast'
import { ToolsSection } from './ToolsSection'
import { SyncScopeDialog } from './SyncScopeDialog'
import { fmtDate } from '../../ui/format'
import { APP_NAME, APP_NAME_CN, APP_VERSION_LABEL, GITHUB_REPO } from '@shared/version'
import { THEME_PRESETS, presetById } from '@shared/presets'
import { DEFAULT_READER_FONT_FAMILY, DEFAULT_READER_FONT_ID, SYSTEM_READING_STACK } from '@shared/fonts'
import { applyAppFont, installFontFaces, resolveReadingFamily } from '../../lib/fonts'

type Section = 'appearance' | 'ai' | 'sync' | 'proxy' | 'tools' | 'general' | 'about'

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '外观与取色', icon: 'palette' },
  { id: 'ai', label: 'AI 助手', icon: 'autoAi' },
  { id: 'sync', label: 'WebDAV 同步', icon: 'cloudSync' },
  { id: 'proxy', label: '代理', icon: 'proxy' },
  { id: 'tools', label: '工具', icon: 'extension' },
  { id: 'general', label: '通用', icon: 'tune' },
  { id: 'about', label: '关于', icon: 'info' }
]

export function SettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const themeSet = useTheme((s) => s.setSettings)
  const refreshTheme = useTheme((s) => s.refresh)
  const [section, setSection] = useState<Section>('appearance')
  const [saving, setSaving] = useState(false)

  const patch = async (p: SettingsPatch): Promise<void> => {
    if (!settings) return
    setSaving(true)
    try {
      const next = await window.api.settings.patch(p)
      setSettings(next)
      themeSet(next)
      await refreshTheme(true)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>
            <Icon name="settings" size={22} /> 设置
          </h1>
        </div>
        <div className="page-body">
          <div className="hstack" style={{ gap: 10 }}>
            <Spinner /> <span className="muted">正在加载设置…</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page settings-page">
      <aside className="settings-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`snav ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            <Icon name={s.icon} size={19} />
            {s.label}
          </button>
        ))}
        <span className="spacer" />
        <div className="hstack tiny muted" style={{ padding: '8px 12px', gap: 6 }}>
          {saving ? <Spinner size={12} /> : <Icon name="checkCircle" size={13} />}
          {saving ? '保存中…' : '已自动保存'}
        </div>
      </aside>

      <div className="settings-content">
        <div className="settings-content-inner">
          {section === 'appearance' && <AppearanceSection settings={settings} patch={patch} />}
          {section === 'ai' && <AiSection settings={settings} patch={patch} />}
          {section === 'sync' && <SyncSection settings={settings} patch={patch} />}
          {section === 'proxy' && <ProxySection settings={settings} patch={patch} />}
          {section === 'tools' && <ToolsSection />}
          {section === 'general' && <GeneralSection settings={settings} patch={patch} />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  )
}

/* ================================================================== */
/* Appearance                                                          */
/* ================================================================== */
function AppearanceSection({ settings, patch }: { settings: Settings; patch: (p: SettingsPatch) => Promise<void> }): JSX.Element {
  const monet = useTheme((s) => s.monet)
  const a = settings.appearance
  const [customSeed, setCustomSeed] = useState(a.customSeed)
  const [palette, setPalette] = useState<string[]>([])

  useEffect(() => setPalette(monet.palette), [monet.palette])
  useEffect(() => setCustomSeed(a.customSeed), [a.customSeed])

  const choosePreset = (id: string): void => {
    const preset = presetById(id)
    if (!preset) return
    setCustomSeed(preset.seed)
    void patch({ appearance: { preset: id, seedSource: 'custom', monet: false, customSeed: preset.seed } })
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="palette" size={20} /> 外观与取色
      </h2>
      <p className="set-section-desc">
        选择一套内置的 Material You 配色，或让莫奈（Monet）从桌面壁纸中提取主色生成主题。
      </p>

      <div className="set-card">
        <div className="preset-head">
          <div>
            <div className="set-row-title">主题配色</div>
            <div className="set-row-desc">点击色卡即可全局换色，默认「多拉紫」</div>
          </div>
          <span className="badge">{presetById(a.preset)?.name ?? '自定义'}</span>
        </div>
        <div className="preset-grid">
          {THEME_PRESETS.map((p) => {
            const active = a.preset === p.id && !a.monet
            return (
              <button
                key={p.id}
                className={`preset-card ${active ? 'active' : ''}`}
                onClick={() => choosePreset(p.id)}
                title={`${p.name} · ${p.seed}`}
                aria-pressed={active}
              >
                <span className="preset-swatches" aria-hidden="true">
                  <i style={{ background: p.seed }} />
                  <i style={{ background: `color-mix(in srgb, ${p.seed} 62%, #ffffff)` }} />
                  <i style={{ background: `color-mix(in srgb, ${p.seed} 28%, #ffffff)` }} />
                </span>
                <span className="preset-meta">
                  <span className="preset-name">{p.name}</span>
                  <span className="preset-en">{p.en}</span>
                </span>
                {active ? (
                  <span className="preset-check">
                    <Icon name="check" size={14} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <div className="set-card">
        <SettingRow title="主题模式" desc="浅色 / 深色 / 跟随系统">
          <Segmented
            value={a.themeMode}
            onChange={(v) => void patch({ appearance: { themeMode: v as 'system' | 'light' | 'dark' } })}
            options={[
              { value: 'light', icon: 'lightMode', label: '浅色' },
              { value: 'dark', icon: 'darkMode', label: '深色' },
              { value: 'system', icon: 'contrast', label: '跟随系统' }
            ]}
          />
        </SettingRow>
        <SettingRow title="莫奈取色" desc="从桌面壁纸采样，生成跟随壁纸的 Material You 配色">
          <Switch
            checked={a.monet}
            onChange={(v) => void patch({ appearance: { monet: v, ...(v ? { seedSource: 'auto' } : {}) } })}
          />
        </SettingRow>
        <SettingRow title="取色来源" desc="自动优先使用壁纸，找不到时使用系统主题色">
          <Select
            value={a.seedSource}
            onChange={(v) => {
              const seed = v as typeof a.seedSource
              void patch({
                appearance: {
                  seedSource: seed,
                  ...(seed === 'custom'
                    ? { monet: false, preset: a.preset, customSeed: presetById(a.preset)?.seed ?? a.customSeed }
                    : {})
                }
              })
            }}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'wallpaper', label: '壁纸' },
              { value: 'accent', label: '系统强调色' },
              { value: 'custom', label: '预设 / 自定义' }
            ]}
          />
        </SettingRow>
        {a.seedSource === 'custom' ? (
          <SettingRow title="自定义种子色" desc="在预设之外输入任意 #RRGGBB">
            <div className="hstack" style={{ gap: 8 }}>
              <input
                type="color"
                value={customSeed}
                onChange={(e) => setCustomSeed(e.target.value)}
                style={{ width: 44, height: 32, border: 'none', background: 'transparent', cursor: 'pointer' }}
              />
              <div style={{ width: 150 }}>
                <TextInput
                  value={customSeed}
                  onChange={(e) => setCustomSeed(e.target.value)}
                  onBlur={() => void patch({ appearance: { customSeed, preset: 'custom', monet: false } })}
                />
              </div>
            </div>
          </SettingRow>
        ) : null}
        <SettingRow title="圆角" desc={`${a.roundness}px · 全局卡片与控件圆角`}>
          <div style={{ width: 200 }}>
            <Slider value={a.roundness} min={4} max={28} onChange={(v) => void patch({ appearance: { roundness: v } })} />
          </div>
        </SettingRow>
        <SettingRow title="减少动画" desc="降低过渡动画，适合低性能设备">
          <Switch checked={a.reduceMotion} onChange={(v) => void patch({ appearance: { reduceMotion: v } })} />
        </SettingRow>
        <SettingRow title="重新取色" desc="壁纸更换后点此刷新">
          <Button variant="tonal" icon="refresh" onClick={() => void useTheme.getState().refresh(true)}>
            刷新取色
          </Button>
        </SettingRow>
      </div>

      <h3 className="set-section-title" style={{ fontSize: 14 }}>
        当前配色预览
      </h3>
      <div className="set-card" style={{ padding: 16 }}>
        <div className="hstack" style={{ gap: 12, flexWrap: 'wrap' }}>
          {[
            ['primary', monet.light.primary],
            ['primary-container', monet.light.primaryContainer],
            ['secondary', monet.light.secondary],
            ['tertiary', monet.light.tertiary],
            ['surface', monet.light.surface],
            ['surface-container', monet.light.surfaceContainer],
            ['outline', monet.light.outline]
          ].map(([label, color]) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  background: color,
                  boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.08)'
                }}
              />
              <div className="tiny muted" style={{ marginTop: 4, fontSize: 10 }}>
                {label}
              </div>
            </div>
          ))}
        </div>
        {palette.length ? (
          <>
            <div className="tiny muted" style={{ marginTop: 14, marginBottom: 6 }}>
              壁纸采样色
            </div>
            <div className="palette-strip">
              {palette.map((c, i) => (
                <span key={i} className="sw" style={{ background: c }} title={c} />
              ))}
            </div>
          </>
        ) : (
          <div className="tiny muted" style={{ marginTop: 12 }}>
            当前使用种子色 {monet.seed}（{monet.source}）。
          </div>
        )}
      </div>

      {/* font selection lives here: it is part of the app's look */}
      <FontSection settings={settings} patch={patch} />
    </>
  )
}

/* ================================================================== */
/* Fonts (shown inside 外观与取色)                                      */
/* ================================================================== */
function FontSection({
  settings,
  patch
}: {
  settings: Settings
  patch: (p: SettingsPatch) => Promise<void>
}): JSX.Element {
  const rd = settings.reader
  const fonts = useApp((s) => s.fonts)
  const setFonts = useApp((s) => s.setFonts)
  const setReadingFamily = useApp((s) => s.setReadingFamily)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [fontsDir, setFontsDir] = useState('')

  const refresh = async (): Promise<void> => {
    const list = await window.api.fonts.list()
    setFonts(list.fonts)
    setFontsDir(list.dir)
    installFontFaces(list.fonts)
    setReadingFamily(resolveReadingFamily(settings.reader.fontFamily, list.fonts))
    applyAppFont(settings.reader.fontFamily, list.fonts)
  }

  useEffect(() => {
    void refresh().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep the resolved family in sync when the selection changes
  useEffect(() => {
    setReadingFamily(resolveReadingFamily(rd.fontFamily, fonts))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rd.fontFamily, fonts])

  const choose = async (id: string): Promise<void> => {
    await patch({ reader: { fontFamily: id } })
    setReadingFamily(resolveReadingFamily(id, fonts))
    applyAppFont(id, fonts)
  }

  const importFromDialog = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.fonts.import()
      if (res.imported.length) {
        toast.success(`已导入 ${res.imported.length} 个字体`)
        await refresh()
        await choose(res.imported[0].id)
      } else if (res.skipped.length) {
        toast.error(res.skipped[0].reason)
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const importPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    setBusy(true)
    try {
      const res = await window.api.fonts.importPaths(paths)
      if (res.imported.length) {
        toast.success(`已导入 ${res.imported.length} 个字体`)
        await refresh()
        await choose(res.imported[0].id)
      } else if (res.skipped.length) {
        toast.error(res.skipped[0].reason)
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setRemoving(id)
    try {
      const res = await window.api.fonts.remove(id)
      if (!res.ok) {
        toast.error(res.reason ?? '删除失败')
        return
      }
      toast.success('已删除字体')
      await refresh()
      if (rd.fontFamily === id) await choose(DEFAULT_READER_FONT_ID)
    } finally {
      setRemoving(null)
    }
  }

  const previewSampler = fonts.find((f) => f.id === rd.fontFamily)
  const previewFamily = previewSampler
    ? `'${previewSampler.builtin ? DEFAULT_READER_FONT_FAMILY : previewSampler.name}', serif`
    : SYSTEM_READING_STACK

  return (
    <>
      <h3 className="set-section-title" style={{ fontSize: 14 }}>
        <Icon name="formatSize" size={18} /> 字体
      </h3>
      <p className="set-section-desc">
        字体对<strong>整个软件</strong>生效（界面、书库与阅读器）。默认字体为内置的 JetBrains Maple Mono NF。
      </p>

      <div className="set-card">
        <div className="preset-head">
          <div>
            <div className="set-row-title">字体</div>
            <div className="set-row-desc">点击即可全局应用，右侧为实际字形的预览</div>
          </div>
          <div className="hstack" style={{ gap: 6 }}>
            <Button variant="tonal" icon="upload" onClick={() => void importFromDialog()} disabled={busy}>
              {busy ? '导入中…' : '导入字体'}
            </Button>
            <IconButton
              icon="folder"
              label="打开字体目录"
              onClick={() => void window.api.fonts.reveal()}
            />
          </div>
        </div>

        <div style={{ padding: '0 20px 12px' }}>
          <div className="font-list">
            {fonts.length === 0 ? (
              <div className="tiny muted" style={{ padding: 10 }}>
                正在读取字体…
              </div>
            ) : null}
            {fonts.map((f) => {
              const active = f.id === rd.fontFamily
              const family = f.builtin ? DEFAULT_READER_FONT_FAMILY : f.name
              return (
                <button
                  key={f.id}
                  className={`font-row ${active ? 'active' : ''}`}
                  onClick={() => void choose(f.id)}
                  aria-pressed={active}
                >
                  <span className="font-preview" style={{ fontFamily: `'${family}', serif` }}>
                    永 Aa
                  </span>
                  <span className="font-meta">
                    <span className="font-name">
                      {f.name}
                      {f.builtin ? (
                        <span className="badge" style={{ marginLeft: 6, height: 18, fontSize: 10 }}>
                          内置
                        </span>
                      ) : null}
                    </span>
                    <span className="font-sub">
                      {f.format.toUpperCase()} · {fmtSize(f.size ?? 0)}
                      {f.builtin ? ' · 含中日韩字形' : ''}
                    </span>
                  </span>
                  <span className="font-actions">
                    {active ? <Icon name="check" size={16} /> : null}
                    {f.managed ? (
                      <IconButton
                        icon="delete"
                        small
                        label="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          void remove(f.id)
                        }}
                      />
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>

          <div
            className={`font-drop ${over ? 'over' : ''}`}
            style={{ marginTop: 10 }}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(false)
              const paths: string[] = []
              for (const file of Array.from(e.dataTransfer.files)) {
                const p = (file as File & { path?: string }).path
                if (p) paths.push(p)
              }
              void importPaths(paths)
            }}
          >
            把 .ttf / .otf / .woff2 字体文件拖到这里（或点右上角「导入字体」）
            {fontsDir ? <span className="tiny muted"> · {fontsDir}</span> : null}
          </div>

          <div className="font-sample" style={{ fontFamily: previewFamily }}>
            春江潮水连海平，海上明月共潮生。
            <br />
            潋滟随波千万里，何处春江无月明。
            <br />
            这是一段用于预览当前字体的正文，包含标点、数字 1234567890 与英文。
            <span className="latin" style={{ fontFamily: previewFamily }}>
              The quick brown fox jumps over the lazy dog. 0123456789 {'{}[]()<>'}
            </span>
          </div>
        </div>
      </div>

      <div className="set-card">
        <SettingRow title="字号" desc={`${rd.fontSize}px · 阅读器正文文字大小`}>
          <div style={{ width: 190 }}>
            <Slider
              value={rd.fontSize}
              min={13}
              max={28}
              onChange={(v) => void patch({ reader: { fontSize: v } })}
            />
          </div>
        </SettingRow>
        <SettingRow title="行距" desc={`${rd.lineHeight.toFixed(2)} 倍行高`}>
          <div style={{ width: 190 }}>
            <Slider
              value={rd.lineHeight}
              min={1.3}
              max={2.4}
              step={0.05}
              onChange={(v) => void patch({ reader: { lineHeight: v } })}
            />
          </div>
        </SettingRow>
        <SettingRow title="打开字体目录" desc="也可以把字体文件直接放进这个目录">
          <Button variant="outlined" icon="folder" onClick={() => void window.api.fonts.reveal()}>
            打开目录
          </Button>
        </SettingRow>
      </div>

      <p className="tiny muted">
        提示：内置字体已做中文子集化（约 5MB），不影响排版；自定义字体请优先使用 .ttf / .woff2，
        删除字体不会影响已导入的书籍。{removing ? ' · 处理中…' : ''}
      </p>
    </>
  )
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ================================================================== */
/* AI                                                                  */
/* ================================================================== */
function AiSection({ settings, patch }: { settings: Settings; patch: (p: SettingsPatch) => Promise<void> }): JSX.Element {
  const ai = settings.ai
  const [draft, setDraft] = useState({
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    temperature: ai.temperature,
    maxTokens: ai.maxTokens,
    systemPrompt: ai.systemPrompt,
    seriesPrompt: ai.seriesPrompt
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<AIChatResult | null>(null)
  const [status, setStatus] = useState<AIStatus | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  useEffect(() => {
    void window.api.ai.status().then(setStatus).catch(() => undefined)
  }, [])

  const save = (): void => {
    void patch({ ai: draft })
    toast.success('AI 配置已保存')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      await patch({ ai: draft })
      const res = await window.api.ai.test()
      setTestResult(res)
      if (res.ok) toast.success(`连接成功 · ${res.ms} ms`)
      else toast.error(res.error ?? '连接失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="autoAi" size={20} /> AI 助手
      </h2>
      <p className="set-section-desc">
        兼容 OpenAI 格式的任意服务（OpenAI / DeepSeek / 通义 / 本地 Ollama 等）。用于书库自动归类、阅读辅助与判断。
      </p>

      <div className="set-card">
        <SettingRow title="启用 AI" desc={status?.configured ? '已配置，可用于归类与对话' : '尚未配置 API Key'}>
          <Switch checked={ai.enabled} onChange={(v) => void patch({ ai: { enabled: v } })} />
        </SettingRow>
        <div className="set-grid">
          <div className="full">
            <TextInput
              label="API URL"
              placeholder="https://api.deepseek.com/v1"
              value={draft.baseUrl}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              hint="需包含 /v1，程序会自动追加 /chat/completions"
              prefixIcon="api"
            />
          </div>
          <div className="full">
            <TextInput
              label="API Key"
              placeholder="sk-..."
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              prefixIcon="key"
              suffix={
                <IconButton
                  icon={showKey ? 'visibilityOff' : 'visibility'}
                  small
                  label={showKey ? '隐藏' : '显示'}
                  onClick={() => setShowKey((v) => !v)}
                />
              }
            />
          </div>
          <TextInput
            label="模型"
            placeholder="deepseek-chat"
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          />
          <TextInput
            label="最大输出 Tokens"
            type="number"
            value={String(draft.maxTokens)}
            onChange={(e) => setDraft((d) => ({ ...d, maxTokens: Number(e.target.value) }))}
          />
          <div className="full">
            <div className="hstack" style={{ gap: 12 }}>
              <span className="tiny muted" style={{ width: 76 }}>
                温度 {draft.temperature.toFixed(2)}
              </span>
              <Slider
                value={draft.temperature}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setDraft((d) => ({ ...d, temperature: v }))}
              />
            </div>
          </div>
          <div className="full">
            <TextArea
              label="系统提示词"
              value={draft.systemPrompt}
              onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
              style={{ minHeight: 90 }}
              hint="用于阅读问答的默认人设"
            />
          </div>
          <div className="full">
            <TextArea
              label="AI 归类提示词"
              value={draft.seriesPrompt}
              onChange={(e) => setDraft((d) => ({ ...d, seriesPrompt: e.target.value }))}
              style={{ minHeight: 110 }}
              hint="根据书名判断是否属于同一系列/同一部作品，并输出 JSON"
            />
          </div>
        </div>
        <div style={{ padding: '0 20px 18px' }} className="hstack">
          <Button variant="filled" icon="save" onClick={save}>
            保存配置
          </Button>
          <Button variant="tonal" icon="bolt" onClick={() => void test()} loading={testing}>
            测试连接
          </Button>
          <Button variant="text" icon="aiChat" onClick={() => setChatOpen(true)}>
            试聊一句
          </Button>
          <span className="spacer" />
          {status?.lastError ? <span className="tiny" style={{ color: 'var(--md-error)' }}>{status.lastError}</span> : null}
        </div>
        {testResult ? (
          <div style={{ padding: '0 20px 18px' }}>
            <div className="card-filled" style={{ padding: 12, fontSize: 12.5, whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>
              {testResult.ok ? testResult.content : testResult.error}
            </div>
          </div>
        ) : null}
      </div>

      <ChatTester open={chatOpen} onClose={() => setChatOpen(false)} />
    </>
  )
}

function ChatTester({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [msgs, setMsgs] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async (): Promise<void> => {
    if (!text.trim()) return
    const next = [...msgs, { role: 'user' as const, content: text.trim() }]
    setMsgs(next)
    setText('')
    setBusy(true)
    try {
      const res = await window.api.ai.chat(next.map((m) => ({ role: m.role, content: m.content })))
      setMsgs([...next, { role: 'assistant', content: res.ok ? res.content : `⚠ ${res.error}` }])
    } catch (e) {
      setMsgs([...next, { role: 'assistant', content: `⚠ ${String(e)}` }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="AI 试聊"
      icon="aiChat"
      footer={
        <Button variant="text" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="chat-wrap" style={{ height: 300 }}>
        <div className="chat-scroll">
          {msgs.length === 0 ? <div className="chat-msg system">发一句话验证配置是否可用</div> : null}
          {msgs.map((m, i) => (
            <div key={i} className={`chat-msg ${m.role}`}>
              {m.content}
            </div>
          ))}
          {busy ? (
            <div className="chat-msg assistant">
              <Spinner size={14} />
            </div>
          ) : null}
        </div>
        <div className="chat-input-row">
          <div style={{ flex: 1 }}>
            <TextInput
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) void send()
              }}
              placeholder="输入消息…"
            />
          </div>
          <Button variant="filled" icon="send" onClick={() => void send()} loading={busy}>
            发送
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/* ================================================================== */
/* Sync                                                                */
/* ================================================================== */
function SyncSection({ settings, patch }: { settings: Settings; patch: (p: SettingsPatch) => Promise<void> }): JSX.Element {
  const s = settings.sync
  const [draft, setDraft] = useState({ url: s.url, username: s.username, password: s.password, remoteDir: s.remoteDir })
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [scopeOpen, setScopeOpen] = useState(false)

  useEffect(() => {
    void window.api.sync.status().then(setStatus).catch(() => undefined)
  }, [])

  const save = (): void => {
    void patch({ sync: draft })
    toast.success('同步配置已保存')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      await patch({ sync: draft })
      const r = await window.api.sync.test()
      setResult(r)
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } finally {
      setTesting(false)
    }
  }

  const run = async (): Promise<void> => {
    setSyncing(true)
    try {
      await patch({ sync: draft })
      const st = await window.api.sync.run()
      setStatus(st)
      const msg = st.lastResult?.message ?? '同步完成'
      toast[st.lastResult?.ok ? 'success' : 'error'](msg)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="cloudSync" size={20} /> WebDAV 同步
      </h2>
      <p className="set-section-desc">
        为后续多端同步做准备：把设置与书库元数据备份到自己的 WebDAV（坚果云 / Nextcloud / 群晖等）。
      </p>
      <div className="set-card">
        <SettingRow title="启用同步" desc={status?.configured ? '已配置服务器' : '未配置'}>
          <Switch checked={s.enabled} onChange={(v) => void patch({ sync: { enabled: v } })} />
        </SettingRow>
        <div className="set-grid">
          <div className="full">
            <TextInput
              label="WebDAV 地址"
              placeholder="https://dav.jianguoyun.com/dav/"
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              prefixIcon="cloud"
            />
          </div>
          <TextInput
            label="用户名"
            value={draft.username}
            onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
            prefixIcon="wallet"
          />
          <TextInput
            label="密码 / 应用密码"
            type="password"
            value={draft.password}
            onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
            prefixIcon="lock"
          />
          <div className="full">
            <TextInput
              label="远程目录"
              placeholder="/Dola Toolkit"
              value={draft.remoteDir}
              onChange={(e) => setDraft((d) => ({ ...d, remoteDir: e.target.value }))}
              prefixIcon="folderData"
            />
          </div>
          {/* 同步内容改为弹窗选择，可勾选设置 / 书库 / 各插件的数据 */}
          <div>
            <div className="tiny muted" style={{ marginBottom: 6 }}>
              同步内容
            </div>
            <Button variant="outlined" icon="cloudSync" onClick={() => setScopeOpen(true)}>
              {syncScopeLabel(s.items)}
            </Button>
          </div>
          <div className="hstack" style={{ alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div className="tiny muted">自动同步</div>
              <Switch checked={s.autoSync} onChange={(v) => void patch({ sync: { autoSync: v } })} />
            </div>
          </div>
        </div>
        <SyncScopeDialog
          open={scopeOpen}
          onClose={() => setScopeOpen(false)}
          value={s.items ?? defaultItems(s.scope)}
          onConfirm={(items) => {
            void (async () => {
              // persist first so 自动同步 uses the same selection, then run
              await patch({ sync: { items, scope: scopeFor(items) } })
              setScopeOpen(false)
              await run()
            })()
          }}
          busy={syncing}
        />
        <div style={{ padding: '0 20px 18px' }} className="hstack">
          <Button variant="filled" icon="save" onClick={save}>
            保存
          </Button>
          <Button variant="tonal" icon="bolt" onClick={() => void test()} loading={testing}>
            测试连接
          </Button>
          <Button variant="outlined" icon="cloudUpload" onClick={() => void run()} loading={syncing}>
            立即同步
          </Button>
          <span className="spacer" />
          <span className="tiny muted">上次同步：{status?.lastSyncAt ? fmtDate(status.lastSyncAt) : '从未'}</span>
        </div>
        {result ? (
          <div style={{ padding: '0 20px 18px' }}>
            <div
              className="tiny"
              style={{ color: result.ok ? 'var(--md-primary)' : 'var(--md-error)' }}
            >
              {result.message}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

/* ================================================================== */
/* Proxy                                                               */
/* ================================================================== */
function ProxySection({ settings, patch }: { settings: Settings; patch: (p: SettingsPatch) => Promise<void> }): JSX.Element {
  const p = settings.proxy
  return (
    <>
      <h2 className="set-section-title">
        <Icon name="proxy" size={20} /> 代理
      </h2>
      <p className="set-section-desc">这里配置的是所有节点共享的内核参数。</p>
      <div className="set-card">
        <div className="set-grid" style={{ paddingTop: 16 }}>
          <TextInput
            label="混合端口 (HTTP/SOCKS)"
            type="number"
            value={String(p.mixedPort)}
            onChange={(e) => void patch({ proxy: { mixedPort: Number(e.target.value) } })}
            prefixIcon="lan"
          />
          <Select
            label="默认内核"
            value={p.defaultEngine}
            onChange={(v) => void patch({ proxy: { defaultEngine: v as typeof p.defaultEngine } })}
            options={[
              { value: 'xray', label: 'Xray' },
              { value: 'mihomo', label: 'Mihomo' },
              { value: 'singbox', label: 'Sing-box' }
            ]}
          />
          <Select
            label="日志等级"
            value={p.logLevel}
            onChange={(v) => void patch({ proxy: { logLevel: v as typeof p.logLevel } })}
            options={[
              { value: 'error', label: 'error' },
              { value: 'warn', label: 'warn' },
              { value: 'info', label: 'info' },
              { value: 'debug', label: 'debug' }
            ]}
          />
          <div />
          <div className="full">
            <TextInput
              label="系统代理绕过列表"
              value={p.bypass}
              onChange={(e) => void patch({ proxy: { bypass: e.target.value } })}
              hint="使用分号分隔"
            />
          </div>
        </div>
        <SettingRow title="允许局域网连接" desc="其他设备可通过本机端口使用代理">
          <Switch checked={p.allowLan} onChange={(v) => void patch({ proxy: { allowLan: v } })} />
        </SettingRow>
        <SettingRow title="接管系统代理" desc="启动时写入 Windows 系统代理，停止时恢复">
          <Switch checked={p.systemProxy} onChange={(v) => void patch({ proxy: { systemProxy: v } })} />
        </SettingRow>
        <SettingRow title="启动时自动连接" desc="打开 Dola Toolkit 后自动启用代理">
          <Switch checked={p.autoStart} onChange={(v) => void patch({ proxy: { autoStart: v } })} />
        </SettingRow>
        <SettingRow title="流量嗅探" desc="识别域名，改善分流准确性">
          <Switch checked={p.sniffing} onChange={(v) => void patch({ proxy: { sniffing: v } })} />
        </SettingRow>
        <SettingRow title="启用 IPv6" desc="关闭可避免部分网络异常">
          <Switch checked={p.ipv6} onChange={(v) => void patch({ proxy: { ipv6: v } })} />
        </SettingRow>
        <SettingRow title="异常自动重启" desc="内核意外退出时最多重试 3 次">
          <Switch checked={p.autoRestart} onChange={(v) => void patch({ proxy: { autoRestart: v } })} />
        </SettingRow>
      </div>
    </>
  )
}

/* ================================================================== */
/* General                                                             */
/* ================================================================== */
function GeneralSection({ settings, patch }: { settings: Settings; patch: (p: SettingsPatch) => Promise<void> }): JSX.Element {
  const g = settings.general
  const [confirmReset, setConfirmReset] = useState(false)
  return (
    <>
      <h2 className="set-section-title">
        <Icon name="tune" size={20} /> 通用
      </h2>
      <div className="set-card">
        <SettingRow
          title="关闭时最小化到后台"
          desc={
            g.closeToTrayAsked
              ? '保持代理与同步继续运行；关闭时按此开关执行，不再询问'
              : '保持代理与同步继续运行；首次关闭时会先询问一次'
          }
        >
          <Switch
            checked={g.closeToTray}
            onChange={(v) => void patch({ general: { closeToTray: v, closeToTrayAsked: true } })}
          />
        </SettingRow>
        <SettingRow title="关闭确认" desc="重新开启「最小化到托盘还是退出」的询问">
          <Button
            variant="tonal"
            icon="refresh"
            disabled={!g.closeToTrayAsked}
            onClick={() => {
              void patch({ general: { closeToTrayAsked: false } })
              toast.info('下次关闭时会再次询问')
            }}
          >
            {g.closeToTrayAsked ? '重新开启询问' : '已开启'}
          </Button>
        </SettingRow>
        <SettingRow title="开机自启" desc="登录 Windows 后自动启动 Dola Toolkit">
          <Switch checked={g.launchAtLogin} onChange={(v) => void patch({ general: { launchAtLogin: v } })} />
        </SettingRow>
        <SettingRow
          title="更新下载渠道"
          desc={
            g.downloadChannel === 'github'
              ? 'GitHub 官方渠道 —— 最新版本，但国内可能较慢或连接不稳定'
              : '国内镜像站 —— 速度快，但版本可能不是最新'
          }
        >
          <Segmented
            value={g.downloadChannel}
            onChange={(v) => void patch({ general: { downloadChannel: v as 'github' | 'mirror' } })}
            options={[
              { value: 'github', icon: 'cloud', label: 'GitHub 官方' },
              { value: 'mirror', icon: 'bolt', label: '国内镜像' }
            ]}
          />
        </SettingRow>
        <SettingRow title="重置全部设置" desc="恢复默认配置，不影响书库与节点">
          <Button variant="danger" icon="restore" onClick={() => setConfirmReset(true)}>
            重置
          </Button>
        </SettingRow>
      </div>
      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="重置设置"
        icon="warning"
        width="slim"
        footer={
          <>
            <Button variant="text" onClick={() => setConfirmReset(false)}>
              取消
            </Button>
            <Button
              variant="filled"
              onClick={async () => {
                const next = await window.api.settings.reset()
                useApp.getState().setSettings(next)
                useTheme.getState().setSettings(next)
                await useTheme.getState().refresh(true)
                setConfirmReset(false)
                toast.success('已恢复默认设置')
              }}
            >
              确认重置
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>将恢复默认的外观、AI、同步与代理设置。书库与节点数据不受影响。</p>
      </Dialog>
    </>
  )
}

/* ================================================================== */
/* About                                                               */
/* ================================================================== */
function AboutSection(): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.app.info().then(setInfo).catch(() => undefined)
  }, [])
  const rows = useMemo(
    () => [
      ['版本', APP_VERSION_LABEL],
      ['Electron', info?.electron ?? '—'],
      ['Chromium', info?.chrome ?? '—'],
      ['Node', info?.node ?? '—'],
      ['系统', info ? `${info.platform} ${info.arch}` : '—'],
      ['数据目录', info?.userData ?? '—'],
      ['日志目录', info?.logsDir ?? '—']
    ],
    [info]
  )
  return (
    <>
      <div className="hstack" style={{ gap: 16, margin: '10px 0 18px' }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            display: 'grid',
            placeItems: 'center',
            background: 'linear-gradient(145deg, var(--md-primary), var(--md-tertiary))',
            color: 'var(--md-on-primary)',
            boxShadow: 'var(--elev-2)'
          }}
        >
          <Icon name="bookOpen" size={30} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Dola Toolkit</h1>
          <div className="tiny muted">Material You 桌面工具箱 · {APP_VERSION_LABEL}</div>
        </div>
      </div>
      <div className="set-card">
        {rows.map(([k, v]) => (
          <div className="set-item" key={k}>
            <div className="set-item-main">
              <div className="set-item-title" style={{ fontWeight: 500 }}>
                {k}
              </div>
            </div>
            <span className="mono tiny muted" style={{ maxWidth: 420, textAlign: 'right', wordBreak: 'break-all' }}>
              {v}
            </span>
          </div>
        ))}
        <div className="set-item">
          <div className="set-item-main">
            <div className="set-item-title" style={{ fontWeight: 500 }}>
              快捷操作
            </div>
          </div>
          <div className="hstack" style={{ gap: 8 }}>
            <Button variant="tonal" size="sm" icon="folderData" onClick={() => void window.api.app.openLogs()}>
              打开日志
            </Button>
            <Button
              variant="text"
              size="sm"
              icon="open"
              onClick={() => void window.api.app.openExternal(GITHUB_REPO)}
            >
              GitHub
            </Button>
          </div>
        </div>
      </div>
      <p className="tiny muted" style={{ lineHeight: 1.7 }}>
        Dola Toolkit 使用 Electron + React 构建，图标来自 Material Symbols（Apache-2.0），
        代理内核为 Xray / Mihomo / Sing-box（各自遵循其原始许可）。
      </p>
      <UpdateSection />
    </>
  )
}

/* ================================================================== */
/* 版本更新                                                             */
/* ================================================================== */
function UpdateSection(): JSX.Element {
  const [appInfo, setAppInfo] = useState<AppUpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [percent, setPercent] = useState<number | null>(null)
  const [installerPath, setInstallerPath] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      const a = await window.api.app.checkAppUpdate()
      setAppInfo(a)
      if (!a.error && !a.updateAvailable) toast.success(`已是最新版本 ${a.current}`)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    const off = window.api.app.onUpdateProgress((p) => {
      // core downloads are reported on the proxy page now
      if (p.kind !== 'app') return
      if (p.state === 'downloading') setPercent(p.percent)
      else setPercent(null)
      if (p.state === 'error' && p.message) toast.error(p.message)
    })
    void check()
    return off
  }, [])

  const downloadAndInstall = async (): Promise<void> => {
    const res = await window.api.app.downloadAppUpdate()
    if (!res.ok || !res.path) {
      toast.error(res.error ?? '下载失败')
      return
    }
    setInstallerPath(res.path)
    setPercent(null)
    toast.success('下载完成，点击「安装并重启」完成更新')
  }

  const install = async (): Promise<void> => {
    if (!installerPath) return
    toast.info('即将退出并启动安装程序，请按提示完成安装')
    // the target version is remembered so the next launch can verify the result
    const res = await window.api.app.installAppUpdate(installerPath, appInfo?.latest ?? undefined)
    if (!res.ok) toast.error(res.error ?? '安装失败')
  }

  const appState = appInfo?.error
    ? appInfo.error
    : appInfo?.updateAvailable
      ? `发现新版本 ${appInfo.latest}（当前 ${appInfo.current}）`
      : appInfo
        ? `已是最新版本（${appInfo.current}）`
        : '尚未检查'

  return (
    <>
      <h2 className="set-section-title" style={{ marginTop: 24 }}>
        <Icon name="update" size={20} /> 软件更新
      </h2>
      <div className="set-card">
        <SettingRow
          title="软件版本"
          desc={
            appState +
            (appInfo?.channel === 'mirror' ? ' · 使用国内镜像站' : ' · 使用 GitHub 官方渠道')
          }
        >
          <div className="hstack" style={{ gap: 8 }}>
            <Button variant="tonal" size="sm" icon="refresh" loading={checking} onClick={() => void check()}>
              检查更新
            </Button>
            {appInfo?.updateAvailable ? (
              percent !== null ? (
                <span className="tiny mono" style={{ minWidth: 36, textAlign: 'right' }}>
                  {percent}%
                </span>
              ) : installerPath ? (
                <Button variant="filled" size="sm" icon="check" onClick={() => void install()}>
                  安装并重启
                </Button>
              ) : (
                <Button variant="filled" size="sm" icon="download" onClick={() => void downloadAndInstall()}>
                  下载更新
                </Button>
              )
            ) : null}
            <Button
              variant="text"
              size="sm"
              icon="folderData"
              onClick={() => void window.api.app.openUpdateLog()}
            >
              更新日志
            </Button>
          </div>
        </SettingRow>
        {/* a full-width bar: a two-digit percentage alone is not enough feedback for 127 MB */}
        {percent !== null ? (
          <div style={{ padding: '0 4px 10px' }}>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: 'color-mix(in srgb, var(--md-on-surface) 12%, transparent)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: '100%',
                  background: 'var(--md-primary)',
                  transition: 'width 200ms linear'
                }}
              />
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>
              正在下载安装包…{percent}%
            </div>
          </div>
        ) : null}
        <SettingRow title="内核更新" desc="Xray / sing-box / Mihomo 的版本与一键更新已移至「代理」页面">
          <Button variant="text" size="sm" icon="open" onClick={() => void window.api.app.openReleases()}>
            打开发布页
          </Button>
        </SettingRow>
      </div>
    </>
  )
}


/** Default selection for a legacy `scope` value. */
function defaultItems(scope: Settings['sync']['scope']): string[] {
  if (scope === 'settings') return ['settings']
  if (scope === 'library') return ['library']
  return ['settings', 'library']
}

/** Legacy `scope` derived from a selection, kept for older builds. */
function scopeFor(items: string[]): Settings['sync']['scope'] {
  const hasSettings = items.includes('settings')
  const hasLibrary = items.includes('library')
  if (hasSettings && hasLibrary) return 'both'
  if (hasSettings) return 'settings'
  if (hasLibrary) return 'library'
  // only tool data selected: 'both' would upload the app data too, so pick the
  // narrowest legacy value and let `items` drive the actual run
  return 'settings'
}

/** Label for the 同步内容 button. */
function syncScopeLabel(items: string[] | undefined): string {
  const list = items && items.length > 0 ? items : ['settings', 'library']
  const names: string[] = []
  if (list.includes('settings')) names.push('设置')
  if (list.includes('library')) names.push('书库')
  const mods = list.filter((i) => i.startsWith('mod:')).length
  if (mods > 0) names.push(`${mods} 个插件数据`)
  return names.join(' + ') || '未选择'
}
