/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 乐观锁版本：每次成功动作 +1，并发提交靠它判断页面上的行是否已过期。历史数据没有该字段，读取时补 0。
  rev?: number
  [field: string]: string | number | boolean | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 动作允许的前置状态：不配置时保持宽松（兼容历史模块），配置后不满足前置态就拒绝，防止越级流转。
  actionSources?: Record<string, string[]>
  // 业务终态：进入这些状态后不再待处理；不配置时沿用「状态表最后一个为终态」的旧规则。
  finalStatuses?: string[]
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
