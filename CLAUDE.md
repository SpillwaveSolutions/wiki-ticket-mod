# wiki-ticket-mod

Claude Code mod. `/wiki-tick` opens a pane over a [wiki_ticket_sdd](https://github.com/SpillwaveSolutions/wiki_ticket_sdd) work log.

The fold in `hooks/model.ts` matches `bin/fold.py`: dedupe on `ev`, order snapshots by `through`, drop events a snapshot already folded. It does not write the log.

A tracker link is `external: { system, key, url }`. GitHub and Jira ids open in the browser. Parent is a worklog ULID and stays inside the pane.

`npm test` runs the fold tests. Claude Code compiles `hooks/register.tsx` when the plugin loads; this repo does not bundle it.
