# Implementer brief (every ticket)

You implement one ticket of the Narriflow API extraction in the shared checkout
`/Users/murtaza/Documents/dev/narriflow` (branch `dev`). Several other agents
(Claude and GPT-6.1-Sol) are editing *other* files in the same checkout at the
same time.

## Read first
1. `AGENTS.md` (repo conventions, critical paths, pre-production policy).
2. `.scratch/api-extraction/spec.md` — the complete contract. Follow it.
3. Your ticket `.scratch/api-extraction/issues/NN-*.md` and every file it lists.
4. `.scratch/api-extraction/inventory.md` rows your ticket cites.

## Rules
- Claim the ticket first: set `**Status:** claimed`.
- Edit only files your ticket owns (its "Exact ownership" list and new
  directories). Never revert, reformat, or "fix" a file you do not own, even if
  it fails to compile — another agent may be mid-edit. If you need a change in
  an unowned file, write the exact request under `## Comments` in your ticket
  and in your final report; work around it only through public contracts.
- Format/lint only your own paths: `bunx biome check --write <your paths>`.
  Never run `biome --write` on the whole repo.
- Dependencies: only the ticket that owns `bun.lock` may run `bun add`/`bun
  install` changes. If you need a dependency you don't own, request it.
- Do not commit, push, deploy, or edit any `.env*` file. The orchestrator does.
- Business logic stays in `packages/services`; HTTP adapters stay thin. Keep
  behavior, authorization, plan checks and error codes identical unless the
  spec changes them. No dual paths, no compatibility shims, no TODO stubs left
  behind in your scope.
- Code quality: follow surrounding style and `AGENTS.md` conventions; explicit
  types at module boundaries; no `any` unless the existing code already needs
  it; small functions; tests beside implementations (`bun test`).
- Security: every route has an admission declaration (session, signed-in-only,
  independent trust, staff); validate input after admission; bounded bodies;
  rate-limit scopes from the spec; idempotency per the spec; never log tokens,
  secrets, signed URLs or provider codes.

## Database gates
Never run DB suites against the shared Neon database. Use the throwaway local
Postgres (pgvector installed):
`.scratch/api-extraction/db-gate.sh bun run test:<suite>:db`
(or wrap any `bun test …db.test.ts` command the same way).

## Verification
Run your ticket's verification commands plus `bunx biome check <your paths>`
and the typecheck of every package you touched. Transitional compile errors
in files owned by *later* tickets are expected during the sequence: record
them (file + owning ticket) instead of fixing them. Your own files must be
clean and your tests must pass.

## Close-out
Tick acceptance boxes you satisfied, append evidence (commands + results)
under `## Comments`, and set `**Status:** done` — or `blocked` with the reason.
Final reply (≤25 lines): files changed, verification commands and results,
deviations from the spec and why, requests for other owners, and anything
you think the spec got wrong.
