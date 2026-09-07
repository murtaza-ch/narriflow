# 09 — Contain uncertain LinkedIn publication

**What to build:** Publish LinkedIn video posts with durable upload and video identity, recover a lost Post response through an exact author-and-video match when permissions allow, and surface Needs attention when LinkedIn cannot prove the outcome.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** completed

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] The adapter validates owner identity, member or organization permissions, media facts, commentary, title, visibility, and supported LinkedIn API version before upload initialization.
- [x] The video URN, upload token facts, part instructions, completed part IDs, and finalized-video state are checkpointed before Post creation.
- [x] Multipart upload and video processing use bounded memory, deadlines, claim heartbeats, and resumable durable phases.
- [x] Post creation persists submission start before the request and stores `x-restli-id` as the accepted Provider Receipt.
- [x] After a lost Post response, an account with the required read permission uses the author finder and exact video URN within the bounded attempt window.
- [x] Exactly one matching Post settles accepted; zero matches remain reconciling until the deadline; multiple matches become Needs attention without choosing one.
- [x] Missing member or organization read scope is an explicit recovery capability limitation and leads to Needs attention after an ambiguous create response.
- [x] A failed upload, failed finalize, rejected Post, permission loss, version sunset, rate limit, and transient provider failure map to stable phase-aware codes.
- [x] Retrying upload preparation may resume or safely replace an unreferenced video, but an ambiguous Post creation never creates another Post automatically.
- [x] The UI explains when LinkedIn permissions prevent automatic verification and directs the editor to check LinkedIn.
- [x] Cleanup never deletes a video URN that may be attached to an accepted or unknown Post.

## Adapter contract and failure-injection tests

- [x] Pinned fixtures cover upload initialization, multipart instructions, finalization, video status, successful Post ID, Post lookup, and author finder pagination.
- [x] Tests cover member and organization owners, required write scope, present and absent read scope, exact match, zero match, multiple matches, and edited commentary.
- [x] Tests inject loss after initialization, each uploaded part, finalize, Post request send, accepted header, receipt write, and settlement.
- [x] A database-backed recovery test proves one accepted Post or one Needs attention outcome after a lost create response and claim takeover.
- [x] An isolated opt-in LinkedIn test organization or approved member account verifies current headers and recovery permissions without unrelated content.

## Rollout and recovery safety

- [x] Pin a currently supported LinkedIn version and fail startup before its configured sunset policy becomes unsafe.
- [x] Expose required read-scope capability during account validation without breaking write-only accounts that accept Needs attention recovery.
- [x] Replace the characterized LinkedIn adapter directly; no blind Post retry remains.

## Scope boundaries

- [x] Do not add articles, documents, images, carousels, sponsored content, organization administration, or engagement collection.
- [x] Do not require restricted read scopes merely to preserve write-only publication; degrade explicitly when unavailable.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official LinkedIn documentation and `/tdd`; finish with `/code-review`; run uncached LinkedIn adapter, OAuth scope, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
