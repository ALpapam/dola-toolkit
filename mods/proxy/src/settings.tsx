// ---------------------------------------------------------------------------
// 代理 mod — 设置页
//
// The proxy options used to live in the host's settings page. They travel with the
// tool now, so the mod owns its own settings screen (opened from 设置 → 工具 → 设置).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { Button, Icon, Segmented, SettingRow, Switch, toast, useApp } from './host'

export function ProxySettingsPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [local, setLocal] = useState<Settings | null>(settings)

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

  const patch = async (p: Parameters<typeof window.api.settings.patch>[0]): Promise<void> => {
    try {
      const next = await window.api.settings.patch(p)
      setLocal(next)
      setSettings(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    }
  }

  if (!local) return <div className="tiny muted">正在读取设置……</div>

  const p = local.proxy

  return (
    <>
      <h2 className="set-section-title">
        <Icon name="proxy" size={20} /> 代理
      </h2>
      <p className="set-section-desc">内核、系统代理与分流规则。</p>

      <div className="set-card">
        <SettingRow title="默认内核" desc="新建节点时使用的内核">
          <Segmented
            value={p.defaultEngine}
            onChange={(v) => void patch({ proxy: { defaultEngine: v as typeof p.defaultEngine } })}
            options={[
              { value: 'xray', label: 'Xray' },
              { value: 'singbox', label: 'sing-box' },
              { value: 'mihomo', label: 'Mihomo' }
            ]}
          />
        </SettingRow>

        <SettingRow title="路由模式" desc="绕过大陆：国内直连；全局：全部走代理">
          <Segmented
            value={p.routingMode}
            onChange={(v) => void patch({ proxy: { routingMode: v as typeof p.routingMode } })}
            options={[
              { value: 'bypass', label: '绕过大陆' },
              { value: 'global', label: '全局' }
            ]}
          />
        </SettingRow>

        <SettingRow title="开机自启代理" desc="应用启动时自动连接上次使用的节点">
          <Switch checked={p.autoStart} onChange={(v) => void patch({ proxy: { autoStart: v } })} />
        </SettingRow>

        <SettingRow title="系统代理" desc="连接时自动设置 Windows 系统代理">
          <Switch checked={p.systemProxy} onChange={(v) => void patch({ proxy: { systemProxy: v } })} />
        </SettingRow>

        <SettingRow title="流量嗅探" desc="从连接中识别域名，分流更准确">
          <Switch checked={p.sniffing} onChange={(v) => void patch({ proxy: { sniffing: v } })} />
        </SettingRow>

        <SettingRow title="IPv6" desc="启用后允许通过 IPv6 访问节点">
          <Switch checked={p.ipv6} onChange={(v) => void patch({ proxy: { ipv6: v } })} />
        </SettingRow>
      </div>

      <div className="set-card">
        <SettingRow title="混合端口" desc="HTTP / SOCKS 共用的本地端口">
          <span className="mono tiny">{p.mixedPort}</span>
        </SettingRow>
        <SettingRow title="允许局域网连接" desc="让同一网络下的其他设备也能使用">
          <Switch checked={p.allowLan} onChange={(v) => void patch({ proxy: { allowLan: v } })} />
        </SettingRow>
      </div>

      <div className="hstack" style={{ marginTop: 12 }}>
        <Button variant="text" size="sm" icon="folderData" onClick={() => void window.api.app.openLogs()}>
          打开日志
        </Button>
      </div>
    </>
  )
}
