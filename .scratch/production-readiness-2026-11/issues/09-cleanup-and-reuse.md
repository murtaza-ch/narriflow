# 09 Cleanup and reuse

**What to build:** Remove what is dead, share what is copied, and make the docs true.

**Blocked by:** 01, 02, 03, 04, 05, 06, 07, 08

**Status:** done

## Do
1. **Dead files:** `packages/services/src/orkspace-commands.ts`, `packages/ui/src/components/{action-submit-button,stat-band}.tsx`, `packages/config/eslint.base.mjs`, `neon.ts`. Verify each first.
2. **Dead exports:** Bun leftovers in `apps/api/src/server-hooks.ts`, 7 `*ActionSchema` in `packages/validators/src/workspace-administration.ts:91-118`, `listGeneratedMediaJobsSchema`, `generatedMediaJobIdSchema`, `isAfterWorkflowCursor`, `advanceWorkflowCursor`, `summarizeDurations`, `hashObjectSha256`, `emitExportFinished`, `useCurrentCaption`, `BILLING_HEALTH_COPY`. Scan: `/private/tmp/claude-501/-Users-murtaza-Documents-dev-narriflow/b41b7230-89b6-40aa-a5ae-edee3cbfb363/scratchpad/deadcode.out`.
3. **Unused dependencies:** `zod` in `packages/ui`, `@neon/env` at root.
4. **Shared helpers:** one `requirePrisma` (34 copies), one R2 client factory holding the checksum rule (`r2-storage.ts`, `execution-storage.ts`, `media-cleanup-storage.ts`, `project-retention-storage.ts`, `clip-selection-storage.ts`, `private-json-storage.ts`, `notification-body-storage.ts`), one clock and SHA-256 module for the execution code, `canonicalJson`.
5. **Formatting:** `project-retention-execution.ts` has 17 lines over 400 chars on a critical path. Reformat it.
6. **Stale docs:** `docs/runbooks/{api-extraction-cutover,youtube-import,social-publication,upload-session-intake,clip-render-attempt-rollout,clip-composition-plan-rollout,project-retention-restore}.md` cite Railway, `apps/worker` and missing files. Rewrite or delete. `packages/db/.env.example:1`, `apps/media/runtime-lock.json:5,8`, stale Redis wording at `apps/api/src/http/request-policy-runtime.ts:216`, `domains/platform/health.ts:43`, `check-route-inventory.ts:3`, `operation-finished.ts:201`, `README.md:96`, `apps/media/README.md:5`. `ioredis` denylists in `audit-worker-bundle.ts:25` and `boundaries.test.ts:9`. Do not remove Railway IDs from `docs/runbooks/environments.md:23`.
7. **AGENTS.md:** keep it accurate if a critical path moved.

## Follow-ups from the integrated run
8. **Lint error.** `appendWorkflowEvent`'s `delivery` parameter is unused (`packages/services/src/workflow-event-append.ts:42`). `progressRequired: true` was already hardcoded at HEAD, and it must stay true: the progress socket needs contiguous sequence numbers, so skipping one would force a resync. Remove the parameter and `WorkflowEventDelivery` from all callers including tests, and correct the comments that say a record is history-only ("nothing is owed to Redis or analytics").
9. **Upload blob URL.** `apps/web/app/(app)/upload/_components/upload-screen.tsx:147` revokes synchronously after click. Use the shared download helper from ticket 07.
10. **`build:worker` audit.** Keep it passing after the shared helpers move.

## Comments

### Implementation (ticket 09)

**Deleted (each re-searched repo-wide, incl. Python, JSON, docs):** `packages/services/src/orkspace-commands.ts` (empty file), `packages/ui/src/components/{action-submit-button,stat-band}.tsx`, `packages/config/eslint.base.mjs` + its `./eslint` export, `zod` from `packages/ui`, `@neon/env` from root (bun.lock pruned via `--lockfile-only`: 55 lines out, no other change). Dead exports: 7 `*ActionSchema` + 3 `*ActionInput` types, `listGeneratedMediaJobsSchema`, `generatedMediaJobIdSchema`, `isAfterWorkflowCursor`, `advanceWorkflowCursor`, `summarizeDurations`, `hashObjectSha256`, `emitExportFinished`, `useCurrentCaption`, `BILLING_HEALTH_COPY`. `apps/api/src/server-hooks.ts`: `createLifecycle`/`ApiLifecycle`/`getLifecycle`/`disableIdleTimeout` and the `lifecycle` binding (Worker never supplies them; only tests did), and the tests that exercised them. Old `ioredis` entries in `audit-worker-bundle.ts` and `boundaries.test.ts` (not in bun.lock). Also removed the unread `progressRequired` ingest dependency.

**Skipped:** `neon.ts` kept (Neon CLI config read by the external tool, imports `@neon/config`; `environments.md` refers to Neon CLI env pull, no repo reader to prove it dead). `socketAddress`/`ingressRequest` kept: always undefined on Workers, but unwinding it touches `limits.ts`, REST/reviews wiring and the limits test (uncommitted work from earlier tickets); worth a follow-up. `apps/media/runtime-lock.json:5` is provenance (the Railway build log the lock was recovered from), kept; line 8 rewritten. `ioredis` stays in `scripts/check-web-backend-imports.ts` (not listed). The 6 `requirePrisma` copies with different failure text or error class stay local (`workspace*.ts`, `generation-finishing-runtime`, `content-suite`, `clip-editor-document-persistence`). Ledger/clock variants with other semantics (localeCompare key order, undefined-filtering, Date handling) were not merged into `canonicalJson`, because that would change hashes.

**Shared:** `requirePrisma` (`require-prisma.ts`): 35 copies. R2 client: `r2-client.ts` holds the checksum rule once (`requestChecksumCalculation: "WHEN_REQUIRED"`, comment moved with it); `r2-fetch-client.ts` adds the fetch handler and `responseChecksumValidation: "WHEN_REQUIRED"` for the 6 Worker-safe stores; `r2-storage.ts` uses `createR2Client` alone, so its response validation is unchanged. `execution-clock.ts` `databaseNow`: 17 copies. `execution-hash.ts` `sha256Hex`: 25 inline sites in 23 files. `canonical-json.ts`: 6 copies. All are internal relative imports of tiny modules; no package.json export needed.

**Formatting:** `project-retention-execution.ts` 539 lines, 0 over 400 chars (was 18); verified by minified-output equality with the original.

**Follow-ups:** `appendWorkflowEvent` takes no `delivery`; `WorkflowEventDelivery` and all 25 caller arguments gone; history-only comments corrected. `upload-screen.tsx` uses `saveBlob`. `build:worker` audit passes.

**Docs:** rewrote `youtube-import`, `social-publication`, `upload-session-intake`, `clip-render-attempt-rollout`, `project-retention-restore`; edited `clip-composition-plan-rollout`; replaced `api-extraction-cutover` with `api-deployment-checks` (the checks were the only copy). Fixed Redis/Railway wording at the listed lines. Open gap recorded in `project-retention-restore.md`: `retention:replay-tombstones` died with `apps/worker` and nothing replays R2 tombstones into a restored database.

**Not mine:** `bun run test` was red at start on `apps/web/repository-verification.test.ts` (ticket 02 added `test:schema-drift:db` without registering it); added `schema-drift` to `DATABASE_CHECKS` in `scripts/local-verification-plan.ts`, which means pre-push now runs that gate.

**Verification:** lint 0 errors (11 warnings, 1 info, all existing); typecheck 15/15; test all packages 0 fail (web 1067, services 1434, api 963, validators 693, media 832, api-client 231, root 26); `test:inventory` 296 routes 0 problems; `build:worker` audit passed; `check:web-split` passed; `openapi:check` 32 operations match. DB gates not run.
