import { useState } from 'react'
import { Button, Dialog, TextArea } from './host'
import { toast } from './host'

export function ImportDialog({
  open,
  onClose,
  onDone
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    if (!text.trim()) {
      toast.error('请粘贴节点链接')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.proxy.importLinks(text)
      if (res.added.length) toast.success(`成功导入 ${res.added.length} 个节点`)
      if (res.failed.length) toast.warn(`${res.failed.length} 行未能解析：${res.failed[0].reason}`)
      if (!res.added.length && !res.failed.length) toast.info('没有可导入的内容')
      setText('')
      onDone()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导入节点链接"
      subtitle="支持 vmess / vless / trojan / ss / hysteria2 / tuic / socks / http，每行一条"
      icon="link"
      footer={
        <>
          <Button variant="text" onClick={onClose}>
            取消
          </Button>
          <Button variant="filled" icon="download" onClick={() => void run()} loading={busy}>
            导入
          </Button>
        </>
      }
    >
      <TextArea
        label="分享链接"
        placeholder={'vless://uuid@host:443?encryption=none&security=tls&sni=example.com&type=ws&path=/ws#节点名\nss://YWVzLTI1Ni1nY206cGFzcw==@host:8388#SS节点'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ minHeight: 180 }}
      />
    </Dialog>
  )
}
