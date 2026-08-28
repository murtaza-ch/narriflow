# 06 — Resume and reconcile YouTube publication

**What to build:** Publish YouTube Shorts through a durable resumable-upload operation that survives interrupted bytes and lost completion responses without inserting the video twice.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] The adapter validates title, description, category, privacy, made-for-kids setting, media facts, account scopes, and current YouTube capability before initiating upload.
- [ ] The resumable session is persisted in encrypted provider state before video bytes are sent.
- [ ] Upload uses resumable chunks with bounded memory, operation deadlines, progress heartbeats, and safe retry of missing bytes.
- [ ] A reclaimed attempt probes the same session and resumes from the provider-reported byte range rather than creating another session while the original remains recoverable.
- [ ] A status probe after a lost final upload response receives the completed video resource and stores its video ID as the Provider Receipt.
- [ ] An expired or definitively failed session creates a new attempt only when the adapter proves no video was created.
- [ ] The video ID settles Posted even while YouTube processing continues; processing status and external visibility are represented without another upload.
- [ ] A processing failure after accepted upload is reported as a provider processing failure with the accepted video receipt retained.
- [ ] Quota, authentication, audit-enforced privacy, validation, rate-limit, transient server, and permanent upload failures map to stable actionable codes.
- [ ] The external YouTube URL is derived only from a confirmed video ID and remains optional if receipt enrichment fails.
- [ ] Cleanup never deletes or re-uploads an accepted or unknown video.
- [ ] No Narriflow log or snapshot exposes the resumable session URL or access token.

## Adapter contract and failure-injection tests

- [ ] Pinned contract fixtures cover session initiation, partial range, empty range, chunk resume, completed response replay, processing success, processing failure, and session expiry.
- [ ] Tests inject loss after session creation, each chunk, the final byte, provider acceptance, receipt persistence, and Social Post settlement.
- [ ] A database-backed recovery test proves one video insertion across claim expiry and process restart after provider acceptance.
- [ ] Tests cover quota, 401 refresh, 403 scope and audit behavior, 404 expired session, retryable 5xx, malformed response, and missing video ID.
- [ ] An isolated opt-in YouTube account contract uploads private test media, verifies recovery and processing, and cleans up only its confirmed test video.

## Rollout and recovery safety

- [ ] Pin and validate the supported YouTube API behavior and resumable-upload limits before worker startup.
- [ ] Replace the characterized YouTube adapter directly; do not keep a non-resumable or legacy branch.
- [ ] Operator diagnostics distinguish upload session, transferred range class, accepted video, processing, expiry, and unknown without printing provider identifiers in ordinary logs.

## Scope boundaries

- [ ] Do not add channel management, thumbnails, playlists, comments, monetization, or post-publication editing.
- [ ] Do not promise public visibility when YouTube account audit policy forces private uploads.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official YouTube documentation and `/tdd`; finish with `/code-review`; run uncached YouTube adapter, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
