import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'field-archaeology-digital:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 历史记录没有 rev 字段，统一在这里补 0，保证乐观锁判断对存量数据也成立。
function normalizeRow(row: EntryRow): EntryRow {
  return typeof row.rev === 'number' ? row : { ...row, rev: 0 }
}

function normalizeAll(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  return Object.fromEntries(
    Object.entries(data).map(([key, rows]) => [key, rows.map(normalizeRow)]),
  )
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = normalizeAll(clone(SEED_ROWS))
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalizeAll({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 绕过内存缓存重读持久层：另一个标签页/并发动作的提交必须重新读盘后再判断，避免两个动作同时拿着旧状态生效。
export function readFreshRows(key: string): EntryRow[] {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
        const rows = parsed[key]
        if (Array.isArray(rows)) {
          const normalized = rows.map(normalizeRow)
          if (cache) {
            cache = { ...allRows(), [key]: normalized }
          }
          return normalized
        }
      } catch {
        // 持久层损坏时退回缓存/种子，不阻断正常操作
      }
    }
  }
  return listRows(key).map(normalizeRow)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = normalizeAll(clone(SEED_ROWS))[key] ?? []
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
