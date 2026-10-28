import { useEffect, useState } from 'react'
import type { CatalogBook, CatalogResult } from '@shared/types'
import { Button, Dialog, Empty, IconButton, Spinner, Tabs, TextInput } from './host'
import { Icon } from './host'
import { toast } from './host'
import { useLibrary } from './store'

type Source = CatalogBook['source']

const SOURCES: { value: Source; label: string }[] = [
  { value: 'gutendex', label: 'Gutendex' },
  { value: 'openlibrary', label: 'Open Library' },
  { value: 'standardebooks', label: 'Standard Ebooks' }
]

export function CatalogDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [source, setSource] = useState<Source>('gutendex')
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<CatalogResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)

  const search = async (q = query, page = 1): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.library.catalog({ source, query: q, page })
      setResult(res)
      if (res.error) toast.warn(res.error)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (open) void search('', 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source])

  const download = async (b: CatalogBook): Promise<void> => {
    setDownloading(b.id)
    try {
      const rec = await window.api.library.catalogDownload(b)
      toast.success(`已导入《${rec.title}》`)
      const s = await window.api.library.state()
      useLibrary.getState().setState(s)
    } catch (e) {
      toast.error(String(e))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="免费书源"
      subtitle="来自 Gutendex / Open Library / Standard Ebooks 的公有领域书籍"
      icon="download"
      width="wide"
      footer={
        <Button variant="text" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="hstack" style={{ gap: 8 }}>
        <Tabs value={source} onChange={setSource} items={SOURCES} />
        <span className="spacer" />
      </div>
      <div className="hstack" style={{ gap: 8 }}>
        <div style={{ flex: 1 }}>
          <TextInput
            placeholder="搜索书名或作者"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search(query, 1)
            }}
            prefixIcon="search"
          />
        </div>
        <Button variant="tonal" icon="search" onClick={() => void search(query, 1)} loading={busy}>
          搜索
        </Button>
      </div>

      {busy && !result ? (
        <div className="hstack" style={{ justifyContent: 'center', padding: 24, gap: 10 }}>
          <Spinner /> <span className="muted">正在请求书源…</span>
        </div>
      ) : null}

      {result?.books.length === 0 ? (
        <Empty icon="search" title="没有找到书籍" desc={result.error ?? '换个关键词试试。'} />
      ) : null}

      {result?.books.length ? (
        <div className="catalog-grid">
          {result.books.map((b) => (
            <div key={b.id} className="catalog-card">
              <div className="cc-cover">
                {b.cover ? (
                  <img src={b.cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <Icon name="bookOpen" size={28} />
                )}
              </div>
              <div className="tiny strong" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {b.title}
              </div>
              <div className="tiny muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {b.author || '未知'}
              </div>
              <Button
                size="xs"
                variant="tonal"
                icon="download"
                disabled={!b.downloadUrl || downloading !== null}
                onClick={() => void download(b)}
              >
                {downloading === b.id ? '下载中…' : b.downloadUrl ? '导入' : '无直链'}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {result?.books.length ? (
        <div className="hstack" style={{ justifyContent: 'center', gap: 8 }}>
          <IconButton icon="chevronLeft" small label="上一页" onClick={() => void search(query, 1)} />
          <span className="tiny muted">共 {result.total} 本</span>
          <IconButton icon="chevronRight" small label="下一页" onClick={() => void search(query, 2)} />
        </div>
      ) : null}
    </Dialog>
  )
}
