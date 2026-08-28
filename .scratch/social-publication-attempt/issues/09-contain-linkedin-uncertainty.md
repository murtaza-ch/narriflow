# 09 — Contain uncertain LinkedIn publication

**What to build:** Publish LinkedIn video posts with durable upload and video identity, recover a lost Post response through an exact author-and-video match when permissions allow, and surface Needs attention when LinkedIn cannot prove the outcome.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] The adapter validates owner identity, member or organization permissions, media facts, commentary, title, visibility, and supported LinkedIn API version before upload initialization.
- [ ] The video URN, upload token facts, part instructions, completed part IDs, and finalized-video state are checkpointed before Post creation.
- [ ] Multipart upload and video processing use bounded memory, deadlines, claim heartbeats, and resumable durable phases.
- [ ] Post creation persists submission start before the request and stores `x-restli-id` as the accepted Provider Receipt.
- [ ] After a lost Post response, an account with the required read permission uses the author finder and exact video URN within the bounded attempt window.
- [ ] Exactly one matching Post settles accepted; zero matches remain reconciling until the deadline; multiple matches become Needs attention without choosing one.
- [ ] Missing member or organization read scope is an explicit recovery capability limitation and leads to Needs attention after an ambiguous create response.
- [ ] A failed upload, failed finalize, rejected Post, permission loss, version sunset, rate limit, and transient provider failure map to stable phase-aware codes.
- [ ] Retrying upload preparation may resume or safely replace an unreferenced video, but an ambiguous Post creation never creates another Post automatically.
- [ ] The UI explains when LinkedIn permissions prevent automatic verification and directs the editor to check LinkedIn.
- [ ] Cleanup never deletes a video URN that may be attached to an accepted or unknown Post.

## Adapter contract and failure-injection tests

- [ ] Pinned fixtures cover upload initialization, multipart instructions, finalization, video status, successful Post ID, Post lookup, and author finder pagination.
- [ ] Tests cover member and organization owners, required write scope, present and absent read scope, exact match, zero match, multiple matches, and edited commentary.
- [ ] Tests inject loss after initialization, each uploaded part, finalize, Post request send, accepted header, receipt write, and settlement.
- [ ] A database-backed recovery test proves one accepted Post or one Needs attention outcome after a lost create response and claim takeover.
- [ ] An isolated opt-in LinkedIn test organization or approved member account verifies current headers and recovery permissions without unrelated content.

## Rollout and recovery safety

- [ ] Pin a currently supported LinkedIn version and fail startup before its configured sunset policy becomes unsafe.
- [ ] Expose required read-scope capability during account validation without breaking write-only accounts that accept Needs attention recovery.
- [ ] Replace the characterized LinkedIn adapter directly; no blind Post retry remains.

## Scope boundaries

- [ ] Do not add articles, documents, images, carousels, sponsored content, organization administration, or engagement collection.
- [ ] Do not require restricted read scopes merely to preserve write-only publication; degrade explicitly when unavailable.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official LinkedIn documentation and `/tdd`; finish with `/code-review`; run uncached LinkedIn adapter, OAuth scope, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
