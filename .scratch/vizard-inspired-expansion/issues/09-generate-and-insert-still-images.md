# 09 — Generate and insert still images

**What to build:** Add durable generated-image jobs, OpenAI image-provider adaptation, moderation, usage reservation and settlement, Visual Asset finalization, and Studio insertion.

**Blocked by:** [Establish Brand Profile and Visual Asset ownership](01-establish-brand-profile-and-visual-asset-ownership.md), [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md), and [Version the Clip Editor Document for new timed edits](05-version-the-editor-document-for-new-timed-edits.md).

**Status:** done

**Specification:** [Generated B-roll and visual assets](../features/generated-media.md)

## Observable acceptance criteria

- [x] Generated Media Job persists lifecycle, idempotency, prompt origin, protected prompt material, moderation, provider reference, usage reservation, result asset, and retry state.
- [x] The private provider contract supports submit, poll, cancel, safety normalization, usage, and result retrieval.
- [x] The first adapter uses configured `OPENAI_API_KEY` and `OPENAI_IMAGE_MODEL` without a hardcoded dated model.
- [x] Usage is reserved before submit, finalized once after successful asset publication, and released for known terminal non-success.
- [x] Unknown provider outcomes reconcile before refund or retry.
- [x] Provider output passes guarded download, media validation, fingerprinting, attempt-scoped upload, final publication, and orphan reconciliation.
- [x] Studio generates from transcript selection, B-roll cue, or manual prompt and inserts only after explicit user action.
- [x] Completed results can become B-roll, an image Scene Block, or a Brand Profile asset.

## Tests and failure injection

- [x] Provider tests inject validation error, safety rejection, timeout, waiting, rate limit, lost response, duplicate completion, cancellation, and malformed output.
- [x] Usage tests prove exactly-once settlement and no finalized usage for known failure, rejection, or cancellation.
- [x] Storage tests cover guarded egress, oversized media, MIME mismatch, upload crash, database crash, and orphan cleanup.
- [x] Browser tests cover leaving Studio, reopening, result gallery, insertion, replacement, save to brand, and deletion.
- [x] Logs and analytics contain no prompt, transcript context, provider payload, or signed URL.

## Rollout

- [x] Enable the generated-media write group for entitled plans with bounded per-workspace usage and concurrency.

## Scope boundaries

- [x] Do not implement video or motion-graphics generation in this ticket.

## Fresh-task handoff

Implement with `/tdd`, use official OpenAI documentation during execution, finish with `/code-review`, and run provider, usage, storage, editor, browser, typecheck, and repository tests.
