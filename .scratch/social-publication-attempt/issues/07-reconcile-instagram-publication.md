# 07 — Reconcile Instagram container publication

**What to build:** Publish Instagram Reels through a durable media container whose processing and publication state can be recovered after a lost `media_publish` response.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** completed

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] The adapter validates the selected Instagram professional account, permissions, Reel media facts, caption, feed-sharing setting, and publishing-limit capability before container creation.
- [x] The media container ID is persisted before polling or publication.
- [x] Container upload and processing project Processing on provider and release the worker between bounded checks.
- [x] `FINISHED` permits publication of the same container; `ERROR` and `EXPIRED` become stable definitive outcomes.
- [x] `PUBLISHED` settles the attempt as accepted even when the lost `media_publish` response did not return the Instagram media ID.
- [x] A reclaimed attempt queries the existing container and never creates or publishes a second container merely because a response was lost.
- [x] The media ID and permalink enrich the Provider Receipt when available; their absence does not erase confirmed publication.
- [x] Permission revocation, expired token, account mismatch, publishing limit, media rejection, transient Graph failure, and processing timeout map to distinct actions.
- [x] Provider version and polling recommendations are validated and bounded rather than hardcoded across callers.
- [x] Cleanup never deletes or republishes a container whose publication state is unknown or accepted.
- [x] Instagram connection behavior outside publication remains unchanged.

## Adapter contract and failure-injection tests

- [x] Pinned fixtures cover container creation, `IN_PROGRESS`, `FINISHED`, `PUBLISHED`, `ERROR`, `EXPIRED`, media ID response, and permalink enrichment.
- [x] Tests inject failure after container creation, processing completion, publication request send, accepted response, receipt write, and Social Post settlement.
- [x] A database-backed recovery test proves one container publication after claim expiry and a lost `media_publish` response.
- [x] Tests cover permission loss, account mismatch, limit exhaustion, invalid media, rate limit, retryable Graph error, malformed status, and absent permalink.
- [x] An isolated opt-in Meta test account contract verifies container processing and safe receipt recovery without touching unrelated media.

## Rollout and recovery safety

- [x] Pin and validate the supported Meta Graph version and required permissions before enabling the adapter.
- [x] Replace the characterized Instagram adapter directly; no legacy polling or second-publication fallback remains.
- [x] Diagnostics include normalized container phase and outcome while excluding access tokens, signed media URLs, caption, and raw Graph bodies.

## Scope boundaries

- [x] Do not add Facebook, Stories, carousels, thumbnails, collaborators, product tags, or comment moderation.
- [x] Do not change Instagram OAuth except for scopes required to preserve current publishing and reconciliation.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official Meta documentation and `/tdd`; finish with `/code-review`; run uncached Instagram adapter, OAuth regression, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
