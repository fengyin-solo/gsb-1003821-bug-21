import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, readFreshRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 地层的「所属探方」关联到探方管理的「探方编号」。
const STRATUM_TRENCH_FIELD = '所属探方'
const TRENCH_CODE_FIELD = '探方编号'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function isFinalStatus(meta: ModuleMeta, status: string): boolean {
  const finals = meta.finalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  return finals.includes(status)
}

// 按「所属探方 = 探方编号」找关联探方；找不到时返回 null（历史样例数据里关联字段可能没对上）。
function findLinkedTrench(trenchCode: string): EntryRow | null {
  const code = trenchCode.trim()
  if (!code) {
    return null
  }
  return readFreshRows('trench').find((row) => String(row[TRENCH_CODE_FIELD] ?? '').trim() === code) ?? null
}

// 地层「退回补录」的跨面联动：已回填的探方现场已经封闭，不能再被地层补录拉回发掘中。
// 已到底的探方退回补录时重新打开发掘面，与地层「需补录」保持一致，避免两个业务面状态不一致。
function checkStratumReturnLinkage(trenchCode: string): ActionResult | null {
  const trench = findLinkedTrench(trenchCode)
  if (!trench || trench.status === '已回填') {
    return trench
      ? {
          ok: false,
          message: `关联探方「${trenchCode}」已回填，现场已封闭，不能再退回补录；如需补录请先联系探方管理解除回填`,
        }
      : null
  }
  return null
}

function reopenTrenchForStratum(trenchCode: string): EntryRow[] | null {
  const code = trenchCode.trim()
  if (!code) {
    return null
  }
  const trenches = readFreshRows('trench')
  const index = trenches.findIndex((row) => String(row[TRENCH_CODE_FIELD] ?? '').trim() === code)
  if (index < 0) {
    return null
  }
  const trench = trenches[index]
  if (trench.status !== '已到底') {
    return null
  }
  const next = [...trenches]
  next[index] = {
    ...trench,
    status: '发掘中',
    pending: true,
    rev: Number(trench.rev ?? 0) + 1,
  }
  saveRows('trench', next)
  return next
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export type RunActionOptions = {
  // 页面展示时的行版本：与持久层不一致说明期间已有别的动作提交，本次动作必须失败。
  expectedRev?: number
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: RunActionOptions = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  // 并发动作提交期间可能已经改过这条记录，提交前必须重读持久层，不能用页面带来的旧状态判断。
  const rows = readFreshRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  const currentStatus = String(current.status)

  // 乐观锁：页面行的版本与最新版本不一致时，说明另一个动作已经先生效，本次明确失败。
  if (typeof options.expectedRev === 'number' && options.expectedRev !== Number(current.rev ?? 0)) {
    return {
      ok: false,
      message: `该${meta.entity}已被其他操作更新（页面状态已过期），请刷新后重试，本次「${action}」未生效`,
    }
  }

  // 跨面联动：地层退回补录时，关联探方已回填（现场封闭）一律拒绝，不能被另一业务面拉回发掘中。
  if (key === 'stratum' && action === '退回补录') {
    const linkageError = checkStratumReturnLinkage(String(current[STRATUM_TRENCH_FIELD] ?? ''))
    if (linkageError) {
      return linkageError
    }
  }

  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 状态机前置校验：只允许从登记的来源状态发起动作，探方安排回填必须先确认到底，不能越级。
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(currentStatus)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${currentStatus}」，不能直接「${action}」；需先处于「${sources.join('、')}」`,
    }
  }

  const updated: EntryRow = {
    ...current,
    status: target,
    pending: !isFinalStatus(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    rev: Number(current.rev ?? 0) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 地层退回补录：已到底的关联探方重新拉回发掘中，与地层需补录状态对齐；发掘中/待发掘探方不动。
  let extra = ''
  if (key === 'stratum' && action === '退回补录') {
    const trenchCode = String(current[STRATUM_TRENCH_FIELD] ?? '')
    if (findLinkedTrench(trenchCode)?.status === '已到底') {
      reopenTrenchForStratum(trenchCode)
      extra = `；关联探方「${trenchCode}」已重新进入发掘中`
    }
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${extra}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
