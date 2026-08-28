# 10 — Contain uncertain X publication

**What to build:** Publish X video Posts with durable media identity, reconcile a lost create response through an exact recent-timeline media-key match, and surface Needs attention when evidence is absent or conflicting.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] The adapter validates account identity and scopes, caption length, AI disclosure, media facts, current upload capability, and rate limits before initialization.
- [ ] Media ID, media key, chunk progress, finalization, and processing status are checkpointed before Post creation.
- [ ] Chunk upload uses bounded memory, operation deadlines, claim heartbeats, safe segment replay, and provider status guidance.
- [ ] Post creation persists submission start before the request and stores the returned Post ID as the accepted Provider Receipt.
- [ ] After a lost create response, the adapter queries the authorized user's recent Posts in the bounded attempt window with attached-media expansion.
- [ ] Exactly one Post containing the exact media key settles accepted; zero matches remain reconciling until the deadline; multiple matches become Needs attention.
- [ ] A timeline permission or product-tier limitation that prevents exact lookup becomes an explicit recovery capability and eventually Needs attention.
- [ ] Media processing failure, expired media, invalid text, authentication, rate limit, create rejection, and transient provider failures map to stable phase-aware codes.
- [ ] An ambiguous Post create response is never retried automatically even when the media upload itself succeeded.
- [ ] The UI explains that Narriflow could not verify X publication and directs the editor to inspect the account before Publish again.
- [ ] Cleanup never deletes media that may be attached to an accepted or unknown Post.

## Adapter contract and failure-injection tests

- [ ] Pinned fixtures cover initialization, append, finalize, media processing states, successful Post ID, timeline pagination, and attached media-key expansion.
- [ ] Tests cover exact match, zero match, multiple matches, edited Post text, missing timeline access, expired media, authentication, rate limits, and malformed responses.
- [ ] Tests inject loss after init, each segment, finalize, processing success, Post request send, accepted response, receipt write, and settlement.
- [ ] A database-backed recovery test proves one accepted X Post or one Needs attention outcome after a lost create response and claim takeover.
- [ ] An isolated opt-in X test account verifies current upload, create, and timeline contracts without operating on unrelated content.

## Rollout and recovery safety

- [ ] Validate X media limits, scopes, rate limits, and reconciliation window at startup.
- [ ] Replace the characterized X adapter directly; no blind Post retry or caption-only guess remains.
- [ ] Diagnostics report normalized media and lookup phase without caption, token, media upload URL, or full account identity.

## Scope boundaries

- [ ] Do not add threads, replies, quote Posts, polls, communities, cards, DMs, Ads, or post-publication editing.
- [ ] Do not treat matching text alone as publication evidence.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official X documentation and `/tdd`; finish with `/code-review`; run uncached X adapter, OAuth scope, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
