/**
 * Fold a wiki_ticket_sdd work log and decide where a tracker id opens.
 *
 * The fold follows bin/fold.py: dedupe on `ev`, order snapshots by `through`,
 * drop events a snapshot already folded, then apply create/update/link/close.
 * No I/O. The mod reads the files and hands the text here.
 */

export type External = {
  system: string
  key: string
  url: string | null
}

export type Item = {
  id: string
  title: string
  status: string
  level: string
  kind: string
  parent: string | null
  milestone: string | null
  body: string
  priority: string | null
  owner: string | null
  labels: string[]
  external: External | null
  orphan: boolean
}

export type TrackerContext = {
  /** `ticketing.project`, owner/repo. */
  project: string | null
  /** Jira site origin, no trailing slash. */
  jiraSite: string | null
  /** owner/repo parsed from `git remote get-url origin`, when it is GitHub. */
  origin: string | null
}

export type TrackerWhere = 'github' | 'jira' | 'other' | 'none'

export type TrackerLink = {
  where: TrackerWhere
  /** What to print on the control. "not linked" when where is none. */
  label: string
  /** https URL, or null when the id must not be opened. */
  href: string | null
}

export type FilterName = 'open' | 'all' | 'linked' | 'local'

export type Row = { item: Item; depth: number; match: boolean }

export type Board = {
  dir: string
  items: Item[]
  ctx: TrackerContext
  errors: string[]
}

type FoldEvent = {
  ev: string
  op: string
  item?: string
  set?: Record<string, unknown>
  add?: Record<string, unknown>
  del?: Record<string, unknown>
  through?: string
}

const OPEN = new Set(['todo', 'in_progress', 'blocked', 'open'])
const CLOSED = new Set(['done', 'cancelled', 'closed'])

const LEVEL_RANK: Record<string, number> = { epic: 0, story: 1, task: 2, subtask: 3 }

export function isOpen(status: string): boolean {
  return OPEN.has(status)
}

export function githubRepoOf(remote: string): string | null {
  const text = remote.trim()
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text)
  if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2]}`
  const https = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text)
  if (https?.[1] && https[2]) return `${https[1]}/${https[2]}`
  return null
}

/** `ticketing:` and `jira:` scalars from `.work/config.yml`. Not a YAML parser. */
export function trackerContext(
  configText: string,
  originRepo: string | null,
  jiraOverride: string | null,
): TrackerContext {
  let block = ''
  const bag: Record<string, string> = {}
  for (const raw of configText.split('\n')) {
    const line = raw.split('#')[0] ?? ''
    if (!line.trim()) continue
    if (!/^\s/.test(line)) {
      const top = /^([A-Za-z_][\w]*)\s*:/.exec(line.trim())
      block = top?.[1] ?? ''
      continue
    }
    if (block !== 'ticketing' && block !== 'jira') continue
    const field = /^\s+([A-Za-z_][\w]*)\s*:\s*(.*?)\s*$/.exec(line)
    const key = field?.[1]
    const value = field?.[2]?.replace(/^['"]|['"]$/g, '')
    if (key && value) bag[`${block}.${key}`] = value
  }
  const site = (jiraOverride || bag['ticketing.site'] || bag['jira.site'] || bag['ticketing.url'] || '')
    .replace(/\/+$/, '')
  return {
    project: bag['ticketing.project'] || null,
    jiraSite: site || null,
    origin: originRepo,
  }
}

export function resolveTracker(ext: External | null, ctx: TrackerContext): TrackerLink {
  if (ext === null || (ext.key === '' && ext.url === null)) {
    return { where: 'none', label: 'not linked', href: null }
  }
  const system = ext.system.toLowerCase()
  const where: TrackerWhere = system === 'github' || system === 'gh'
    ? 'github'
    : system === 'jira'
      ? 'jira'
      : 'other'
  const href = httpsOf(ext, where, ctx)
  return { where, label: labelOf(ext, where), href }
}

function labelOf(ext: External, where: TrackerWhere): string {
  if (where === 'github') {
    const key = ext.key.replace(/^#/, '')
    const num = key.includes('#') ? (key.split('#').pop() ?? key) : key
    return `#${num}`
  }
  if (where === 'jira') return ext.key || 'jira'
  if (ext.key) return ext.system ? `${ext.system} ${ext.key}` : ext.key
  return ext.system || 'linked'
}

function httpsOf(ext: External, where: TrackerWhere, ctx: TrackerContext): string | null {
  if (ext.url && /^https:\/\//i.test(ext.url)) return ext.url
  if (where === 'github') {
    const repo = ctx.project || ctx.origin
    const key = ext.key.trim().replace(/^#/, '')
    const qualified = /^([^#\s]+)#(\d+)$/.exec(key)
    if (qualified?.[1] && qualified[2]) return `https://github.com/${qualified[1]}/issues/${qualified[2]}`
    if (repo && /^\d+$/.test(key)) return `https://github.com/${repo}/issues/${key}`
    return null
  }
  if (where === 'jira' && ctx.jiraSite && ext.key) {
    return `${ctx.jiraSite}/browse/${encodeURIComponent(ext.key)}`
  }
  if (where === 'other' && (ext.system.toLowerCase() === 'gitlab')) {
    const repo = ctx.project || ctx.origin
    if (repo && ext.key) return `https://gitlab.com/${repo}/-/issues/${encodeURIComponent(ext.key)}`
  }
  return null
}

export function foldText(chunks: readonly string[]): { items: Item[]; errors: string[]; skipped: number } {
  const events: FoldEvent[] = []
  const errors: string[] = []
  let skipped = 0
  let lineNo = 0
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      lineNo += 1
      if (!line.trim()) continue
      let ev: FoldEvent
      try {
        ev = JSON.parse(line) as FoldEvent
      } catch {
        errors.push(`line ${lineNo}: unparseable`)
        skipped += 1
        continue
      }
      if (typeof ev?.ev !== 'string' || typeof ev.op !== 'string') {
        errors.push(`line ${lineNo}: missing ev/op`)
        skipped += 1
        continue
      }
      if (ev.op !== 'compact' && typeof ev.item !== 'string') {
        errors.push(`line ${lineNo}: missing item`)
        skipped += 1
        continue
      }
      events.push(ev)
    }
  }

  const seen = new Map<string, FoldEvent>()
  for (const ev of events) {
    if (!seen.has(ev.ev)) seen.set(ev.ev, ev)
  }
  const sorted = [...seen.values()].sort((a, b) => {
    const pa = a.op === 'snapshot' && a.through ? a.through : a.ev
    const pb = b.op === 'snapshot' && b.through ? b.through : b.ev
    if (pa < pb) return -1
    if (pa > pb) return 1
    const oa = a.op === 'snapshot' && a.through ? 0 : 1
    const ob = b.op === 'snapshot' && b.through ? 0 : 1
    return oa - ob
  })

  const marks = sorted.filter((e) => e.op === 'compact' && e.through).map((e) => e.through as string)
  const watermark = marks.reduce<string | null>((best, one) => (best === null || one > best ? one : best), null)
  const covered = new Map<string, string>()
  for (const ev of sorted) {
    if (ev.op !== 'snapshot' || !ev.item || !ev.through) continue
    const prev = covered.get(ev.item) ?? ''
    if (ev.through > prev) covered.set(ev.item, ev.through)
  }
  const snapshotted = new Set(
    sorted.filter((ev) => ev.op === 'snapshot' && ev.item).map((ev) => ev.item as string),
  )
  const kept = sorted.filter((ev) => {
    if (ev.op === 'compact') return false
    if (ev.op === 'snapshot') return true
    const iid = ev.item
    if (!iid || !snapshotted.has(iid)) return true
    const limit = covered.get(iid) || watermark
    if (limit == null) return true
    return ev.ev > limit
  })

  const raw = new Map<string, Record<string, unknown>>()
  for (const ev of kept) {
    const iid = ev.item as string
    const known = raw.has(iid)
    if (ev.op === 'snapshot') {
      const item: Record<string, unknown> = { id: iid }
      applyMutations(item, ev)
      raw.set(iid, item)
      continue
    }
    if (ev.op === 'create') {
      if (known) {
        applyMutations(raw.get(iid) ?? {}, ev)
        continue
      }
      const item: Record<string, unknown> = { id: iid }
      applyMutations(item, ev)
      raw.set(iid, item)
      continue
    }
    if (!known) raw.set(iid, { id: iid, _orphan: true })
    const item = raw.get(iid) ?? { id: iid }
    if (ev.op === 'conflict') continue
    if (ev.op === 'close') {
      applyMutations(item, ev)
      if (!CLOSED.has(String(item.status ?? ''))) item.status = 'done'
      continue
    }
    if (ev.op === 'reopen') {
      applyMutations(item, ev)
      if (CLOSED.has(String(item.status ?? '')) || item.status == null) item.status = 'todo'
      delete item.resolution
      continue
    }
    applyMutations(item, ev)
  }

  const items = [...raw.values()].map(toItem).sort((a, b) => a.id.localeCompare(b.id))
  return { items, errors, skipped }
}

function applyMutations(item: Record<string, unknown>, ev: FoldEvent): void {
  for (const [field, values] of Object.entries(ev.del ?? {})) {
    const current = Array.isArray(item[field]) ? (item[field] as unknown[]) : []
    const drop = new Set(Array.isArray(values) ? values : [])
    item[field] = current.filter((value) => !drop.has(value))
  }
  for (const [field, values] of Object.entries(ev.add ?? {})) {
    const current = Array.isArray(item[field]) ? [...(item[field] as unknown[])] : []
    for (const value of Array.isArray(values) ? values : []) {
      if (!current.includes(value)) current.push(value)
    }
    item[field] = current
  }
  for (const [field, value] of Object.entries(ev.set ?? {})) item[field] = value
}

function toItem(raw: Record<string, unknown>): Item {
  const labels = Array.isArray(raw.labels) ? raw.labels.filter((v): v is string => typeof v === 'string') : []
  return {
    id: String(raw.id ?? ''),
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : '(untitled)',
    status: typeof raw.status === 'string' && raw.status !== '' ? raw.status : 'todo',
    level: typeof raw.level === 'string' && raw.level !== '' ? raw.level : 'task',
    kind: typeof raw.kind === 'string' && raw.kind !== '' ? raw.kind : 'triage',
    parent: typeof raw.parent === 'string' && raw.parent !== '' ? raw.parent : null,
    milestone: typeof raw.milestone === 'string' && raw.milestone !== '' ? raw.milestone : null,
    body: typeof raw.body === 'string' ? raw.body : '',
    priority: typeof raw.priority === 'string' ? raw.priority : null,
    owner: typeof raw.owner === 'string' ? raw.owner : null,
    labels,
    external: externalOf(raw),
    orphan: raw._orphan === true,
  }
}

/** `external`, or a legacy top-level `jira` / `github` string. */
function externalOf(raw: Record<string, unknown>): External | null {
  const ext = raw.external
  if (ext && typeof ext === 'object') {
    const record = ext as Record<string, unknown>
    const key = record.key == null ? '' : String(record.key)
    const system = record.system == null ? '' : String(record.system)
    const url = typeof record.url === 'string' && record.url !== '' ? record.url : null
    if (key !== '' || url !== null) return { system, key, url }
  }
  if (typeof raw.jira === 'string' && raw.jira !== '') return { system: 'jira', key: raw.jira, url: null }
  if (typeof raw.github === 'string' && raw.github !== '') return { system: 'github', key: raw.github, url: null }
  if (typeof raw.github === 'number') return { system: 'github', key: String(raw.github), url: null }
  return null
}

export function visibleRows(items: readonly Item[], filter: FilterName, query: string): Row[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const needle = query.trim().toLowerCase()
  const matches = (item: Item): boolean => {
    if (filter === 'open' && !isOpen(item.status)) return false
    if (filter === 'linked' && item.external === null) return false
    if (filter === 'local' && item.external !== null) return false
    if (needle === '') return true
    const blob = [
      item.id,
      item.title,
      item.level,
      item.status,
      item.external?.key ?? '',
      item.external?.system ?? '',
    ].join(' ').toLowerCase()
    return blob.includes(needle)
  }
  const wanted = new Set<string>()
  const matched = new Set<string>()
  for (const item of items) {
    if (!matches(item)) continue
    matched.add(item.id)
    wanted.add(item.id)
    let parent = item.parent
    let guard = 0
    while (parent && guard < 16) {
      wanted.add(parent)
      parent = byId.get(parent)?.parent ?? null
      guard += 1
    }
  }

  const children = new Map<string, Item[]>()
  const roots: Item[] = []
  for (const item of items) {
    if (!wanted.has(item.id)) continue
    const parent = item.parent && wanted.has(item.parent) ? item.parent : null
    if (parent === null) roots.push(item)
    else {
      const list = children.get(parent) ?? []
      list.push(item)
      children.set(parent, list)
    }
  }
  const order = (a: Item, b: Item) =>
    (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  roots.sort(order)
  for (const list of children.values()) list.sort(order)

  const rows: Row[] = []
  const walk = (item: Item, depth: number, seen: Set<string>) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    rows.push({ item, depth, match: matched.has(item.id) })
    for (const child of children.get(item.id) ?? []) walk(child, depth + 1, seen)
  }
  const seen = new Set<string>()
  for (const root of roots) walk(root, 0, seen)
  return rows
}

export function childrenOf(items: readonly Item[], id: string): Item[] {
  return items
    .filter((item) => item.parent === id)
    .sort((a, b) => (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9) || a.id.localeCompare(b.id))
}

export function ancestorsOf(items: readonly Item[], id: string): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const chain: Item[] = []
  let parent = byId.get(id)?.parent ?? null
  const seen = new Set<string>()
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const item = byId.get(parent)
    if (!item) break
    chain.push(item)
    parent = item.parent
  }
  return chain.reverse()
}

export function shortId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}
