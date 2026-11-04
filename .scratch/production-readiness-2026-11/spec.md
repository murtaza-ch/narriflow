# Production readiness pass, 2026-11

**Owner's request:** find and fix bugs, weak implementations, inconsistencies and gaps so the product is production ready, with better performance, organisation and reuse. "The current clips reframing and sampling is good, don't change the clips visuals."

**Baseline at HEAD b3e3b754:** lint, typecheck, tests, route inventory, OpenAPI and web split checks all pass. Eight independent reviewers produced the tickets in `issues/`. Those gates could not see these defects.

## Rules for every ticket

1. A review finding is a claim. Read the code path first. If a finding is false, record that in the ticket and skip it.
2. Behaviour fixes get a regression test that fails first, when the behaviour can be tested. Prefer DB gates for store behaviour, because Prisma and in-memory stores have diverged here before.
3. **Frozen, do not touch:** anything that changes output pixels, framing, crop choice, layout decisions, shot detection, face or speaker tracking, frame sampling, caption look or timing. That covers detector code, `packages/composition-plan` decisions, FFmpeg encode args and filter graphs, and layout analysis. Render parity must stay exact.
4. Pre-production policy applies: remove replaced paths in the same change. No compatibility layers.
5. Keep the code in the style of the file you are editing. Fix the defect, not its neighbours.
6. Do not commit, push, deploy, or touch shared resources (Neon, R2, Modal, Stripe, Clerk, Cloudflare). DB gates run only on the local test database: `git config --get narriflow.testDatabaseUrl`, passed as `DATABASE_URL`, `DIRECT_URL` and `SERVERLESS_TEST_DATABASE_URL`, with `bun --no-env-file run test:<name>:db`.
7. Leave `apps/api/scripts/dev.ts` alone: it holds the owner's uncommitted work.
8. Only ticket 02 edits `packages/db/prisma/schema.prisma` or adds migrations. If another ticket needs a schema change, record it in that ticket's Comments.
9. Update `## Comments` in the ticket with what changed, what was skipped and why, and the verification run.

## Tickets

| # | Ticket | Scope |
|---|---|---|
| 01 | Security and diagnosability | Email, Zoom forgery, open redirect, error logging, auth edge cases |
| 02 | Data lifecycle and queries | Delete and purge, migration, indexes, overfetching |
| 03 | Execution recovery | Stranded runs, hourly sweep, retry budgets, ledger retention |
| 04 | Ingest and upload | Intake truthfulness, upload recovery, duplicated source checks |
| 05 | Render reliability | Failure reporting and budgets, no output changes |
| 06 | Providers | Social, LLM, Scribe edge cases and shared clients |
| 07 | Web client | Studio durability, progress stream, bundle size |
| 08 | Billing | Stripe state edges, reservations, operator refunds |
| 09 | Cleanup and reuse | Dead code, shared helpers, stale docs. Runs last |

## Decisions that belong to the owner

Not implemented. See `decisions.md`.

## Result, 2026-11-04

All tickets closed. Final tree: lint 0 errors, typecheck 15/15, all unit suites, 13 DB gates, Python suite, route inventory, OpenAPI, web split with bundle scan, Worker audit and `env:check` pass. `render-golden verify` against a baseline captured at b3e3b754 before any edit: 36 of 36, 0 failures.

Deployed to shared development on 2026-11-04 at `4882eb6c`: migration applied, media image and API Worker live, web live on Vercel.

Deploy order used: media image from a tracked archive, then the migration, then the API Worker straight after. Older Workers write dropped columns, and the YouTube command gained a required field.
