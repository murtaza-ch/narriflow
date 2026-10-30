# Resolve final review findings

**Status:** done

**What to build:** Migration-aware cached readiness, bounded audio-gap scans, patched dependencies, exhaustive pending Business cleanup policy, REST pre-auth IP throttle, and deployment checklist corrections.

**Exact ownership:** Files needed for the six fixes explicitly assigned to Sol by the owner on 2026-10-30, including manifests and bun.lock. REST routes changes stay isolated to pre-auth throttling. Excludes concurrent Clerk/auth/email and web Workspace gate/billing client work.

## Comments

No commits, pushes, deployments or env edits. All database gates use `.scratch/api-extraction/db-gate.sh`.

In-progress cross-owner gate failures for the Clerk agent: `bun run lint` currently finds unused `prisma` at `packages/auth/src/identity.ts:210`; `bun run typecheck` stops at new `packages/email/src/mailer.test.ts` because the email package lacks bun:test types. Sol did not touch those files. REST pre-auth change is a small block immediately before header parsing; imports + optional trustedClientIpHeader dependency added, existing post-auth admission left untouched.

Implemented all six owner-assigned fixes. Focused tests pass; billing DB 30/30 and integration DB 7/7 via the local wrapper. Audit moderate has zero advisories. Final lint passes with existing 11 warnings + one info; typecheck passes all 15 tasks. Inventory 283 + 44, public OpenAPI 31 operations, web split + available client bundle pass. Golden all-suite PASS, 18/18 normal identical, 16 corrected contracts pass, two expected failures unchanged. Final full test rerun is finishing, after an initial existing 5-second FFmpeg fixture hook timeout during concurrent golden encoding.


Final evidence: `bun run test` rerun passed 12/12 Turbo tasks, zero failures, including worker 1126/1126. `bun run typecheck` passed 15/15; final lint and all owned-path Biome checks passed. Inventory/OpenAPI/web split rerun passed. `git diff --check` clean. Full resolution and verification recorded under `## Resolution (Sol)` in `review-claude.md`. No deviations from assigned scope; concurrent owner failures resolved by their owner. No further owner requests.
