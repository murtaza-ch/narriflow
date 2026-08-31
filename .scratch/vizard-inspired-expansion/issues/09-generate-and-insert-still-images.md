# 09 — Generate and insert still images

**What to build:** Add durable generated-image jobs, OpenAI image-provider adaptation, moderation, usage reservation and settlement, Visual Asset finalization, and Studio insertion.

**Blocked by:** [Establish Brand Profile and Visual Asset ownership](01-establish-brand-profile-and-visual-asset-ownership.md), [Extend entitlements, permissions, and program analytics](02-extend-entitlements-permissions-and-program-analytics.md), and [Version the Clip Editor Document for new timed edits](05-version-the-editor-document-for-new-timed-edits.md).

**Status:** implementation-complete — staged rollout evidence pending

**Remaining evidence:** Run the staged internal-to-Creator rollout with bounded concurrency in a deployed worker and record rollback/readback evidence.

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

## Lifecycle evidence — 31 August 2026

- The focused generated-media and OpenAI gate passed 162 tests with 443 assertions across 21 files. It covers atomic Free trial and paid admission, concurrent idempotent replay inside the quota lock, released allowance versus the all-attempt daily abuse ceiling, cancellation at the pre-submit boundary, fair cross-tenant claiming, first-class nonpollable reconciliation, prompt authentication and key rotation, deterministic result staging, exact-result insertion, Brand Profile membership, deletion protection, shared-asset settlement, guarded ingestion, and config-independent maintenance.
- The full disposable-schema Vizard gate passed 25 tests with 340 assertions after applying the ordered migration chain through `20260831230000_project_owned_evidence_and_editor_v2_repair`. It exercised database constraints, claim fencing, usage settlement, stable personal ownership, project-history retention, and orphan-reference safety.
- OpenAI adapter regressions treat a successful response with malformed or missing image bytes, a lost staging response, or a noncanonical storage reference as indeterminate. They retain any provider request evidence, the deterministic result reference, and the usage reservation in `reconciliation_required`; the worker neither polls, refunds, nor resubmits that job.
- A signed-in Chrome session submitted two real OpenAI image jobs, observed the quota move from 20 to 18, reopened the durable gallery, inserted the first result as both B-roll and an image Scene, saved it to the active Brand Profile, replaced that B-roll with the second result, restored the approved result, and deleted the now-unreferenced second asset through the confirmation flow. The first asset remained protected while referenced. Prompt-free structured runtime logs, transactional analytics, undo/redo, timeline playback, and the corrected four-ratio immutable export were also inspected.
- With generation writes disabled, Chrome still reopened both result records, the deleted-state history, the frozen B-roll and Scene references, and the 25.23-second composite timeline while new image submission remained gated. This proves the local rollback contract, not a deployed cohort rollout.

## Rollout

- [ ] Dark-run job and usage state, enable internal generation, then Creator and above with bounded concurrency.

## Scope boundaries

- [x] Do not enable video or motion-graphics generation in the image rollout. Short video remains isolated behind ticket 16's independent provider and rollout gate.

## Fresh-task handoff

Implement with `/tdd`, use official OpenAI documentation during execution, finish with `/code-review`, and run provider, usage, storage, editor, browser, typecheck, and repository tests.
