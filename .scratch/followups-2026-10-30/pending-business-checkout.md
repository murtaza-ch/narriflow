# Pending Business checkout cleanup

**Status:** done

**What to build:** Reuse one pending Business workspace per creator; handle Stripe expiry; bounded guarded cleanup and quiet resume/cancel controls.

**Ownership:** billing service/module/tests, workspace pending creation, billing API/client, workspace switcher and checkout form, worker maintenance wiring. Avoid other follow-up tracks.

## Comments

- Implemented `checkout.session.expired` wake-up, a 25-workspace maintenance sweep, owner-only resume/cancel endpoints, and per-creator pending-workspace reuse under a transaction advisory lock. Existing B01 receipts stay intact. Terminal Checkout keys rotate safely on the same Workspace.
- Cleanup waits at least 48h from Workspace creation and 24h after every recorded session expiry. Cancel fences unfinished preparations and expires open sessions. Both paths protect content, additional members and any local/provider subscription history, and recheck locked rows before deletion. No migration; no environment changes, commits, or shared DB writes.
- `bun test` targeted services, API, API-client, new-workspace and switcher suites: 108 passed, 0 failed. Switcher wrapper executes three isolated DOM/browser cases, including both actions and previous-selection restoration.
- `.scratch/api-extraction/db-gate.sh bun run test:workspace-billing:db`: 25 passed. Includes concurrent pending creation, missing/open/expired/complete Checkout, active/canceled/incomplete-expired subscriptions, content/member/history protection, and concurrent Project/Checkout creation during provider verification.
- `.scratch/api-extraction/db-gate.sh bun run test:processing-usage:db`: 31 passed.
- `bun run typecheck`: 15/15 packages passed. `bun run lint`: passed, 11 existing CSS warnings + 1 info. Owned-path Biome and `git diff --check` clean.
- API inventory passed, 283 routes with no problems. Public OpenAPI check passed, 31 REST operations. Web/API split gate passed.
- Stripe endpoint `we_1UVobgFB4NArILpPk1Kkgqrh` read-only inspection confirmed enabled, 19 events, `checkout.session.expired` absent. Operator must add that event; no Stripe changes made. Updated billing runbook.
- Browser check note: Next MCP compilation issues empty; runtime config/session errors empty. Isolated agent-browser session reached Clerk sign-in, so an authenticated visual pass remains for the orchestrator. No login credentials requested or live checkout created. Browser session closed. DOM fixture verifies the actual switcher component, neutral hint, no auto-open dialog/requests, Resume navigation, Cancel and previous Workspace restoration.
