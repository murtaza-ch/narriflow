# Clear the Free-plan watermark when a workspace upgrades

Status: ready to build. Owner decision 2026-11-27: videos made while on Free must lose their mark automatically after an upgrade, with no user action.

Builds on `.scratch/watermark/spec.md` (the badge, already in the working tree, uncommitted).

## Behaviour

When a workspace's plan gains `export.noWatermark` (Free to Creator, Pro or Business), every finished video in its accessible projects that carries the Free-plan mark is rendered again without it:

- **Default clip renders** (`ClipRender` with no export variant; the project Clips tab) render again at the resolution the new plan gives a default render, `resolveClipExportOutput(tier, "1080p").granted.resolution`, with no mark.
- **Versioned exports** (`ClipExport` + variants; the Exports library, captioned videos, share links) render again in place: same export id, same variants, same frozen clip snapshot, same resolution, no mark. Share links keep working and serve the clean file once it is ready.
- A render that was already frozen with the mark and is still running when the plan changes is cleared when its run settles.
- It costs the user nothing (rendering does not reserve or settle credits today; keep it that way).
- While a file renders again it is in the ordinary rendering state, exactly as after the user presses Render. The marked file is not kept alongside. If the re-render fails, the row is in the ordinary failed state with the ordinary retry.

Not in scope: keeping the old file playable during the re-render, any new UI, any change to which plans carry the mark, downgrades (clean files made while paid stay clean).

## Decisions already made (do not reopen)

1. **A durable fact on the row.** Add `ClipRender.watermark Boolean @default(false)`: "the file this row points at carries the Free-plan mark". Written when a render completes, from the sealed group configuration (`renderGroupConfigurationFromIdentity(...).watermark`, see `packages/services/src/render-group-lifecycle.ts` completion near line 968 and `packages/services/src/render-group-contract.ts`). Every reset that clears `storageKey` sets it back to false (the `admitRoot` reset near `workflow-run-lifecycle.ts:826`, the failed-export retry reset near `:909`, and any other reset you find). It is set for export-variant renders too, so the column means the same thing on every row.
2. **One reset function, two callers.** One function resets a project's marked outputs to "pending, no run" and lets the existing late-work drain render them (`admitLateRenderFollowUp`, `workflow-run-lifecycle.ts` near line 2848, and the live-run dispatch used by `retryFailedClipExport`). Callers:
   - **Billing, after commit.** `commitVerifiedState` in `packages/services/src/workspace-billing.service.ts` is the only place a tier is raised. When the committed change takes the workspace from a tier without `export.noWatermark` to a tier with it, run the clearance for the workspace AFTER the billing transaction has committed, in its own transaction(s), one project at a time. It must never be able to fail or roll back the billing commit: catch everything, log with the structured logger (`console.warn(JSON.stringify({ level, message, ...ctx }))`), return the billing result regardless.
   - **Render settlement.** Where a render run settles and late rows are picked up, apply the same reset to that project first, so a group frozen with the mark before the upgrade is rendered again when it finishes. This runs inside the settlement transaction, which is a critical path: the addition must be a tier read plus the reset, with no new way to throw. If you cannot make it that small and safe, stop and report instead of widening it.
3. **Exports are reissued in place.** For each export with `watermark = true` whose variants are all terminal and whose lineage is settled (the same condition `retryFailedClipExport` uses), set `watermark = false` on the export and every variant, recompute `fingerprint` with `buildClipExportFingerprint` (same revision, aspect ratios, resolution, `watermark: false`, same `dubId` handling), reset every variant and its render, increment `retryCount` (without it `handoffClipExportWithinTransaction` fails an export older than 45 minutes with `operation_deadline_exceeded`), and resync the export aggregate. Skip an export when:
   - another export of the same clip already has the clean fingerprint (the `(clipId, fingerprint)` key is unique; a clean twin exists, leave both alone);
   - its frozen snapshot is missing or no longer decodes, or `assertSceneExportAvailability` would refuse it (the checks `clipExportService.retryFailed` runs before a retry). A skipped export keeps its marked file; never wipe a file you cannot render again.
   - any variant is still pending or rendering (the settlement caller handles it later).
4. **Guards, re-read inside the transaction that resets:** execution admission is open (if closed, do nothing and log; do not throw), the workspace is active and its tier currently has `export.noWatermark`, and the project is accessible (`accessibleProjectWhere`). Take locks in the same order render admission takes them (`lockRenderAdmissionWithinTransaction` / `lockAdmissionProject`, `workflow-run-lifecycle.ts` near line 623).
   Also required, added 2026-11-27 after Astra's map (verified in `execution-retention-pages.ts`: a source older than 90 days can be retired by setting `sourceStorageKey` to null): the project still has its source (`ingestStatus = "ready"` and `sourceStorageKey` not null). A project without a source cannot render again, so its marked files are left alone.
5. **Idempotent by state.** The trigger is the committed tier change, the work set is "rows that are marked now". Running it twice finds nothing the second time. No job table, no marker column, no new workflow type.
6. **Same signals as a manual re-render.** Whatever a user-pressed Render emits so open tabs update (workspace events, project progress catch-up, export aggregate events), the reset emits too, flushed by the caller that owns the transaction. Find what `clipService.triggerClipRendering` and `retryFailedClipExport` do and match it.
7. **Migration.** A new migration under `packages/db/prisma/migrations` adds the column and backfills it for finished rows from the group that produced the current file:

   ```sql
   UPDATE "ClipRender" r SET "watermark" = true
   WHERE r."status" = 'completed' AND EXISTS (
     SELECT 1 FROM "RenderGroupMember" m JOIN "RenderGroup" g ON g."id" = m."groupId"
     WHERE m."clipRenderId" = r."id" AND g."workflowRunId" = r."workflowRunId"
       AND (g."exportIdentity"::jsonb ->> 4) = 'true');
   ```

   Check the real table and column names and how the identity is stored before using it; follow the conventions of the newest migrations in that folder. Do not run it against any database. Regenerate the Prisma client (`bun run --cwd packages/db prisma:generate`).

## Where judgement is needed

The decisions above fix the behaviour and the safety rules; the code is the authority on mechanics. In particular, work out from the code and report:

- whether the late-work drain really picks up export-variant rows reset to "pending, no run", or whether exports need the explicit admit `retryFailedClipExport` uses;
- what happens to the old storage object of a reset row today (cleanup obligation or hold) and that this change does not leak or prematurely delete it;
- whether the settlement caller can loop (a drain run that completes marked again); show why it cannot, or add the smallest bound;
- anything that reads a variant's `resolution`, `watermark` or the export `fingerprint` and would misbehave after an in-place reissue (thumbnail frame operations, bundles, review items, frozen publication state). Free cannot create most of these, but a workspace can downgrade and upgrade again.

If a rule here cannot work as written, choose the smallest working alternative and say exactly what you changed and why. Do not widen scope.

## Tests (no database)

The repo bans PostgreSQL test gates, so prove the logic with fakes in the style already used (`packages/services/src/project-retention.service.test.ts`, `social-publication-scheduling.test.ts`, the lifecycle unit tests that take a fake transaction). At minimum:

- billing: the clearance runs after every verified commit whose plan has `export.noWatermark` and never for Free (changed in review 2026-11-27 from "only on the gaining transition", so the periodic reconcile retries a failed or skipped clearance); a clearance that throws does not change the billing result;
- the reset: selects only marked finished rows of accessible projects; default rows get the plan's resolution and `watermark: false`; skipped when admission is closed, when the workspace is no longer entitled, when the project is not accessible; a second run changes nothing;
- exports: flags, fingerprint and `retryCount` change together; the clean-twin collision is skipped; an export with a pending variant is skipped; an undecodable snapshot is skipped and keeps its file;
- completion writes `watermark` from the sealed group configuration, true and false;
- every reset path clears `watermark`.

Keep pure decisions (which rows, which values) in functions that can be tested without Prisma where that falls out naturally.

## Docs

- `docs/adr/0008-*` says Clip Exports are immutable: add a short amendment that an upgrade reissues a marked export in place, and why (the mark is an entitlement artifact, not content).
- `.scratch/watermark/spec.md`: remove the two "Not in this change" lines this supersedes (no automatic re-render, no migration).
- `GLOSSARY.md` only if a new term is introduced. Prefer not to introduce one.

## Rules

- Shared checkout `/Users/murtaza/Documents/dev/narriflow`. Other sessions have uncommitted edits (`AGENTS.md`, `apps/api/scripts/dev.ts`, `apps/media/scripts/caption-scene-final.ts`, `apps/web/app/_components/api-provider.tsx`, `docs/runbooks/*`, several `.scratch` folders). The badge work is also uncommitted in this tree and is the base you build on. Do not touch, revert or stage anything you did not write for this task.
- Do not commit, push, deploy, or run any migration.
- Verification is the fast set: `bun run typecheck`, `bun run test`, `bun run check:web-split`, `bun run --cwd apps/api build:worker`, and `bunx biome check` on the files you changed (repository-wide `bun run lint` fails on other sessions' untracked `.scratch` files). No database tests, no `next build`, no Docker, no workerd or MCP integration suites.
- The Worker bundle must not import the full services barrel; keep imports narrow as the surrounding code does, and avoid new import cycles between billing and the render lifecycle.
