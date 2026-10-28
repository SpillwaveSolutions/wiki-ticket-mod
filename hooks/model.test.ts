import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  ancestorsOf,
  childrenOf,
  foldText,
  githubRepoOf,
  resolveTracker,
  trackerContext,
  visibleRows,
  type Item,
} from './model.ts'

const create = (ev: string, item: string, set: Record<string, unknown>) =>
  JSON.stringify({ ev, op: 'create', item, set })

test('last write wins, and close lands on done', () => {
  const { items } = foldText([
    [
      create('01HQWKEVAA0000000000000001', '01HQWKKTAA000000000000TSK1', {
        title: 'First',
        status: 'todo',
        level: 'task',
      }),
      JSON.stringify({
        ev: '01HQWKEVAA0000000000000002',
        op: 'update',
        item: '01HQWKKTAA000000000000TSK1',
        set: { title: 'Second' },
      }),
      JSON.stringify({
        ev: '01HQWKEVAA0000000000000003',
        op: 'close',
        item: '01HQWKKTAA000000000000TSK1',
        set: {},
      }),
    ].join('\n'),
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0]?.title, 'Second')
  assert.equal(items[0]?.status, 'done')
})

test('a snapshot replaces earlier events and keeps a later one', () => {
  const { items } = foldText([
    [
      create('01HQWKEVAA0000000000000001', '01HQWKKTAA000000000000TSK1', { title: 'Created', status: 'todo' }),
      JSON.stringify({
        ev: '01HQWKEVAA0000000000000009',
        op: 'snapshot',
        item: '01HQWKKTAA000000000000TSK1',
        through: '01HQWKEVAA0000000000000005',
        set: { title: 'Snap', status: 'in_progress', level: 'story' },
      }),
      JSON.stringify({
        ev: '01HQWKEVAA0000000000000003',
        op: 'update',
        item: '01HQWKKTAA000000000000TSK1',
        set: { title: 'Dropped' },
      }),
      JSON.stringify({
        ev: '01HQWKEVAA0000000000000010',
        op: 'update',
        item: '01HQWKKTAA000000000000TSK1',
        set: { title: 'After' },
      }),
    ].join('\n'),
  ])
  assert.equal(items[0]?.title, 'After')
  assert.equal(items[0]?.level, 'story')
  assert.equal(items[0]?.status, 'in_progress')
})

test('duplicate ev is folded once', () => {
  const line = create('01HQWKEVAA0000000000000001', '01HQWKKTAA000000000000TSK1', { title: 'Once' })
  const { items } = foldText([`${line}\n${line}`])
  assert.equal(items.length, 1)
})

test('legacy jira and github fields become external', () => {
  const { items } = foldText([
    [
      create('01HQWKEVAA0000000000000001', '01HQWKKTAA000000000000AAA1', { title: 'J', jira: 'WIKI-9' }),
      create('01HQWKEVAA0000000000000002', '01HQWKKTAA000000000000AAA2', { title: 'G', github: '45' }),
    ].join('\n'),
  ])
  const jira = items.find((item) => item.title === 'J')
  const github = items.find((item) => item.title === 'G')
  assert.equal(jira?.external?.system, 'jira')
  assert.equal(jira?.external?.key, 'WIKI-9')
  assert.equal(github?.external?.system, 'github')
  assert.equal(github?.external?.key, '45')
})

test('tracker urls: stored https, github project, jira site, and not linked', () => {
  const ctx = trackerContext(
    'ticketing:\n  system: github\n  project: SpillwaveSolutions/wiki_ticket_sdd\n  site: https://jira.atlassian.net\n',
    null,
    null,
  )
  assert.deepEqual(
    resolveTracker({ system: 'github', key: '433', url: null }, ctx),
    {
      where: 'github',
      label: '#433',
      href: 'https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/433',
    },
  )
  assert.equal(
    resolveTracker(
      { system: 'github', key: '1', url: 'https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/429' },
      ctx,
    ).href,
    'https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/429',
  )
  assert.equal(
    resolveTracker({ system: 'jira', key: 'JRACLOUD-1', url: null }, ctx).href,
    'https://jira.atlassian.net/browse/JRACLOUD-1',
  )
  assert.deepEqual(resolveTracker(null, ctx), { where: 'none', label: 'not linked', href: null })
  assert.equal(resolveTracker({ system: 'jira', key: 'WIKI-1', url: 'javascript:alert(1)' }, ctx).href,
    'https://jira.atlassian.net/browse/WIKI-1')
})

test('origin remote fills in when ticketing.project is absent', () => {
  assert.equal(githubRepoOf('git@github.com:SpillwaveSolutions/wiki_ticket_sdd.git'), 'SpillwaveSolutions/wiki_ticket_sdd')
  assert.equal(githubRepoOf('https://github.com/SpillwaveSolutions/prd-forge'), 'SpillwaveSolutions/prd-forge')
  const ctx = trackerContext('ticketing:\n  system: github\n', 'SpillwaveSolutions/wiki_ticket_sdd', null)
  assert.equal(
    resolveTracker({ system: 'github', key: '12', url: null }, ctx).href,
    'https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/12',
  )
})

test('rows keep ancestors, and parent walk is root-first', () => {
  const epic = item('E', null, 'epic')
  const story = item('S', 'E', 'story')
  const task = item('T', 'S', 'task')
  task.external = { system: 'github', key: '1', url: null }
  task.status = 'done'
  const rows = visibleRows([task, epic, story], 'open', '')
  assert.deepEqual(rows.map((row) => row.item.id), ['E', 'S'])
  const linked = visibleRows([task, epic, story], 'linked', '')
  assert.deepEqual(linked.map((row) => [row.item.id, row.match]), [['E', false], ['S', false], ['T', true]])
  assert.deepEqual(ancestorsOf([epic, story, task], 'T').map((one) => one.id), ['E', 'S'])
  assert.deepEqual(childrenOf([epic, story, task], 'S').map((one) => one.id), ['T'])
})

test('the sample log links GitHub, Jira, and local items', () => {
  const dir = new URL('../examples/.work/', import.meta.url)
  const todo = readFileSync(new URL('todo.jsonl', dir), 'utf8')
  const done = readFileSync(new URL('done.jsonl', dir), 'utf8')
  const config = readFileSync(new URL('config.yml', dir), 'utf8')
  const { items, errors } = foldText([todo, done])
  assert.equal(errors.length, 0)
  assert.equal(items.length, 9)
  const ctx = trackerContext(config, null, null)
  const byTitle = (part: string) => items.find((item) => item.title.includes(part))
  const story = byTitle('CI wiring')
  const jira = byTitle('Jira issue')
  const local = byTitle('never writes')
  const closed = byTitle('design docs')
  assert.equal(resolveTracker(story?.external ?? null, ctx).href,
    'https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/433')
  assert.equal(story?.status, 'in_progress')
  assert.equal(resolveTracker(jira?.external ?? null, ctx).href,
    'https://jira.atlassian.net/browse/JRACLOUD-1')
  assert.equal(resolveTracker(local?.external ?? null, ctx).where, 'none')
  assert.equal(closed?.status, 'done')
  assert.equal(closed?.parent, '01HQWKKTAA000000000000EPC1')
  const rows = visibleRows(items, 'all', '')
  assert.equal(rows[0]?.item.level, 'epic')
  assert.ok(rows.some((row) => row.depth === 2))
})

function item(id: string, parent: string | null, level: string): Item {
  return {
    id,
    title: id,
    status: 'todo',
    level,
    kind: 'feature',
    parent,
    milestone: null,
    body: '',
    priority: null,
    owner: null,
    labels: [],
    external: null,
    orphan: false,
  }
}
