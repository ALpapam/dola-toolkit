import { create } from 'zustand'
import type { BookRecord, FolderRecord, LibraryState } from '@shared/types'

export const ALL_BOOKS = '__all__'
export const FAVORITES = '__fav__'

interface LibraryUI {
  state: LibraryState | null
  activeFolder: string
  query: string
  view: 'grid' | 'list'
  sort: 'added' | 'title' | 'author' | 'recent'
  readingId: string | null
  importing: { done: number; total: number; current: string } | null
  classifying: boolean
  setState: (s: LibraryState) => void
  setActiveFolder: (id: string) => void
  setQuery: (q: string) => void
  setView: (v: 'grid' | 'list') => void
  setSort: (s: LibraryUI['sort']) => void
  setReadingId: (id: string | null) => void
  setImporting: (p: LibraryUI['importing']) => void
  setClassifying: (v: boolean) => void
}

export const useLibrary = create<LibraryUI>((set) => ({
  state: null,
  activeFolder: ALL_BOOKS,
  query: '',
  view: 'grid',
  sort: 'added',
  readingId: null,
  importing: null,
  classifying: false,
  setState: (s) => set({ state: s }),
  setActiveFolder: (activeFolder) => set({ activeFolder }),
  setQuery: (query) => set({ query }),
  setView: (view) => set({ view }),
  setSort: (sort) => set({ sort }),
  setReadingId: (readingId) => set({ readingId }),
  setImporting: (importing) => set({ importing }),
  setClassifying: (classifying) => set({ classifying })
}))

export function booksInFolder(
  books: BookRecord[],
  folders: FolderRecord[],
  folderId: string
): BookRecord[] {
  if (folderId === ALL_BOOKS) return books
  if (folderId === FAVORITES) return books.filter((b) => b.favorite)
  const childIds = collectDescendants(folders, folderId)
  return books.filter((b) => b.folderIds.some((id) => id === folderId || childIds.has(id)))
}

export function collectDescendants(folders: FolderRecord[], rootId: string): Set<string> {
  const set = new Set<string>()
  const walk = (id: string): void => {
    for (const f of folders) {
      if (f.parentId === id && !set.has(f.id)) {
        set.add(f.id)
        walk(f.id)
      }
    }
  }
  walk(rootId)
  return set
}

export function folderDepth(folders: FolderRecord[], id: string): number {
  let depth = 0
  let cur = folders.find((f) => f.id === id)
  const guard = new Set<string>()
  while (cur?.parentId && !guard.has(cur.id)) {
    guard.add(cur.id)
    depth++
    cur = folders.find((f) => f.id === cur?.parentId)
  }
  return depth
}

export function sortBooks(books: BookRecord[], sort: LibraryUI['sort']): BookRecord[] {
  const copy = [...books]
  switch (sort) {
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    case 'author':
      return copy.sort((a, b) => a.author.localeCompare(b.author, 'zh-Hans-CN'))
    case 'recent':
      return copy.sort((a, b) => b.updatedAt - a.updatedAt)
    default:
      return copy.sort((a, b) => b.addedAt - a.addedAt)
  }
}
