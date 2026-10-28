import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  ancestorsOf,
  childrenOf,
  foldText,
  githubRepoOf,
  resolveTracker,
  shortId,
  trackerContext,
  visibleRows,
  type Board,
  type FilterName,
  type Item,
} from './model'

const PANE = 'wiki-tick'
const FILTERS: FilterName[] = ['open', 'all', 'linked', 'local']

const board = atom({ plugin: 'wiki-ticket-mod', key: 'board' } as const, null, {
  shape: 'wiki-board-1',
})
const selected = atom({ plugin: 'wiki-ticket-mod', key: 'selected' } as const, null)
const filter = atom({ plugin: 'wiki-ticket-mod', key: 'filter' } as const, 'all')
const query = atom({ plugin: 'wiki-ticket-mod', key: 'query' } as const, '')
const notice = atom({ plugin: 'wiki-ticket-mod', key: 'notice' } as const, null)
const history = atom({ plugin: 'wiki-ticket-mod', key: 'history' } as const, [])
const stamp = atom({ plugin: 'wiki-ticket-mod', key: 'stamp' } as const, '')

const isFilter = (value: string): value is FilterName =>
  value === 'open' || value === 'all' || value === 'linked' || value === 'local'

const watched = (path: string, home: string): boolean =>
  path.includes(`${home}/`) &&
  (path.endsWith('.jsonl') || path.endsWith('config.yml') || path.endsWith('config.yaml'))

async function stampOf($: EngineInterface, dir: string): Promise<string> {
  const entries = await $.fs.list(dir).catch(() => [])
  const bits = entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => `${entry.name}:${entry.mtimeMs}:${entry.size ?? ''}`)
    .sort()
  return bits.length === 0 ? 'missing' : bits.join('|')
}

async function originRepo($: EngineInterface): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', 'remote', 'get-url', 'origin'])
    if (ran.exitCode !== 0) return null
    return githubRepoOf(ran.stdout)
  } catch {
    return null
  }
}

async function loadBoard($: EngineInterface, dir: string, jiraSite: string): Promise<Board> {
  const names = ['todo.jsonl', 'done.jsonl', 'archive.jsonl']
  const chunks: string[] = []
  for (const name of names) {
    const text = await $.fs.read(`${dir}/${name}`).catch(() => undefined)
    if (typeof text === 'string' && text.trim() !== '') chunks.push(text)
  }
  const config = await $.fs.read(`${dir}/config.yml`).catch(() => undefined)
  const folded = foldText(chunks)
  return {
    dir,
    items: folded.items,
    ctx: trackerContext(typeof config === 'string' ? config : '', await originRepo($), jiraSite || null),
    errors: folded.errors,
  }
}

async function reload($: EngineInterface, dir: string, jiraSite: string): Promise<Board> {
  const found = await loadBoard($, dir, jiraSite)
  const marked = await stampOf($, dir)
  await update($, board, () => found)
  await update($, stamp, () => marked)
  const linked = found.items.filter((item) => item.external !== null).length
  await update($, notice, () =>
    found.items.length === 0
      ? `No work items under ${dir}. wiki_ticket_sdd writes .work/todo.jsonl.`
      : `${found.dir}: ${found.items.length} items, ${linked} linked to a tracker.`,
  )
  return found
}

async function select($: EngineInterface, id: string | null): Promise<void> {
  const current = await read($, selected)
  if (current === id) return
  if (current !== null) {
    await update($, history, (past) => [...past, current].slice(-50))
  }
  await update($, selected, () => id)
}

async function back($: EngineInterface): Promise<void> {
  const past = await read($, history)
  const last = past[past.length - 1]
  if (last === undefined) {
    await update($, selected, () => null)
    return
  }
  await update($, history, (all) => all.slice(0, -1))
  await update($, selected, () => last)
}

function describe(found: Board, focus: Item | null): string {
  if (found.items.length === 0) {
    return `No work items under ${found.dir}.`
  }
  if (focus === null) {
    const linked = found.items.filter((item) => item.external !== null).length
    return `Wiki tick pane open on ${found.dir}: ${found.items.length} items, ${linked} linked.`
  }
  const link = resolveTracker(focus.external, found.ctx)
  return `${focus.level} ${focus.id} — ${focus.title}. Tracker: ${link.where === 'none' ? 'not linked' : `${link.where} ${link.label}`}.`
}

export const register: Register = (on, options) => {
  const configured = typeof options.work_dir === 'string' ? options.work_dir : '.work'
  const home = configured.replace(/\/+$/, '') || '.work'
  const jiraSite = typeof options.jira_site === 'string' ? options.jira_site.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'wiki-tick',
      description: 'Open the wiki-ticket viewer: hierarchy, tracker link, and parent',
      argumentHint: '[open|all|linked|local|<id>|<directory>]',
    })
    return next(e)
  })

  on('command.run', { command: 'wiki-tick' }, async ($, e) => {
    const arg = (typeof e.args === 'string' ? e.args : '').trim().replace(/\/+$/, '')
    let dir = home
    let focus: string | null = null
    let mode: FilterName = 'all'
    let text = ''
    if (isFilter(arg)) {
      mode = arg
    } else if (arg !== '') {
      const exists = await $.fs.exists(arg).catch(() => false)
      if (exists) dir = arg
      else text = arg
    }
    const found = await reload($, dir, jiraSite)
    if (text !== '') {
      const exact = found.items.find(
        (item) => item.id === text || item.external?.key === text || item.external?.key === text.replace(/^#/, ''),
      )
      const prefixed = found.items.filter((item) => item.id.startsWith(text))
      focus = exact?.id ?? (prefixed.length === 1 ? prefixed[0]?.id ?? null : null)
      if (focus === null) await update($, query, () => text)
    }
    await update($, filter, () => mode)
    await update($, selected, () => focus)
    await update($, history, () => [])
    await $.ui.open({ id: PANE, title: 'Wiki tick', focus: true, closeOnEscape: true, rows: 28, columns: 72 })
    const item = focus === null ? null : found.items.find((one) => one.id === focus) ?? null
    return { text: describe(found, item) }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (watched(e.file_path, home) && ran.deny === undefined && ran.isError !== true) {
      await reload($, home, jiraSite)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (watched(e.file_path, home) && ran.deny === undefined && ran.isError !== true) {
      await reload($, home, jiraSite)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Link, Text } = $.ui.resolve(e)
    const fresh = await stampOf($, home)
    if (fresh !== (await read($, stamp))) {
      await reload($, home, jiraSite)
    }
    const current = await read($, board)
    const line = await read($, notice)
    const mode = await read($, filter)
    const needle = await read($, query)
    const at = await read($, selected)
    const canGoBack = (await read($, history)).length > 0 || at !== null

    const filters = (
      <Box columnGap={1} flexWrap="wrap">
        {FILTERS.map((name, index) => (
          <Button
            key={`filter-${name}`}
            label={name}
            hotkey={String(index + 1)}
            plain
            dimColor={mode !== name}
            onPress={() => void update($, filter, () => name)}
          />
        ))}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void reload($, home, jiraSite)} />
        <Button
          key="back"
          label="Back"
          hotkey="b"
          dimColor={!canGoBack}
          onPress={() => void back($)}
        />
      </Box>
    )

    if (current === null || current.items.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">No work items</Text>
          <Text dimColor>{line ?? `Looked under ${home}.`}</Text>
          <Text dimColor>wiki_ticket_sdd keeps them in .work/todo.jsonl, done.jsonl, and archive.jsonl.</Text>
          {filters}
        </Box>
      )
    }

    const focus = at === null ? null : current.items.find((item) => item.id === at) ?? null
    if (focus !== null) {
      const link = resolveTracker(focus.external, current.ctx)
      const parent = focus.parent === null ? null : current.items.find((item) => item.id === focus.parent) ?? null
      const kids = childrenOf(current.items, focus.id)
      const chain = ancestorsOf(current.items, focus.id)
      return (
        <Box flexDirection="column" gap={1}>
          {filters}
          <Box flexDirection="column">
            <Text weight="semibold">{focus.title}</Text>
            <Text dimColor>
              {focus.level} · {focus.status}
              {focus.kind ? ` · ${focus.kind}` : ''}
              {focus.milestone ? ` · ${focus.milestone}` : ''}
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Worklog id</Text>
            <Text>{focus.id}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Tracker</Text>
            {link.where === 'none' ? (
              <Text>not linked</Text>
            ) : link.href ? (
              <Link href={link.href} label={`${link.where} ${link.label}`} />
            ) : (
              <Text>
                {link.where} {link.label} — no https url. Set external.url or ticketing.project / ticketing.site.
              </Text>
            )}
          </Box>
          <Box flexDirection="column">
            <Text dimColor>Parent</Text>
            {parent === null ? (
              <Text dimColor>none — this is a root</Text>
            ) : (
              <Button key="parent" plain onPress={() => void select($, parent.id)}>
                <Text color="suggestion" underline>
                  {`${parent.level} ${parent.id}`}
                </Text>
              </Button>
            )}
            {chain.length > 1 && (
              <Text dimColor>{chain.map((item) => shortId(item.id)).join(' / ')}</Text>
            )}
          </Box>
          {kids.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Children</Text>
              {kids.map((child) => {
                const childLink = resolveTracker(child.external, current.ctx)
                return (
                  <Box key={child.id} columnGap={2} flexWrap="wrap">
                    <Button plain key={`child-${child.id}`} onPress={() => void select($, child.id)}>
                      <Text color="suggestion" underline>
                        {`${child.level} ${shortId(child.id)} ${child.title}`}
                      </Text>
                    </Button>
                    {childLink.href ? (
                      <Link href={childLink.href} label={childLink.label} />
                    ) : (
                      <Text dimColor>{childLink.label}</Text>
                    )}
                  </Box>
                )
              })}
            </Box>
          )}
          {focus.body !== '' && <Text>{focus.body.slice(0, 900)}</Text>}
          {focus.orphan && <Text dimColor>Orphan: the log has no create for this id.</Text>}
          {line !== null && <Text dimColor>{line}</Text>}
        </Box>
      )
    }

    const rows = visibleRows(current.items, isFilter(mode) ? mode : 'all', needle)
    return (
      <Box flexDirection="column" gap={1}>
        <Text weight="semibold">
          {`${current.items.length} items · ${current.items.filter((item) => item.external).length} linked`}
        </Text>
        {filters}
        <Input
          key="find"
          label="Find"
          placeholder="title, ulid, issue key"
          value={needle}
          onInput={(value) => void update($, query, () => value)}
        />
        {line !== null && <Text dimColor>{line}</Text>}
        {rows.length === 0 ? (
          <Text dimColor>Nothing matches this filter.</Text>
        ) : (
          rows.map((row) => {
            const link = resolveTracker(row.item.external, current.ctx)
            const pad = '· '.repeat(row.depth)
            return (
              <Box key={row.item.id} flexDirection="column">
                <Box columnGap={1} flexWrap="wrap">
                  <Text dimColor>{`${pad}${row.item.level}`}</Text>
                  <Button plain key={`open-${row.item.id}`} onPress={() => void select($, row.item.id)}>
                    <Text dimColor={!row.match}>{row.item.title}</Text>
                  </Button>
                  <Text dimColor>{row.item.status}</Text>
                </Box>
                <Box columnGap={2} flexWrap="wrap">
                  <Text dimColor>{`${pad}ID ${shortId(row.item.id)}`}</Text>
                  {link.href ? (
                    <Link href={link.href} label={`${link.where} ${link.label}`} />
                  ) : (
                    <Text dimColor>{link.where === 'none' ? 'not linked' : `${link.where} ${link.label}`}</Text>
                  )}
                  {row.item.parent && (
                    <Button plain key={`parent-${row.item.id}`} onPress={() => void select($, row.item.parent)}>
                      <Text color="suggestion" underline>
                        {`parent ${shortId(row.item.parent)}`}
                      </Text>
                    </Button>
                  )}
                </Box>
              </Box>
            )
          })
        )}
      </Box>
    )
  })
}
