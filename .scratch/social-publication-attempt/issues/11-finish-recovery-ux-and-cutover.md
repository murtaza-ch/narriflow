# 11 — Finish recovery UX, operations, and direct cutover

**What to build:** Complete the user and operator recovery flow across Publish, Calendar, HTTP, MCP, worker, and provider adapters; remove every obsolete publisher path; and prove the direct pre-production cutover through database, provider, and browser recovery drills.

**Blocked by:** [05 — Make publication webhooks idempotent and reconcilable](05-make-webhook-idempotent-and-reconcilable.md); [06 — Resume and reconcile YouTube publication](06-resume-youtube-publication.md); [07 — Reconcile Instagram container publication](07-reconcile-instagram-publication.md); [08 — Release and reconcile TikTok moderation](08-reconcile-tiktok-moderation.md); [09 — Contain uncertain LinkedIn publication](09-contain-linkedin-uncertainty.md); [10 — Contain uncertain X publication](10-contain-x-uncertainty.md).

**Status:** completed

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] Publish and Calendar use one status mapper for Preparing video, Scheduled, Publishing, Processing on provider, Reconciling, Posted, Failed, Needs attention, and Cancelled.
- [x] Failed means definitive non-publication and offers only actions that are safe for its disposition; Needs attention explains that the post may already be live and never shows ordinary Retry.
- [x] Recheck inspects only the existing attempt and provider operation and cannot create a new Social Publication Attempt.
- [x] Confirm published requires `publishing.manage`, captures actor, bounded reason, evidence kind, and optional platform URL or ID, and validates ownership where the adapter supports it.
- [x] An unvalidated manual confirmation is labeled manual, remains auditable, and does not fabricate provider metrics.
- [x] Publish again is available only from Needs attention, uses platform-specific duplicate-risk copy, requires explicit acknowledgement and reason, and creates a linked new attempt without rewriting the uncertain attempt.
- [x] Manual recheck, confirmation, and republish use compare-and-set rules so a late provider success or concurrent actor cannot create conflicting truth.
- [x] Expired and revoked credentials lead to reconnect guidance; validation and media failures name the action the editor can take; rate limits show the next retry time.
- [x] Cancellation disappears once submission may have started and never claims to remove an already accepted provider operation.
- [x] Workspace restriction stops new submissions and retries but permits read-only reconciliation and settlement of already accepted work.
- [x] Account disconnection stops new provider work immediately and preserves an honest Needs attention result when it removes reconciliation access.
- [x] Project deletion and retention purge refuse or defer while a publication is Publishing, Processing, Reconciling, or Needs attention; terminal evidence follows the approved retention policy.
- [x] Status changes are announced accessibly, focus moves to the recovery message or initiating control, motion respects reduced-motion preferences, and color is never the only status signal.
- [x] The Blueline design uses semantic tokens, hairline status rows, 3px stripes, timecode styling for times, true elevation only for the duplicate-risk confirmation, and at most one solid action per view.
- [x] HTTP and MCP expose typed product facts and allowed intents without provider checkpoint state, credentials, signed URLs, or raw errors.
- [x] A read-only operator command inspects one Social Post or attempt with identifier-safe output and can request targeted reconciliation without creating a new provider submission.
- [x] Structured diagnostics and metrics cover queue age, claims, lease takeover, stale settlement, provider operations, pending and reconciliation age, retry, attention, manual decision, receipt, cleanup, and terminal outcome without sensitive content.
- [x] Operational documentation covers migrations, worker drain and restart, provider versions and scopes, webhook contract, diagnosis, safe recheck, local reset, rollback drain, and escalation for unknown outcomes.
- [x] Domain glossary and ADR reflect the final implementation, and the architecture review is marked complete only after all evidence below passes.
- [x] The old status-only claim, generic stalled-post failure, platform switch, blind retry, execution-time render selection, bare-2xx webhook success, and duplicate status copy are absent.

## Full recovery and contract proof

- [x] A disposable PostgreSQL drill applies the complete migration chain and proves schedule idempotency, exact export retention, attempt and receipt uniqueness, atomic settlement, lease takeover, stale fencing, account serialization, fairness beyond several batches, retry lineage, manual-decision races, and rollback.
- [x] Failure injection before and after every durable phase for accepted, pending, definitive failure, unknown, retry, manual confirmation, and republish ends with one observable recoverable outcome and no untracked duplicate.
- [x] Pinned adapter contracts pass for webhook, YouTube, Instagram, TikTok, LinkedIn, and X under their configured API versions.
- [x] Opt-in isolated provider checks record evidence for every available sandbox or approved test account and never use live customer accounts or unrelated content.
- [x] Worker verification proves one slow provider cannot block other accounts or other worker loops and that graceful shutdown resumes from durable checkpoints.
- [x] HTTP and MCP contracts prove authorization, workspace isolation, strict validation, idempotency, typed errors, Retry-After guidance, and absence of internal provider state.
- [x] React and real-DOM tests cover every status, retry timing, reconnect, stale polling, Recheck, validated and manual confirmation, duplicate warning, concurrent transition, accessible announcement, and focus recovery.
- [x] Authenticated browser verification schedules an exact export, observes provider processing, recovers a simulated lost response, resolves Needs attention, confirms a published URL, exercises duplicate-risk republish confirmation, and verifies Calendar consistency without console errors.
- [x] Repository typecheck, lint, full tests, production build, migration deploy chain, focused uncached suites, provider contracts, database drill, and browser checks all pass.
- [x] Final Standards and Spec review reports no unresolved findings.

## Migration and rollout safety

- [x] Apply all pending migrations before code that reads attempts, receipts, frozen intent, or new states.
- [x] Drain social workers, deploy the direct new protocol, restart workers, and observe representative accepted, pending, failed, and attention outcomes.
- [x] Do not add a shadow publisher, dual reads, dual writes, legacy status parser, provider fallback renderer, or mixed old and new workers.
- [x] Reset obsolete local nonterminal fixtures deliberately; preserve or deliberately reset terminal local history according to the pre-production policy.
- [x] Rollback drains social workers first and preserves attempt and receipt evidence or performs an explicit local-only reset. It never blindly republishes uncertain work.

## Scope boundaries

- [x] Do not add Facebook, assisted copy, thumbnails, bulk scheduling, approval gates, post deletion or editing, or analytics-dashboard redesign.
- [x] Do not mark the recommendation complete from mock happy paths or one provider alone.

## Fresh-task handoff

Implement after tickets 05 through 10 with `/implement`; use `/tdd` for uncovered recovery or UX behavior; finish with `/code-review`; run the full uncached verification matrix and record reproducible completion evidence in this ticket and the architecture review.
