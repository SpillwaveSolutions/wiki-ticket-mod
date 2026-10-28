---
name: wiki-tick
description: Open the wiki-ticket task viewer. Use when the user wants to see worklog tickets, whether they are linked to Jira or GitHub, the issue id, or a parent in the hierarchy.
---

# Wiki tick

Run `/wiki-tick`. Do not invent ticket ids or tracker keys.

The pane reads `.work/todo.jsonl`, `.work/done.jsonl`, and `.work/archive.jsonl`
and folds them the way `worklog` does. A link is the item's `external` object
(`system`, `key`, `url`), or a legacy `jira` / `github` field.

- The issue id is a link. GitHub opens `https://github.com/<ticketing.project>/issues/<key>`. Jira opens `<ticketing.site>/browse/<key>`. A stored `external.url` wins when it is https.
- An item with no key is shown as **not linked**. Do not guess a URL.
- Parent is the worklog ULID in `parent`. Choosing it opens that item in the pane. It does not open the tracker.
