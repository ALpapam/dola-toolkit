import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookRecord, FolderRecord } from '@shared/types'
import { useApp } from './host'
import { Button, Dialog, Empty, IconButton, Menu, Segmented, Select, Spinner, TextInput, type MenuItem } from './host'
import { Icon, type IconName } from './host'
import { toast } from './host'
import { hashHue } from './host'
import { booksInFolder, collectDescendants, folderDepth, sortBooks, useLibrary, ALL_BOOKS, FAVORITES } from './store'
import { Reader } from './Reader'
import { CatalogDialog } from './CatalogDialog'

export function LibraryPage(): JSX.Element {
  const lib = useLibrary()
  const settings = useApp((s) => s.settings)
  const fileInput = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [folderDialog, setFolderDialog] = useState<{ mode: 'create' | 'rename'; parent?: string | null; id?: string } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const covers = useCovers(lib.state?.books ?? [])

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const s = await window.api.library.state()
        useLibrary.getState().setState(s)
      } catch {
        /* ignore */
      }
    }
    void load()
    const off = window.api.library.onChanged((s) => useLibrary.getState().setState(s))
    const offP = window.api.library.onProgress((p) => useLibrary.getState().setImporting(p.done >= p.total ? null : p))
    return () => {
      off()
      offP()
    }
  }, [])

  const state = lib.state
  const folders = state?.folders ?? []
  const allBooks = state?.books ?? []

  const visible = useMemo(() => {
    if (!state) return []
    const q = lib.query.trim().toLowerCase()
    let list = booksInFolder(allBooks, folders, lib.activeFolder)
    if (q) {
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q) ||
          b.tags.some((t) => t.toLowerCase().includes(q))
      )
    }
    return sortBooks(list, lib.sort)
  }, [state, allBooks, folders, lib.activeFolder, lib.query, lib.sort])

  const doImport = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.library.import()
      if (res.added.length) toast.success(`已导入 ${res.added.length} 本书`)
      if (res.skipped.length) toast.warn(`${res.skipped.length} 个文件被跳过：${res.skipped[0].reason}`)
      if (!res.added.length && !res.skipped.length) toast.info('未选择文件')
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }

  const doClassify = async (): Promise<void> => {
    if (!settings?.ai.apiKey) {
      toast.warn('请先在设置中配置 AI')
      return
    }
    useLibrary.getState().setClassifying(true)
    try {
      const res = await window.api.library.classify()
      if (res.error) toast.error(res.error)
      else {
        toast.success(`AI 归类完成：新建 ${res.createdFolders.length} 个系列，归入 ${res.assignments.length} 本`)
        const s = await window.api.library.state()
        useLibrary.getState().setState(s)
      }
    } catch (e) {
      toast.error(String(e))
    } finally {
      useLibrary.getState().setClassifying(false)
    }
  }

  const createFolder = async (): Promise<void> => {
    if (!folderDialog || !folderName.trim()) return
    try {
      if (folderDialog.mode === 'create') {
        await window.api.library.createFolder(folderName.trim(), folderDialog.parent ?? null)
        toast.success('已新建文件夹')
      } else if (folderDialog.id) {
        await window.api.library.updateFolder(folderDialog.id, { name: folderName.trim() })
        toast.success('已重命名')
      }
      setFolderDialog(null)
      setFolderName('')
    } catch (e) {
      toast.error(String(e))
    }
  }

  const deleteFolder = async (f: FolderRecord): Promise<void> => {
    if (!confirm(`删除文件夹「${f.name}」？书籍不会被删除。`)) return
    await window.api.library.deleteFolder(f.id)
    if (lib.activeFolder === f.id) useLibrary.getState().setActiveFolder(ALL_BOOKS)
    toast.info('文件夹已删除')
  }

  const onDropFiles = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
      .filter((f) => !f.name.toLowerCase().endsWith('.epub') || true)
      .map((f) => (f as File & { path?: string }).path ?? '')
      .filter(Boolean)
    if (!files.length) return
    setBusy(true)
    try {
      const res = await window.api.library.importPaths(files)
      if (res.added.length) toast.success(`已导入 ${res.added.length} 本书`)
      if (res.skipped.length) toast.warn(`${res.skipped.length} 个文件被跳过`)
    } catch (e2) {
      toast.error(String(e2))
    } finally {
      setBusy(false)
    }
  }

  const reading = allBooks.find((b) => b.id === lib.readingId)

  if (reading) {
    return <Reader book={reading} onClose={() => useLibrary.getState().setReadingId(null)} />
  }

  return (
    <div
      className="page library-page"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => void onDropFiles(e)}
      style={dragOver ? { outline: '2px dashed var(--md-primary)', outlineOffset: -8 } : undefined}
    >
      <aside className="folder-pane">
        <div className="folder-pane-head">
          <h3>书库</h3>
          <span className="spacer" />
          <IconButton
            icon="folderNew"
            small
            label="新建文件夹"
            onClick={() => {
              setFolderName('')
              setFolderDialog({ mode: 'create', parent: null })
            }}
          />
        </div>
        <div className="folder-list">
          <FolderRow
            icon="apps"
            name="全部书籍"
            count={allBooks.length}
            active={lib.activeFolder === ALL_BOOKS}
            onClick={() => useLibrary.getState().setActiveFolder(ALL_BOOKS)}
          />
          <FolderRow
            icon="star"
            name="收藏"
            count={allBooks.filter((b) => b.favorite).length}
            active={lib.activeFolder === FAVORITES}
            onClick={() => useLibrary.getState().setActiveFolder(FAVORITES)}
          />
          <div className="divider" style={{ margin: '8px 10px' }} />
          {folders
            .filter((f) => !f.parentId)
            .sort((a, b) => a.order - b.order)
            .map((f) => (
              <FolderTree
                key={f.id}
                folder={f}
                folders={folders}
                books={allBooks}
                activeId={lib.activeFolder}
                depth={0}
                onSelect={(id) => useLibrary.getState().setActiveFolder(id)}
                onMenu={(e, folder) => {
                  e.stopPropagation()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenu({
                    x: r.right - 4,
                    y: r.bottom + 2,
                    items: [
                      {
                        label: '重命名',
                        icon: 'edit',
                        onClick: () => {
                          setFolderName(folder.name)
                          setFolderDialog({ mode: 'rename', id: folder.id })
                        }
                      },
                      {
                        label: '新建子文件夹',
                        icon: 'folderNew',
                        onClick: () => {
                          setFolderName('')
                          setFolderDialog({ mode: 'create', parent: folder.id })
                        }
                      },
                      { label: '', separator: true },
                      {
                        label: '删除',
                        icon: 'delete',
                        danger: true,
                        onClick: () => void deleteFolder(folder)
                      }
                    ]
                  })
                }}
              />
            ))}
          {folders.length === 0 ? (
            <div className="tiny muted" style={{ padding: '10px 12px', lineHeight: 1.6 }}>
              暂无文件夹。点击上方 + 新建，或用 AI 自动归类。
            </div>
          ) : null}
        </div>
      </aside>

      <div className="library-main">
        <div className="lib-toolbar">
          <div className="search">
            <div className="input-wrap">
              <span className="icon-prefix">
                <Icon name="search" size={18} />
              </span>
              <input
                className="input"
                placeholder="搜索书名、作者或标签"
                value={lib.query}
                onChange={(e) => useLibrary.getState().setQuery(e.target.value)}
              />
            </div>
          </div>
          <Select
            value={lib.sort}
            onChange={(v) => useLibrary.getState().setSort(v as typeof lib.sort)}
            options={[
              { value: 'added', label: '最近添加' },
              { value: 'title', label: '书名' },
              { value: 'author', label: '作者' },
              { value: 'recent', label: '最近阅读' }
            ]}
          />
          <Segmented
            value={lib.view}
            onChange={(v) => useLibrary.getState().setView(v)}
            options={[
              { value: 'grid', icon: 'grid', label: '网格' },
              { value: 'list', icon: 'list', label: '列表' }
            ]}
          />
          <span className="spacer" />
          <Button variant="text" icon="autoAi" onClick={() => void doClassify()} disabled={lib.classifying}>
            {lib.classifying ? <Spinner size={16} /> : 'AI 归类'}
          </Button>
          <Button variant="text" icon="download" onClick={() => setCatalogOpen(true)}>
            免费书源
          </Button>
          <Button variant="filled" icon="add" onClick={() => void doImport()} disabled={busy}>
            导入书籍
          </Button>
        </div>

        {lib.importing ? (
          <div style={{ padding: '0 20px 12px' }}>
            <div className="hstack tiny muted" style={{ marginBottom: 6 }}>
              <Spinner size={14} /> 正在导入 {lib.importing.current}
              <span className="spacer" />
              {lib.importing.done}/{lib.importing.total}
            </div>
            <div className="progress-linear">
              <i style={{ width: `${(lib.importing.done / Math.max(1, lib.importing.total)) * 100}%` }} />
            </div>
          </div>
        ) : null}

        <div className="lib-scroll">
          {!state ? (
            <Empty title="正在读取书库…" />
          ) : visible.length === 0 ? (
            <Empty
              icon="bookOpen"
              title={lib.query ? '没有匹配的书籍' : '书库还是空的'}
              desc={
                lib.query
                  ? '换个关键词试试，或切换到其他文件夹。'
                  : '导入 EPUB / PDF / FB2 / MOBI / TXT / RTF 文件，或直接从拖拽窗口导入。'
              }
              action={
                <div className="hstack" style={{ gap: 10, marginTop: 8 }}>
                  <Button variant="filled" icon="add" onClick={() => void doImport()}>
                    导入书籍
                  </Button>
                  <Button variant="text" icon="download" onClick={() => setCatalogOpen(true)}>
                    免费书源
                  </Button>
                </div>
              }
            />
          ) : lib.view === 'grid' ? (
            <div className="book-grid" style={{ ['--cover-w' as string]: `${settings?.library.coverWidth ?? 170}px` }}>
              {visible.map((b) => (
                <BookCard key={b.id} book={b} cover={covers[b.id]} onClick={() => useLibrary.getState().setReadingId(b.id)} />
              ))}
            </div>
          ) : (
            <div className="book-list">
              {visible.map((b) => (
                <BookRow key={b.id} book={b} cover={covers[b.id]} onClick={() => useLibrary.getState().setReadingId(b.id)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {menu ? <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}

      <Dialog
        open={folderDialog !== null}
        onClose={() => setFolderDialog(null)}
        title={folderDialog?.mode === 'rename' ? '重命名文件夹' : '新建文件夹'}
        icon="folderNew"
        width="slim"
        footer={
          <>
            <Button variant="text" onClick={() => setFolderDialog(null)}>
              取消
            </Button>
            <Button variant="filled" onClick={() => void createFolder()} disabled={!folderName.trim()}>
              确定
            </Button>
          </>
        }
      >
        <TextInput
          label="文件夹名称"
          autoFocus
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createFolder()
          }}
        />
      </Dialog>

      <CatalogDialog open={catalogOpen} onClose={() => setCatalogOpen(false)} />
    </div>
  )
}

function FolderRow({
  icon,
  name,
  count,
  active,
  onClick,
  depth
}: {
  icon: string
  name: string
  count: number
  active: boolean
  onClick: () => void
  depth?: number
}): JSX.Element {
  return (
    <button className={`folder-item ${active ? 'active' : ''}`} onClick={onClick} style={depth ? { marginLeft: depth * 12 } : undefined}>
      <Icon name={icon as IconName} size={18} />
      <span className="fname">{name}</span>
      <span className="fcount">{count}</span>
    </button>
  )
}

function FolderTree({
  folder,
  folders,
  books,
  activeId,
  depth,
  onSelect,
  onMenu
}: {
  folder: FolderRecord
  folders: FolderRecord[]
  books: BookRecord[]
  activeId: string
  depth: number
  onSelect: (id: string) => void
  onMenu: (e: React.MouseEvent, f: FolderRecord) => void
}): JSX.Element {
  const count = booksInFolder(books, folders, folder.id).length
  const children = folders.filter((f) => f.parentId === folder.id).sort((a, b) => a.order - b.order)
  return (
    <>
      <div
        className={`folder-item ${activeId === folder.id ? 'active' : ''}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={() => onSelect(folder.id)}
        onContextMenu={(e) => onMenu(e, folder)}
        role="button"
        tabIndex={0}
      >
        <Icon name={folder.kind === 'series' ? 'bookSeries' : 'folder'} size={18} />
        <span className="fname">{folder.name}</span>
        <span className="fcount">{count}</span>
      </div>
      {children.map((c) => (
        <FolderTree
          key={c.id}
          folder={c}
          folders={folders}
          books={books}
          activeId={activeId}
          depth={depth + 1}
          onSelect={onSelect}
          onMenu={onMenu}
        />
      ))}
    </>
  )
}

function BookCard({ book, cover, onClick }: { book: BookRecord; cover: string | null; onClick: () => void }): JSX.Element {
  const hue = hashHue(book.title + book.author)
  return (
    <div className="book-card" onClick={onClick} role="button" tabIndex={0}>
      <div className="book-cover">
        {cover ? (
          <img src={cover} alt={book.title} loading="lazy" />
        ) : (
          <div className="cover-fallback" style={{ background: `linear-gradient(150deg, hsl(${hue} 42% 52%), hsl(${(hue + 40) % 360} 38% 32%))` }}>
            <span className="ct">{book.title}</span>
            <span className="ca">{book.author || '未知作者'}</span>
          </div>
        )}
        <span className="book-fmt">{book.format}</span>
        {book.progress > 0 ? (
          <div className="book-progress">
            <i style={{ width: `${Math.round(book.progress * 100)}%` }} />
          </div>
        ) : null}
      </div>
      <div className="book-title">{book.title}</div>
      <div className="book-author">{book.author || '未知作者'}</div>
    </div>
  )
}

function BookRow({ book, cover, onClick }: { book: BookRecord; cover: string | null; onClick: () => void }): JSX.Element {
  const hue = hashHue(book.title + book.author)
  return (
    <button className="book-row" onClick={onClick}>
      <span className="thumb">
        {cover ? (
          <img src={cover} alt="" loading="lazy" />
        ) : (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              background: `linear-gradient(150deg, hsl(${hue} 42% 52%), hsl(${(hue + 40) % 360} 38% 32%))`
            }}
          />
        )}
      </span>
      <span className="r-main">
        <span className="r-title">{book.title}</span>
        <span className="r-sub">
          {book.author || '未知作者'} · {book.format.toUpperCase()} · {(book.size / 1024 / 1024).toFixed(1)} MB
        </span>
      </span>
      <span className="r-prog">
        <span className="progress-linear" style={{ flex: 1 }}>
          <i style={{ width: `${Math.round(book.progress * 100)}%` }} />
        </span>
        {Math.round(book.progress * 100)}%
      </span>
      <Icon name="chevronRight" size={18} />
    </button>
  )
}

function useCovers(books: BookRecord[]): Record<string, string | null> {
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, string | null> = {}
      for (const b of books) {
        if (covers[b.id] !== undefined) continue
        try {
          const url = await window.api.library.cover(b.id)
          next[b.id] = url
        } catch {
          next[b.id] = null
        }
      }
      if (!cancelled && Object.keys(next).length) setCovers((c) => ({ ...c, ...next }))
    })()
    return () => {
      cancelled = true
    }
  }, [books, covers])
  return covers
}
