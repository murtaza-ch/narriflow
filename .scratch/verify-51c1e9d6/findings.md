# Verification of 51c1e9d6 — confirmed findings to fix

Context: commit 51c1e9d6 ("Complete credit billing and enable implemented features") was verified on 2026-10-27:
gates green (lint, typecheck, test, build, 11 DB gates), Stripe test-mode config correct, Vercel/Railway live,
and a live run on the test workspace (Checkout → Creator, prorated upgrade to Pro, scheduled downgrade + undo,
declined upgrade held as pending until paid). Three independent reviews found the issues below.
Already fixed by the lead (uncommitted, don't redo): stuck "confirming" plan change no longer blocks
reconciliation; Stripe outages propagate instead of reading as conflicts; scheduled seat sync skipped after a
failed live seat update; schedule finalization best-effort; stale default Brand Profile no longer blocks intake
(`brandProfileService.getApplicableDefaultId`).

## Worker A — flag-removal follow-ups (program-rollout.ts was deleted in 51c1e9d6)

A1. Generated images show as available without provider configuration.
`generation-usage.ts:21` checks only the plan. `generated-media-runtime.ts:27-33` builds lazily;
`openAiImageProviderFromEnv` throws `generated_media_provider_not_configured` (`openai-image-provider.ts:63-67`);
`generatedMediaPromptProtectionFromEnv` throws a plain Error → 500. Fix: the capability reports an unavailable
reason (e.g. `provider_unavailable`) when the provider/prompt-protection env is absent, so Studio shows
"temporarily unavailable" (no upgrade offer, no 500); add those env names to the env check script if it checks
presence (scripts/env-check.ts) without printing values.

A2. Facebook Reels publishing enabled with no provider evidence.
The removed guard said "awaiting provider sandbox evidence"; only mocked tests exist. 51c1e9d6 set
`publishingEnabledByDefault: true` in `packages/validators/src/social-provider-capabilities.ts:14` and removed the
freeze check from `social-publication-scheduling.ts`. Fix: restore exactly the pre-51c1e9d6 behaviour for
facebook_reels publishing (look at `git show 4ffcd006:<file>`), but as a static catalog capability (no env flag):
publishing off until a Meta sandbox run is recorded; UI shows it as unavailable/coming soon, not a raw error.

A3. Email operator switch removed but docs not. `apps/worker/.env.example:71-72` and
`packages/services/src/notification.service.ts:126` still describe the removed NOTIFICATION_EMAILS_ENABLED opt-in.
Fix the comments to the current contract (emails send whenever RESEND_API_KEY is configured).

A4. Render hot-path error masking. `campaign-operation.service.ts:1031-1053`: if `execute` throws a typed refusal
(credits, 1080p, length), the failure settlement runs; if settlement errors or loses its claim the user sees a 500
or `campaign_operation_claim_lost` instead of the refusal. Fix: wrap the settlement, log its failure
(structured console.warn JSON), rethrow the original error. Test it.

A5. Duplicate paid calls after an abort. `workflow-run-lifecycle.ts:1794-1822` `releaseAttempt` runs as soon as the
abort fires while the aborted handler may still run, requeueing with `nextAttemptAt: now`, so a peer worker can
start a duplicate immediately (DB writes are fenced, paid external calls — OpenAI TTS, LLM detection, AssemblyAI
submit — are not). Fix: requeue with a short grace delay (choose a value consistent with existing lease/heartbeat
constants in that file), keep fencing unchanged. Critical path: run `test:workflow:db`; add a DB test for the delay.

## Worker B — upgrade-offer P2s

B1. Credits menu offers the next plan even when it leaves zero credits.
`apps/web/app/(app)/_components/credits-menu.tsx:12-14,:65` uses `nextTier(tier)`. Fix: offer the cheapest tier
above the current one whose monthlyCredits > usedCredits + reservedCredits (same rule as `creditsUpgradePrompt` in
`apps/web/lib/authenticated-request-browser.ts`); none → the Billing/Usage link only. Add cases to
`credits-menu.test.tsx` (e.g. Free after a downgrade with 900 used → Business; 1,900 used → no upgrade).

B2. Settled project offered a length upgrade the server wouldn't need.
`apps/web/app/(app)/projects/[projectId]/page.tsx:318-323, :383-389, :889`; `packages/services/src/processing-usage.ts`
`projectCreditUsage` (~:772). When the project's reservation is already `settled` (or `refunded`), `settle()`
returns early without length/credit checks, so a retry is admitted. Fix: `projectCreditUsage` reports the
reservation state (or returns null for settled/refunded) and the page then shows neither the length block nor an
offer for that project. Extend `processing-usage.db.test.ts` and the page contract test.
