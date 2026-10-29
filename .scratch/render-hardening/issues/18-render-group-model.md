# 18 - Define durable render groups and ownership contracts

**What to build:** Create the schema and documented ownership model for one parent run with independently claimable render groups.

**Blocked by:** [11 - Retry transient siblings and repair manual export admission](11-retry-lineage.md)

**Status:** ready-for-agent

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

- [ ] Schema enforces deterministic group membership and unique execution token/idempotency boundaries.
- [ ] Contract tests cover charged-start versus pre-start release, group outcome/retry inputs and parent settlement eligibility.
- [ ] ADRs explain why parent-only ownership no longer meets single-project scaling and crash isolation; vocabulary distinguishes group from Render Work Set.
- [ ] Prisma generation/typechecks succeed and disposable migration gates pass; shared Neon is unchanged.

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

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
