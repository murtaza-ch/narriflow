# 04 - Finishing: export the best clips and write copy without a person

**What to build:** When a generation finishes, Narriflow can export the top clips with the Brand Profile applied and write assisted copy for chosen platforms, then mark the Project "ready to review." Autopilot rules store the settings; REST and MCP intake and generation requests may pass the same settings inline, so the n8n Drive flow finishes too.

**Blocked by:** [01](01-rss-brand-profiles-and-autopilot-ownership.md), [02](02-workspace-event-feed.md) (finishing starts from the generation's `operation.finished` transition and reports through events).

**Status:** done

**Map:** [Automation and integrations map](../map.md), "Finishing" under New concepts.

## Behavior

- One schema, `finishingSettingsSchema` in `packages/validators`: `topClips` (1 to 10), `minScore` (0 to 100, default 0), `aspectRatios` (1 to 4 of the supported ratios, default the Content Pack's default), `resolution` (default `1080p`; the export service's existing requested-vs-granted rule applies), `copyPlatforms` (zero or more Social Platforms), and `delivery` (only `"ready_to_review"` in this ticket; ticket 05 adds the queue). No dubbing.
- Where settings live:
  - `AutopilotRule.finishing` (nullable JSON; null means no finishing), validated on save.
  - Optional `finishing` on REST `POST /projects`, `POST /uploads`, `POST /projects/{id}/generations`, and on MCP `narriflow_submit_video`, the upload open, and `narriflow_generate_clips`. It's part of the request, so it's part of the receipt fingerprint like any other input.
  - Carry it through the existing `generationContext` that already flows from acceptance through the Upload Session or Ingest Job to the Ingest Generation Handoff. Don't add a second path.
- Freeze: at generation admission (the handoff that creates the speech-to-text run, or `generate_clips` admission), create one `GenerationFinishing` row keyed by the generation operation's origin run, holding the frozen settings, the acting user, and state `waiting`. Retries and replays find the same row.
- Start: in the transaction where ticket 02 emits `operation.finished` for that generation with state `completed` or `partial`, move the row to `due`. `failed` or `cancelled` moves it to `skipped` with that reason.
- Run: a worker loop claims due rows with a lease and:
  1. Re-checks the tier. Finishing needs `campaign.operations` (Pro and above). Below that, the row ends `skipped` with a reason the Project page and the Autopilot rule show. Imports and clips are unaffected (owner default, see map).
  2. Picks clips from the generation's lineage with score at or above `minScore`, highest first, up to `topClips`.
  3. Creates Clip Exports for each picked clip's current editor revision with the frozen ratios and resolution, as the acting user, through `clip-export.service.ts` `create`. Use derived idempotency keys (UUIDv5 of the finishing row and clip, `packages/services/src/uuid-v5.ts`) so a re-claim never duplicates.
  4. When those exports are terminal, generates assisted copy per picked clip and platform through the assisted copy service, also idempotently.
  5. Ends `ready` (or `partial` if some exports or copy failed) and appends a Workspace Event `finishing.finished` with `{ projectId, operation, state, exportIds }`. It also sends the acting user one "clips ready to review" notification through the existing notification path.
- Prefer composing existing services and Campaign Operation actions where one fits over a new pipeline. Don't duplicate their logic. The handoff touches `packages/services/src/workflow-run-lifecycle.ts`, a critical path. Keep the change there to the one transition and cover it with the workflow DB gate.
- UI:
  - The Autopilot rule form gets a Finishing section: off, or top N, minimum score, ratios, copy platforms.
  - The Project page shows finishing status: working, ready (with links to the exports), partial, or skipped with its reason.
- Docs: the REST guide, the MCP tool docs, and the n8n Drive template README mention `finishing`. Regenerate the OpenAPI snapshot.

## Acceptance criteria

- [x] Settings schema shared by rules, REST, and MCP; invalid settings refused at save or acceptance.
- [x] One `GenerationFinishing` per generation, created in the admission transaction, stable under retries (DB test).
- [x] Generation `completed` or `partial` makes it due in the same transaction; `failed` skips it (DB test through the workflow gate).
- [x] Worker run selects the right clips, creates exports and copy exactly once across re-claims, ends `ready`/`partial`/`skipped` correctly, and emits `finishing.finished` (DB tests).
- [x] A Creator-tier Workspace's rule imports and generates but finishing ends `skipped` with a visible reason.
- [x] UI for rule settings and Project status.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `test:workflow:db`, `test:integration-api:db`, and the Autopilot gate pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (high: the notification used a non-UUID ledger source and never sent; now `finishing_ready` emails the acting user, proven through the real ledger; high: the browser generate route could freeze finishing onto a non-stt run, so finishing is REST/MCP only and non-stt origins are refused; plus reuse conflicts, transient copy retries under fresh keys, revision-aware export retries, `exporting` state polled without claims). The settings field is `delivery`, not `then`. No Campaign Operation action creates Clip Exports, so finishing calls the export service directly. Merged with every earlier ticket and 11; verified in the main checkout: biome, typecheck, `bun run test`, `apps/mcp` tests, all ten DB gates (workflow 149, finishing 22).
