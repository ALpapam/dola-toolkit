import { useEffect, useMemo, useState } from 'react'
import type { CoreId, EngineCapability, NodeDraft, NodeProtocol, ProxyNode, TransportKind } from '@shared/types'
import { Button, Dialog, Field, IconButton, Select, Switch, TextInput } from './host'
import { Icon } from './host'
import { toast } from './host'
import { engineLabel } from './host'

interface Props {
  open: boolean
  onClose: () => void
  engines: EngineCapability[]
  defaultEngine: CoreId
  /** when set the dialog edits this node instead of creating a new one */
  editing?: ProxyNode | null
  onSaved: () => void
}

const ALL_PROTOCOLS: { id: NodeProtocol; label: string; engines: CoreId[] }[] = [
  { id: 'vmess', label: 'VMess', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'vless', label: 'VLESS', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'trojan', label: 'Trojan', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'shadowsocks', label: 'SS', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'socks', label: 'SOCKS5', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'http', label: 'HTTP', engines: ['xray', 'mihomo', 'singbox'] },
  { id: 'hysteria2', label: 'Hysteria2', engines: ['mihomo', 'singbox'] },
  { id: 'tuic', label: 'TUIC', engines: ['mihomo', 'singbox'] },
  { id: 'anytls', label: 'AnyTLS', engines: ['mihomo', 'singbox'] }
]

const METHODS = ['aes-256-gcm', 'aes-128-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'none']

const emptyDraft = (engine: CoreId): NodeDraft => ({
  name: '',
  protocol: 'vless',
  engine,
  server: '',
  port: 443,
  uuid: '',
  security: 'none',
  network: 'tcp',
  method: METHODS[0]
})

export function AddNodeDialog({ open, onClose, engines, defaultEngine, editing, onSaved }: Props): JSX.Element {
  const [draft, setDraft] = useState<NodeDraft>(() => emptyDraft(defaultEngine))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (editing) {
      // edit mode: start from the node's current values so the user only has to
      // change what they care about (name, pin, transport…)
      setDraft({
        name: editing.name,
        protocol: editing.protocol,
        engine: editing.engine,
        server: editing.server,
        port: editing.port,
        uuid: editing.uuid,
        password: editing.password,
        method: editing.method,
        flow: editing.flow,
        security: editing.security,
        sni: editing.sni,
        alpn: editing.alpn,
        fingerprint: editing.fingerprint,
        pinSHA256: editing.pinSHA256,
        allowInsecure: editing.allowInsecure,
        publicKey: editing.publicKey,
        shortId: editing.shortId,
        spiderX: editing.spiderX,
        network: editing.network,
        path: editing.path,
        host: editing.host,
        serviceName: editing.serviceName,
        obfs: editing.obfs,
        obfsParam: editing.obfsParam,
        upMbps: editing.upMbps,
        downMbps: editing.downMbps
      })
    } else {
      setDraft(emptyDraft(defaultEngine))
    }
  }, [open, defaultEngine, editing])

  const protoMeta = ALL_PROTOCOLS.find((p) => p.id === draft.protocol)
  const engineOk = protoMeta?.engines.includes(draft.engine) ?? true
  const supportsUuid = draft.protocol === 'vmess' || draft.protocol === 'vless'
  const supportsPassword = ['trojan', 'shadowsocks', 'socks', 'http', 'hysteria2', 'tuic', 'anytls'].includes(
    draft.protocol
  )
  const supportsTls = ['vmess', 'vless', 'trojan', 'hysteria2', 'tuic'].includes(draft.protocol)
  const engineCaps = useMemo(
    () => engines.filter((e) => protoMeta?.engines.includes(e.engine)),
    [engines, protoMeta]
  )

  const set = <K extends keyof NodeDraft>(k: K, v: NodeDraft[K]): void => {
    setDraft((d) => ({ ...d, [k]: v }))
  }

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) {
      toast.error('请填写节点名称')
      return
    }
    if (!draft.server.trim()) {
      toast.error('请填写服务器地址')
      return
    }
    if (!draft.port || draft.port < 1 || draft.port > 65535) {
      toast.error('端口需在 1–65535 之间')
      return
    }
    setSaving(true)
    try {
      await window.api.proxy.saveNode(editing ? { ...draft, id: editing.id } : draft)
      toast.success('节点已保存')
      onSaved()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `编辑节点 · ${editing.name}` : '添加节点'}
      subtitle={editing ? '修改后保存即生效，正在使用时需要重新启动内核' : '选择内核与协议，填入所需的连接信息'}
      icon={editing ? 'settings' : 'add'}
      width="wide"
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            取消
          </Button>
          <Button variant="filled" icon="check" onClick={() => void save()} loading={saving} disabled={!engineOk}>
            保存
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <span className="field-label">内核</span>
        <div className="engine-grid">
          {(['xray', 'mihomo', 'singbox'] as CoreId[]).map((id) => {
            const cap = engines.find((e) => e.engine === id)
            const allowed = protoMeta?.engines.includes(id) ?? true
            return (
              <button
                key={id}
                className={`engine-card ${draft.engine === id ? 'sel' : ''}`}
                onClick={() => allowed && set('engine', id)}
                disabled={!allowed}
                style={{ opacity: allowed ? 1 : 0.4 }}
              >
                <div className="en">
                  {engineLabel(id)}
                  {cap?.available ? <span className="node-dot on" /> : null}
                </div>
                <div className="ev">{cap?.available ? cap.version ?? 'ready' : '未安装'}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="stack-sm">
        <span className="field-label">协议</span>
        <div className="proto-grid">
          {ALL_PROTOCOLS.map((p) => (
            <button
              key={p.id}
              className={`proto-btn ${draft.protocol === p.id ? 'sel' : ''}`}
              onClick={() => {
                const nextEngine = p.engines.includes(draft.engine) ? draft.engine : p.engines[0]
                setDraft((d) => ({ ...d, protocol: p.id, engine: nextEngine }))
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <TextInput
          label="名称"
          placeholder="例如：香港 01"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <TextInput
          label="服务器地址"
          placeholder="example.com 或 IP"
          value={draft.server}
          onChange={(e) => set('server', e.target.value)}
        />
        <TextInput
          label="端口"
          type="number"
          value={String(draft.port)}
          onChange={(e) => set('port', Number(e.target.value))}
        />
        {supportsUuid ? (
          <TextInput
            label="UUID"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={draft.uuid ?? ''}
            onChange={(e) => set('uuid', e.target.value)}
          />
        ) : (
          <div />
        )}
        {supportsPassword ? (
          <TextInput
            label={draft.protocol === 'shadowsocks' ? '密码' : '密码 / UUID'}
            value={draft.password ?? ''}
            onChange={(e) => set('password', e.target.value)}
          />
        ) : null}
        {draft.protocol === 'shadowsocks' ? (
          <Select
            label="加密方式"
            value={draft.method ?? METHODS[0]}
            onChange={(v) => set('method', v)}
            options={METHODS.map((m) => ({ value: m, label: m }))}
          />
        ) : null}
        {draft.protocol === 'vmess' ? (
          <TextInput
            label="AlterId"
            type="number"
            value={String(draft.alterId ?? 0)}
            onChange={(e) => set('alterId', Number(e.target.value))}
          />
        ) : null}
      </div>

      {supportsTls ? (
        <>
          <div className="divider" />
          <div className="grid-2">
            <Select
              label="传输层"
              value={draft.network ?? 'tcp'}
              onChange={(v) => set('network', v as TransportKind)}
              options={[
                { value: 'tcp', label: 'TCP' },
                { value: 'ws', label: 'WebSocket' },
                { value: 'grpc', label: 'gRPC' },
                { value: 'http', label: 'HTTP' },
                { value: 'h2', label: 'HTTP/2' }
              ]}
            />
            <Select
              label="安全层"
              value={draft.security ?? 'none'}
              onChange={(v) => set('security', v as 'none' | 'tls' | 'reality')}
              options={[
                { value: 'none', label: 'none' },
                { value: 'tls', label: 'TLS' },
                { value: 'reality', label: 'REALITY' }
              ]}
            />
            <TextInput
              label="SNI / 域名"
              placeholder="www.example.com"
              value={draft.sni ?? ''}
              onChange={(e) => set('sni', e.target.value)}
            />
            <TextInput
              label="WS 路径 / gRPC 服务名"
              placeholder="/path 或 grpc-service"
              value={draft.path ?? ''}
              onChange={(e) => set('path', e.target.value)}
            />
            {draft.network === 'ws' ? (
              <TextInput
                label="Host 头"
                placeholder="example.com"
                value={draft.host ?? ''}
                onChange={(e) => set('host', e.target.value)}
              />
            ) : null}
            <TextInput
              label="ALPN"
              placeholder="h2,http/1.1"
              value={draft.alpn ?? ''}
              onChange={(e) => set('alpn', e.target.value)}
            />
            {draft.security === 'reality' ? (
              <>
                <TextInput
                  label="Reality 公钥"
                  value={draft.publicKey ?? ''}
                  onChange={(e) => set('publicKey', e.target.value)}
                />
                <TextInput
                  label="ShortId"
                  value={draft.shortId ?? ''}
                  onChange={(e) => set('shortId', e.target.value)}
                />
              </>
            ) : null}
            <TextInput
              label="指纹"
              placeholder="chrome"
              value={draft.fingerprint ?? ''}
              onChange={(e) => set('fingerprint', e.target.value)}
            />
            {/* Hysteria2 通常用自签证书，靠固定服务器公钥来建立信任 */}
            {draft.protocol === 'hysteria2' || draft.protocol === 'tuic' ? (
              <Field
                label="证书公钥 PIN（pinSHA256）"
                hint="分享链接里的 pinSHA256，64 位十六进制或 base64。留空则按系统证书校验；服务器更换证书后可在此更新"
              >
                <TextInput
                  placeholder="64 位十六进制，或 base64（可留空）"
                  value={draft.pinSHA256 ?? ''}
                  onChange={(e) => set('pinSHA256', e.target.value)}
                />
              </Field>
            ) : null}
            <TextInput
              label="Flow（VLESS）"
              placeholder="xtls-rprx-vision"
              value={draft.flow ?? ''}
              onChange={(e) => set('flow', e.target.value)}
            />
          </div>
        </>
      ) : null}

      {/* 跳过证书校验：自签证书的 Hysteria2 节点，或分享链接里的 pin 已过期时使用 */}
      <div className="field-row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>跳过证书校验</div>
          <div className="tiny muted">
            服务器使用自签证书，或提示「证书公钥不匹配」时打开。开启后不再校验证书，安全性降低
          </div>
        </div>
        <Switch
          checked={draft.allowInsecure === true}
          onChange={(v) => set('allowInsecure', v)}
        />
      </div>

      {!engineOk ? (
        <div className="tiny" style={{ color: 'var(--md-error)' }}>
          当前协议不支持所选内核，请切换内核。
        </div>
      ) : null}
    </Dialog>
  )
}
