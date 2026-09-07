# Plan 017: Tier-gate dubbing (Pro) and content-suite repurposing (Creator+)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check (run first)**: excerpts taken from disk on 2026-07-07
> (uncommitted working tree). If an excerpt doesn't match the live file, STOP.
> NOTE: plan 015 edits the same route file first — run this plan only after 015
> is complete.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 015 (same-file ordering only, no logical dependency)
- **Category**: monetization
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

Two paid-cost features have no tier or quota gate, so Free users can consume
them without limit (only burst rate limits apply — dubs 20/min,
content-suite 30/min):

- **Dubbing** (`requestClipDub`) triggers OpenAI TTS synthesis per request —
  ROADMAP.md §5 explicitly says "Gate the cost-heavier differentiators (4K,
  generative B-roll, dubbing) to Pro / add-ons."
- **Content-suite repurposing** (`generate`) makes gpt-5.4-mini calls per run —
  the pricing page (`apps/web/app/(marketing)/pricing/page.tsx:19-23`) sells
  "Content-suite repurposing" as a **Creator** feature.

This plan enforces: dubbing requires `pro`; content-suite requires `creator`
or `pro`. Friendly 402 errors flow through the existing error-code→message map.

## Current state

- `packages/services/src/dubbing.service.ts:101-142` — `requestClipDub(userId,
  projectId, idempotencyKey, input)` parses input, loads the clip
  (ownership-checked via `project: { userId }`), requires a completed render,
  then upserts a `ClipDub`. **No tier/quota check anywhere in the file**
  (verified: `grep -n "pricingTier\|assertProjectGenerationAllowed" packages/services/src/dubbing.service.ts` → nothing).
- `packages/services/src/content-suite.service.ts:160-200` — `generate(userId,
  projectId, types)` loads the project (ownership-checked), requires a
  completed transcript, then calls OpenAI. **No tier/quota check** (same grep →
  nothing). Errors use the local `ContentSuiteError(code, message)` class —
  e.g. `throw new ContentSuiteError("transcript_not_ready", "A completed transcript is required before repurposing.")`.
- Tier lookup: `User.pricingTier` (string) + `resolvePricingTier` from
  `@narriflow/validators` (`packages/validators/src/pricing.ts:32-35`, defaults
  `"free"`). Exemplar of a service reading the user row: see
  `packages/services/src/billing.service.ts` (uses the package's prisma
  accessor `requirePrisma()` — both target services already import/use
  `requirePrisma()`; match it).
- Error message map: `packages/validators/src/error-messages.ts` maps error
  codes to friendly copy via `userErrorMessage(code)`. Client panels already
  call `userErrorMessage(body?.error)` (exemplar:
  `apps/web/app/(app)/settings/social/social-accounts-panel.tsx:60`).
- Route handlers: `apps/web/app/api/[[...route]]/route.ts` — dubs endpoint
  around line 1364 (`checkRateLimit(\`dubs:${appUser.id}\`...)`), content-suite
  around line 1050. Exemplar 402 shape (presign handler, lines 447-456):
  ```ts
  if (error instanceof QuotaExceededError || error instanceof UploadTooLongError) {
    return c.json({ error: error.code, message: error.message, details: error.details }, 402);
  }
  ```
- Route error-shape convention for rate limits (lines 423-429) returns
  `{ error: "rate_limited", message: "..." }` with a hardcoded English message.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Scope

**In scope**:
- `packages/services/src/dubbing.service.ts`
- `packages/services/src/content-suite.service.ts`
- `packages/validators/src/error-messages.ts` (two new codes)
- `apps/web/app/api/[[...route]]/route.ts` (map the new errors to 402 in the
  dubs + content-suite handlers; plus the small message-consistency fix in Step 4)
- Tests: `packages/validators/src/error-messages.test.ts` (extend),
  `packages/services/src/` existing test file for one of the services if a
  pure helper is added.

**Out of scope**:
- The billing/quota system (`billing.service.ts`) — no changes to
  processing-minutes math.
- UI upsell components/pages — client panels already render `userErrorMessage`
  output; richer upgrade CTAs are a later pass.
- Rate limits (015 owns those). Watermark/720p (016).

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly and leave
changes uncommitted.

## Steps

### Step 1: Add a tier-requirement error + helper in each service

In `dubbing.service.ts`, near the top of `requestClipDub` (right after the
`idempotencyKey` check, before any DB work), add:

```ts
const prisma = requirePrisma();
const owner = await prisma.user.findUnique({
  where: { id: userId },
  select: { pricingTier: true },
});
const tier = resolvePricingTier(owner?.pricingTier);
if (tier !== "pro") {
  throw new DubbingTierError();
}
```

Define an exported error class in the same file following the local error
style (check how dubbing errors are currently thrown — plain `Error` — so
create `export class DubbingTierError extends Error { readonly code = "requires_pro_plan"; constructor() { super("Dubbing is available on the Pro plan."); this.name = "DubbingTierError"; } }`).
Note the existing `const prisma = requirePrisma()` already appears later in
the method — reuse/hoist rather than calling twice.

In `content-suite.service.ts` `generate()`, right after the project ownership
check, add the same lookup and:

```ts
if (tier === "free" || tier === "starter") {
  throw new ContentSuiteError("requires_creator_plan", "Content-suite repurposing is available on Creator and Pro plans.");
}
```

(`ContentSuiteError` already exists in that file — reuse it.)

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Friendly messages for the new codes

In `packages/validators/src/error-messages.ts`, add entries:
- `requires_pro_plan` → "Voiceover dubbing is a Pro feature. Upgrade to Pro to dub your clips."
- `requires_creator_plan` → "Repurposing is included with Creator and Pro plans. Upgrade to unlock it."

Match the existing map's key/copy style exactly (read the file first).

**Verify**: extend `packages/validators/src/error-messages.test.ts` with the
two new codes (model after existing cases); `bun run test` → all pass.

### Step 3: Map the errors to 402 in the route handlers

In the dubs POST handler (~line 1364 region) and the content-suite generate
handler (~line 1050 region) of `apps/web/app/api/[[...route]]/route.ts`: catch
the new errors (`DubbingTierError` by `instanceof` or `error.code`;
`ContentSuiteError` with `code === "requires_creator_plan"` — check how the
handler already maps `ContentSuiteError` codes to statuses and extend that
mapping) and return
`c.json({ error: "<code>", message: userErrorMessage("<code>") }, 402)`.

**Verify**: `grep -n "requires_pro_plan\|requires_creator_plan" "apps/web/app/api/[[...route]]/route.ts"` → ≥2 matches; `bun run typecheck` → exit 0.

### Step 4: Rate-limit message consistency (small, same file)

Every `checkRateLimit` rejection in the route file currently hardcodes
`message: "Too many requests. Please wait a moment and try again."`. Replace
the hardcoded string with `userErrorMessage("rate_limited")` at each 429 site
(the code key already exists in the map at
`packages/validators/src/error-messages.ts:47-48`). Do not change status codes
or the `error: "rate_limited"` field.

**Verify**: `grep -n 'Too many requests' "apps/web/app/api/[[...route]]/route.ts"` → 0 matches; `bun run typecheck` → exit 0.

## Test plan

- Extend `error-messages.test.ts`: the two new codes return their copy;
  unknown codes still fall back.
- If you extract the tier lookup into a shared pure/testable helper, add a
  test; otherwise service gating is exercised by typecheck + the greps (the
  services have no test harness with a DB — do NOT add a mock-Prisma test that
  asserts nothing).
- Full gate: `bun run typecheck` && `bun run test` && `bunx @biomejs/biome check .`.

## Done criteria

- [ ] `bun run typecheck`, `bun run test`, `bunx @biomejs/biome check .` all exit 0
- [ ] `grep -n "resolvePricingTier" packages/services/src/dubbing.service.ts packages/services/src/content-suite.service.ts` → 1 hit each
- [ ] `grep -n "requires_pro_plan\|requires_creator_plan" packages/validators/src/error-messages.ts` → 2 entries
- [ ] Route maps both codes to HTTP 402
- [ ] `grep -n 'Too many requests' "apps/web/app/api/[[...route]]/route.ts"` → 0
- [ ] Only in-scope files modified (`git status --short`)

## STOP conditions

- The excerpts don't match the live code (e.g. `requestClipDub` or `generate`
  signature changed).
- The route's content-suite handler doesn't have an error→status mapping you
  can extend without restructuring the handler.
- Gating dubbing breaks an existing test that assumes free-tier dubbing —
  report it; do not weaken the gate to pass the test.

## Maintenance notes

- Product decision encoded here: dubbing = Pro-only (per ROADMAP §5);
  content-suite = Creator+ (per pricing page). If pricing strategy changes,
  these two `if` statements are the only enforcement points.
- The client dub/repurpose buttons will now show the friendly 402 message via
  the existing `userErrorMessage` wiring; a richer "Upgrade" CTA linking to
  /settings/billing is a good follow-up (out of scope here).
- MCP server (apps/mcp) tools that trigger these paths go through the same
  services, so they inherit the gates automatically.
