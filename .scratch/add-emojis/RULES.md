# Rules for every Add Emojis ticket

Read `AGENTS.md`, then `.scratch/add-emojis/spec.md` (all of it; section 4 binds you), then your
ticket. Do the work yourself; start no subagents.

## Shared checkout

- You work in `/Users/murtaza/Documents/dev/narriflow` at the same time as other agents on other
  tickets. Edit only the areas your ticket names. If you must touch a file outside them, keep the
  edit minimal and list it in your final message.
- Never `git commit`, `stash`, `reset`, `checkout`, `restore` or `clean`. The tree holds
  uncommitted work that is not yours. `git diff refs/emoji-baseline -- <path>` shows what this
  effort changed in a tracked file.
- Do not modify or delete the owner's untracked root files (`narriflow-emoji-*.zip`,
  `narriflow-emoji-prototype.html`).
- If lint, typecheck or a test fails in a file you did not touch, another agent may be mid-edit.
  Re-run once after a minute; if it still fails, report it and carry on. Do not fix other tickets'
  files.

## Never

- Never run PostgreSQL gates, `next build`, Docker image builds, workerd gates, MCP integration,
  Zapier or Make suites, or the dependency audit.
- Never apply a migration to any database, deploy, or push.
- Never add a compatibility layer, feature flag, fallback to old behaviour, or dual path.

## Code

- Follow the conventions of the files around you (naming, comment style, test style). Comments say
  what the code cannot: constraints, units, why. No narration of the change.
- Keep modules single-purpose; put new code where spec section 4 says it lives.
- Tests cover behaviour the ticket promises, with real inputs (real cue shapes, RTL text, fast
  speech) where the ticket names them.
- Measure the budget your ticket owns and record the numbers.
- UI (web tickets): Chakra UI v3 from `@narriflow/ui`. Narriflow's look has no borders, soft filled
  controls, grey field focus, shadowless menus, and blue `accent` only for interactive state
  (selected, checked, focus). Copy the nearest existing control instead of inventing one. UI text is
  short and plain; sentence case; no exclamation marks.

## Verification

Run what applies to the packages you touched: `bun run lint`, `bun run typecheck`, the package's
tests (`bun run --cwd <package> test`), and the extra checks your ticket names. Report the exact
commands and their real results. If something fails and you could not fix it, say so plainly.

## Close-out

Update your ticket: tick the acceptance boxes that hold, set `**Status:** done` (or leave
`claimed` and say what is open), and append `## Evidence` with commands, results and measured
numbers. Your final message is all the coordinator sees: what you built (files, one line each),
the public API you added or changed as TypeScript signatures, measured numbers, deviations from
the ticket and why, anything you found broken that is not yours, and verification results.
