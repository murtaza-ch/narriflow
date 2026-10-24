# 02 - Workspace Event feed

**What to build:** A durable, Workspace-scoped, versioned event log that outside tools can poll with a cursor, covering work no request started (Autopilot) as well as work that one did. REST `GET /api/v1/events` and an MCP tool read it.

**Blocked by:** [01 - RSS Brand Profiles and Autopilot ownership](01-rss-brand-profiles-and-autopilot-ownership.md) (both touch Autopilot import).

**Status:** done

**Map:** [Automation and integrations map](../map.md), "Workspace Event" under New concepts.

## Behavior

- New model `WorkspaceEvent`: `id` (UUID, the dedupe key consumers use), `workspaceId`, `seq` (BigInt, unique per Workspace, the cursor), `type`, `version` (Int, starts at 1), `subject` JSON with IDs only, `occurredAt`, `createdAt`, plus a unique `dedupeKey` so one transition never emits twice. No FK to Project, so rows survive Project deletion. A maintenance loop deletes rows older than 30 days.
- New model `WorkspaceEventCounter` (`workspaceId` PK, `lastSeq` BigInt). The writing transaction increments it as its last statement and uses the returned value as `seq`, exactly like `Project.workflowEventSeq` (`packages/services/src/ingest-job-lifecycle.ts:147`). The row lock holds until commit, so commit order matches `seq` order. Don't put the counter on `Workspace`; existing `FOR UPDATE` locks contend there.
- One small module, `packages/services/src/workspace-event.ts`, owns `appendWorkspaceEvent(tx, input)` and `listWorkspaceEvents(scope, { after, limit, types })`. Callers never write the tables directly.
- Event types in this ticket. Each is written inside the transaction that makes the transition, never best-effort:
  - `autopilot.episode_imported`: `{ ruleId, projectId, episodeId }`, written in the RSS import transaction when an Autopilot rule created the Project.
  - `operation.finished`: `{ operation: { kind, id }, projectId, state }` for intake, generation, and export operations from every source (browser, Autopilot, MCP, REST). `operation.id` uses the same encoding as Operation Status (`encodeOperationId` in `packages/services/src/operation-status.ts`) and `state` is the terminal Operation Status state. Emit it at the settlement points that end each lineage: Ingest Job failure settlement (intake failed before generation), the Workflow Run settlement that makes a generation lineage terminal (derive with `deriveGenerationStatus` on the lineage inside the transaction), and Clip Export aggregate settlement (`syncClipExportAggregates`, which every variant write already ends in). Dedupe by `operation.finished:<kind>:<id>`. An intake that hands off to generation finishes when its generation finishes; emit one event for the generation operation, and for intakes started through an Upload Session or link intake also emit the intake operation when its lineage is terminal, as Operation Status reports it.
  - `social_post.finished`: `{ socialPostId, projectId, clipId, platform, state }` where state is `posted`, `sent_to_inbox`, `failed`, or `needs_attention`, written where the Social Post settles (publication attempt settlement, TikTok webhook, recovery). Find every settlement site; the GLOSSARY entries for Social Publication Attempt and Provider Receipt name them.
- Reads: `GET /api/v1/events?after=<seq>&limit=<1..200, default 100>&types=<comma list>` returns `{ data: [{ id, seq, type, version, occurredAt, subject }], nextCursor }`, ordered by `seq`. `nextCursor` is the last returned `seq` as a string, or the input cursor when empty. Without `after`, it starts from the oldest retained row. Add `list_events` to `INTEGRATION_COMMANDS` (`packages/services/src/integration-admission.ts`) with `content.view` and `projects:read`; `social_post.finished` rows are returned only when the credential also holds `publishing:read`. Add the MCP tool `narriflow_list_events` with the same semantics and read-only annotations. Update the parity test.
- Docs: a guide page in `apps/web/content/docs` (listed in `lib/docs/navigation.ts`) explaining polling, dedupe by `id`, ordering by `seq`, the 30-day window, and re-sync from list endpoints. Add ADR `docs/adr/0014-workspace-events.md` amending ADR 0013 (pull feed for work no request started; subscriptions still out), index it in `docs/adr/README.md`, and add **Workspace Event** to `GLOSSARY.md`.

## Acceptance criteria

- [x] Migration adds both tables with the indexes the reads need (`[workspaceId, seq]` unique, `createdAt` for retention).
- [x] Two concurrent transactions for one Workspace commit in `seq` order; a reader never sees a gap fill in behind its cursor (DB test with two interleaved transactions).
- [x] Each event type is written in its transition's transaction and exactly once under retries (DB tests for an Autopilot import, a generation reaching `completed` and `partial`, an export finishing, and a post settling).
- [x] REST and MCP return the same rows; `social_post.finished` is hidden without `publishing:read`.
- [x] Retention deletes rows older than 30 days.
- [x] OpenAPI snapshot updated; docs page, ADR, and GLOSSARY entry added.
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, and the affected DB gates (`test:workflow:db`, `test:social-publication:db`, `test:integration-api:db`, and the one covering Autopilot) pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree; two Opus review rounds. Round 1 fixes: durable dedupe keys in `WorkspaceEventKey` (the purge never re-emits), one event per terminal transition (export `retryCount`, social `terminalAt`), events queued per transaction and flushed once at the end so the counter is the last lock, touched-lineage derivation only, Upload Session terminal states and Project expiry emit. Round 2 fixes applied in the main checkout: TikTok failed-webhook replay no longer emits twice; late handoff acknowledgement takes `FOR SHARE` on the origin and detection runs so the intake event can't be lost. Verified in the main checkout after merge with 01, 03, 06, 10, 14: biome, typecheck, `bun run test`, all DB gates (workflow 123, social-publication 52 after round 2). Known gap: Upload Sessions fail through two funnels that now emit; any future terminal path must use them. Owner: the edited migration was never applied anywhere; apply before deploying.
