# 08 — Release and reconcile TikTok moderation

**What to build:** Publish TikTok videos through one durable `publish_id`, release the worker while TikTok processes or moderates the post, and settle from status or verified webhook evidence without starting a second direct post.

**Blocked by:** [04 — Recover claims and bound publication retries](04-recover-claims-and-bound-retries.md).

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] The adapter retrieves current creator information and validates privacy, comments, duet, stitch, cover timestamp, AI disclosure, media size, and account capability before initialization.
- [ ] TikTok `publish_id`, upload identity, selected privacy, and immutable submission facts are checkpointed before video upload.
- [ ] Chunked upload uses bounded memory, correct ranges, operation deadlines, and claim heartbeats.
- [ ] Processing and moderation project Processing on provider, release the worker, and schedule checks using bounded cadence and provider rate limits.
- [ ] Status fetching and verified content-posting webhooks settle the same attempt idempotently by `publish_id`.
- [ ] `PUBLISH_COMPLETE` stores the public post ID when available and settles Posted; delayed public ID enrichment does not repeat publication.
- [ ] Provider-declared failure becomes definitive with the documented failure reason and evidence.
- [ ] A polling timeout remains pending or reconciling within the processing deadline and never creates a second `publish_id`.
- [ ] Duplicate, late, or out-of-order status webhooks cannot reverse a terminal accepted receipt.
- [ ] Authentication, creator-setting changes, moderation duration, rate limits, upload rejection, and permanent provider failures produce actionable stable codes.
- [ ] Cleanup never repeats or deletes an accepted, pending, or unknown direct post.

## Adapter contract and failure-injection tests

- [ ] Pinned fixtures cover creator facts, init, chunk upload, processing, moderation, completed public ID, inbox outcome if supported, and provider failure reasons.
- [ ] Webhook tests cover signature or verification policy, duplicate delivery, out-of-order delivery, unknown `publish_id`, failure, success, and database outage.
- [ ] Tests inject loss after init, each chunk, final upload, first processing response, webhook acceptance, receipt persistence, and settlement.
- [ ] A database-backed recovery test proves one `publish_id` across process restart, long moderation, and mixed polling plus webhook evidence.
- [ ] An isolated opt-in TikTok sandbox or approved test account contract verifies current status behavior without public customer content.

## Rollout and recovery safety

- [ ] Validate TikTok polling rates, chunk limits, scopes, and processing deadline policy at startup.
- [ ] Replace the characterized TikTok adapter directly and remove worker-held polling loops.
- [ ] Diagnostics report normalized moderation state and age without captions, tokens, upload URLs, or full public identifiers.

## Scope boundaries

- [ ] Do not add photo posting, inbox-only authoring UX, sounds, effects, analytics redesign, or moderation appeals.
- [ ] Do not promise a fixed moderation completion time.

## Fresh-task handoff

Implement after ticket 04 with `/implement`; use current official TikTok documentation and `/tdd`; finish with `/code-review`; run uncached TikTok adapter, webhook, attempt recovery, database, opt-in contract, typecheck, lint, test, and build checks.
