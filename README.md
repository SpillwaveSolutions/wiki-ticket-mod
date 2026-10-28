# wiki-ticket-mod

A Claude Code pane for [wiki_ticket_sdd](https://github.com/SpillwaveSolutions/wiki_ticket_sdd). `/wiki-tick` shows the work tree, tells you whether each item is linked to GitHub or Jira, and lets you open that issue or its parent.

The pane is read-only. It folds `.work/todo.jsonl`, `.work/done.jsonl`, and `.work/archive.jsonl` the same way `worklog` does. It never writes them.

Requires Claude Code v2.1.287 or later (the mod API).

## Install

From a marketplace checkout of this repo:

```
/plugin marketplace add SpillwaveSolutions/wiki-ticket-mod
/plugin install wiki-ticket-mod@wiki-ticket-mod
```

Or, from a local clone:

```
claude --plugin-dir /path/to/wiki-ticket-mod
```

## Use

```
/wiki-tick
/wiki-tick open
/wiki-tick linked
/wiki-tick local
/wiki-tick 01HQWKKT
/wiki-tick examples/.work
```

| Control | What it does |
| --- | --- |
| Issue id (`github #433`, `jira JRACLOUD-1`) | Opens the GitHub issue or the Jira issue |
| `not linked` | The item has no `external` key. Nothing is opened |
| `parent <ulid>` | Opens that work item in the pane |
| `1` `2` `3` `4` | Open, all, linked, local |
| `b` | Back |
| `r` | Refresh |

Click a title for the detail: full ULID, tracker link, parent, and children.

The pane reloads when those files change on disk, and when Claude writes them with the Write or Edit tool.

## How a link is chosen

1. `external.url`, when it is `https://`
2. GitHub key `433`, or `owner/repo#433`, using `ticketing.project` in `.work/config.yml`, else `git remote get-url origin` when that remote is GitHub
3. Jira key, using `ticketing.site` (or the plugin setting `jira_site`) as `https://<site>/browse/<key>`
4. Otherwise the key is shown and is not a link

A legacy top-level `jira` or `github` field is treated as `external`. Anything that is not `https` is ignored.

```yaml
ticketing:
  system: github
  project: SpillwaveSolutions/wiki_ticket_sdd   # owner/repo
  site: https://yourorg.atlassian.net          # Jira only
```

`external` on the folded item:

```json
{ "system": "github", "key": "433", "url": "https://github.com/SpillwaveSolutions/wiki_ticket_sdd/issues/433" }
```

`parent` is the parent's worklog ULID. Choosing it does not open the tracker.

## Try it on the sample

```
/wiki-tick examples/.work
```

That log has a GitHub-linked story (`#433`, URL built from `ticketing.project`), a Jira-linked story (`JRACLOUD-1`, URL built from `ticketing.site`), items with no tracker, and a closed task in `done.jsonl`.

## Layout

```
.claude-plugin/plugin.json    manifest and userConfig
.claude-plugin/marketplace.json
hooks/hooks.json              loads register.tsx
hooks/register.tsx            /wiki-tick and the pane
hooks/model.ts                fold and tracker URLs
hooks/model.test.ts
skills/wiki-tick/SKILL.md
examples/.work/               sample log
```

## Test

```
npm test
```

## License

MIT
