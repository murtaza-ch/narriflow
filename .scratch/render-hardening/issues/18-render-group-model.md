# 18 - Define durable render groups and ownership contracts

**What to build:** Create the schema and documented ownership model for one parent run with independently claimable render groups.

**Blocked by:** [11 - Retry transient siblings and repair manual export admission](11-retry-lineage.md)

**Status:** done

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20261029160000_render_group_leases/migration.sql`
- `packages/services/src/render-group-contract.ts`
- `packages/services/src/render-group-contract.test.ts`
- `GLOSSARY.md`
- `docs/adr/0001-workflow-run-lifecycle.md`
- `docs/adr/0003-clip-render-attempt.md`

## Implementation

1. Define group identity/membership/status, immutable token/owner/DB lease/heartbeat, due retry, charged count, stable parent work-set generation and compact execution-start/outcome ledger. Preserve the fixed parent work set and existing frozen variant snapshots.
2. Document the exact coordinator-vs-group fencing contract in the spec; coordinator reclaim must leave healthy child leases valid. Explicit cancellation/supersession invalidates affected membership.
3. Amend ADR 0001/0003 and glossary with the settled child-lease exception and owner retry rules. Keep one parent Workflow Run, no per-clip Workflow Runs or independent full render manifests.
4. Provide type contracts for 19/20 without editing their files. Apply migration only to disposable schemas for verification; integrate 18–20 together before deployment.

## Acceptance

- [x] Schema enforces deterministic group membership and unique execution token/idempotency boundaries.
- [x] Contract tests cover charged-start versus pre-start release, group outcome/retry inputs and parent settlement eligibility.
- [x] ADRs explain why parent-only ownership no longer meets single-project scaling and crash isolation; vocabulary distinguishes group from Render Work Set.
- [x] Prisma generation/typechecks succeed and disposable migration gates pass; shared Neon is unchanged.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bash .scratch/api-extraction/db-gate.sh bun run --cwd packages/db prisma:generate
bun test packages/services/src/render-group-contract.test.ts
bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Implemented by GPT-6.1-Sol on `dev`, starting HEAD `c124bb66eb1681b320993db60b437b17f0808494`, 2026-10-29. Concurrent ticket 02 advanced HEAD to `91f6517d5751280fcb9df3276da0645ebb355dcb`; this implementer made no commit. All repository writes are within this ticket's write set and issue file. No env, dependency, shared DB, deployment or unrelated process changes.

Implementation:
- Added the stable parent `renderWorkSetGeneration`, uniquely identified groups, historical immutable membership, immutable execution-token/owner ledger, and per-token/per-variant outcomes. Composite foreign keys fence generation and current-token/group consistency; unique keys prevent duplicate group identity, cross-group membership and duplicate outcomes. SQL checks bound charged attempts and enforce lease/terminal/retry shape. Triggers reject identity rewrites, reversed invalidation and settled-outcome mutation.
- Historical variant IDs intentionally do not foreign-key mutable ClipRender rows. Editor deletion or manual lineage reassignment cannot remove execution denominators; admission validates the clip and frozen configuration, and supersession explicitly invalidates membership. Existing snapshots remain the only persisted render inputs.
- Added pure typed contracts for 19/20: claim/start/release references, canonical export identity, member fencing, once-only start/refund accounting, mixed-sibling retry selection and complete-parent settlement eligibility. Three charged attempts retain 30s/60s backoff. Spawn rejection costs zero; started crashes retain their charge; graceful release refunds once and respects drain. Healthy group tokens survive coordinator reclaim.
- Amended ADR 0001/0003 and glossary to distinguish Render Group from Render Work Set and define the exact coordinator/group responsibilities, transaction locks, DB-clock predicate, cancellation, late admission and single terminal notification authority. No worker/compiler-input derivation changed; the no-mirrored-glue prerequisite does not activate.

Migration and rollout:
- Exact migration: `20261029160000_render_group_leases`.
- Additive/backward-compatible with the current pre-18 worker/API: the existing parent generation remains nullable, new tables start empty, and old writers never populate them. No worker/API stop is required merely to apply this migration. Normal PostgreSQL DDL locking still applies.
- The orchestrator must apply it once to shared dev. This implementation applied it ONLY in disposable local schemas through `db-gate.sh`, then dropped them. Shared Neon is unchanged.
- Runtime rollout must integrate 18-20 and drain all old render workers before starting the group runtime. There is no dual execution mode or compatibility bridge.

Verification:
- `bash .scratch/api-extraction/db-gate.sh bun run --cwd packages/db prisma:validate`: pass.
- `bash .scratch/api-extraction/db-gate.sh bun run --cwd packages/db prisma:generate`: pass, Prisma Client 7.7.0.
- `bun test packages/services/src/render-group-contract.test.ts`: **28 pass**, 0 fail, 52 assertions. Log `/tmp/narriflow-ticket-18-contract-test.log`. Covers coordinator reclaim, token/owner/generation/member/variant loss, exact lease expiry, charging/refund replay, mixed and exhausted siblings, supersession, future/due retries, and partition completeness.
- `bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`: **184 pass**, 0 fail, 975 assertions; all migrations applied to a disposable local schema. Log `/tmp/narriflow-ticket-18-workflow-db.log`.
- Additional schema smoke: `WORKFLOW_TEST_DATABASE_SCHEMA=workflow_lifecycle_test_render_group_18 WORKFLOW_TEST_KEEP_SCHEMA=1 WORKFLOW_TEST_NAME='WorkflowRunLifecycle PostgreSQL invariants' bash .scratch/api-extraction/db-gate.sh bun run test:workflow:db`, then `bash .scratch/api-extraction/db-gate.sh bun /tmp/narriflow-ticket-18-schema-smoke.ts`: **19 SQL invariant assertions pass**, including old-code writes and project cascade with a current group token. The smoke script rolls back fixtures and drops its disposable schema. Logs `/tmp/narriflow-ticket-18-migration-smoke-setup.log`, `/tmp/narriflow-ticket-18-schema-smoke.log`.
- `bunx biome check packages/services/src/render-group-contract.ts packages/services/src/render-group-contract.test.ts`: pass. Owned-path `git diff --check`: pass.
- `bun run --cwd packages/services typecheck`: pass, including final rerun after all contract edits; `/tmp/narriflow-ticket-18-services-typecheck-final.log`.
- `bun run lint`: pass, 11 existing warnings and 1 info; `/tmp/narriflow-ticket-18-lint.log`.
- `bash .scratch/api-extraction/db-gate.sh bun run typecheck`: pass, **15/15 tasks**, including DB generation/typecheck; `/tmp/narriflow-ticket-18-typecheck.log`.
- `bun run test`: pass, **10/10 tasks**, worker 751 pass / 0 fail; `/tmp/narriflow-ticket-18-test.log`. Final member-ID predicate edit was reverified by the 28 scoped tests and services typecheck.
- `bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-18`: **PASS, exit 0**, normal **18/18 identical**, all **18/18 known-defect references unchanged**. Report `/tmp/narriflow-golden/candidate-18/report.md`, log `/tmp/narriflow-ticket-18-golden.log`. Captured candidate HEAD `c124bb66eb1681b320993db60b437b17f0808494` with concurrent ticket 02 edits; baseline commit `5680477046a7972435a728c7ce3d0b9b9513fe4f`. Same macOS host adaptation as ticket 01/11, fingerprint `90cf30a30583bbe50e3972558024cc2ce7b9bffe683b79411d839e93d0d05f7f`; no new image built.

All acceptance criteria pass. Runtime group claim/reaping/two-replica execution remain the explicitly dependent work in 19/20.

## Comments

Write-set conflict in implementation item 2: it requests the exact coordinator/group fence "in the spec", but `spec.md` is not in this ticket's exhaustive write set. The exact predicate and lock protocol are documented in the owned ADR 0001/0003 instead. Orchestrator request: add a reference from the spec's "Replica scaling protocol: 18-20" section to these amendments if the spec must carry the normative detail. No unowned spec edit was made.

Ticket 19 owns `packages/services/src/index.ts`: re-export the render-group contracts there alongside its lifecycle service before worker integration. This ticket does not modify that unowned barrel. No behavior deviation or remaining implementation blocker.
