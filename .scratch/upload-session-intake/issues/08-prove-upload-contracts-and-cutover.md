# 08 — Prove provider contracts, cost budgets, and cutover

**What to build:** Close the Upload Session change with production-adapter contracts, database recovery drills, measured cost and latency budgets, operational safeguards, full browser proof, and removal of any remaining old intake behavior.

**Blocked by:** [07 — Finish safe pause, discard, and verification UX](07-finish-safe-upload-ux.md).

**Status:** ready-for-agent

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [ ] Every local-file upload path uses the Upload Session interface for admission, transfer planning, grants, resume, finalization, compensation, reconciliation, expiry, and Ingest Job handoff.
- [ ] Hono, React, browser transfer, worker maintenance, persistence, and R2 remain adapters and contain no competing state machine or provider recovery policy.
- [ ] No request or browser record exposes or accepts provider upload ID, storage key, provider expiry authority, or browser-chosen part count.
- [ ] Old Project-owned upload methods, old resume classifiers that duplicate module behavior, legacy payload validators, compatibility statuses, and dead-end reconciliation copy are removed.
- [ ] Immutable upload and reconciliation configuration validates once at startup with safe defaults and finite bounds.
- [ ] Structured diagnostics and metrics cover admission replay, transfer kind, planned parts, grants, provider operation class, resume, completion, reconciliation, compensation, expiry, declared abandoned bytes, first-grant latency, finalize duration, and terminal outcome.
- [ ] Diagnostics contain no signed URLs, credentials, provider upload IDs, object keys, raw ETags, frozen settings, full file names, or raw provider errors.
- [ ] The operational runbook documents migration deploy order, R2 CORS, exposed ETag, signed Content-Type, incomplete-multipart lifecycle, reconciliation controls, metrics, incident diagnosis, rollback, and safe cleanup.
- [ ] The architecture review marks Upload Session complete only after all contract, browser, performance, and recovery evidence is recorded.

## Provider and database proof

- [ ] Isolated production R2 contracts cover signed single PUT, signed multipart parts, uniformity, ETag exposure, paginated ListParts, exact-key unfinished-upload listing, completion, embedded SDK error handling, HeadObject, NoSuchUpload, abort, delete, grant expiry, and CORS behavior.
- [ ] Every storage fixture uses a random isolated prefix, cleans up in success and failure, and never runs destructive checks against a shared project or workspace prefix.
- [ ] A disposable PostgreSQL drill applies the complete migration chain and proves idempotent admission, immutable conflicts, concurrent finalize, lost bind, ambiguous completion, lease takeover, stale claims, exactly-once handoff, event replay, expiry, and compensation.
- [ ] Failure injection before and after every durable phase produces one recoverable or terminal outcome with no duplicate Project, Content Pack, Ingest Job, or referenced object deletion.
- [ ] Full module behavior tests use the Upload Session public interface and do not preserve obsolete helper tests after equivalent coverage exists.

## Cost and performance budgets

- [ ] A normal small upload records one PutObject and one verification probe, with no multipart operations.
- [ ] A normal large upload records one multipart initiation, exactly the planned part writes, one completion, and one verification probe, with no ListParts.
- [ ] Resume, ambiguous start, ambiguous completion, compensation, and expiry fixtures record and assert their expected additional provider calls.
- [ ] Small, medium, 1 GiB, and 5 GiB fixtures record time to first grant, grant response size, steady throughput, retry bytes, browser peak memory, finalize latency, reconciliation latency, and provider operation counts.
- [ ] The final multipart path does not reduce representative steady-state throughput beyond the approved tolerance and does not exceed the recorded browser memory budget.
- [ ] R2 Class A operation counts and declared abandoned-byte age are available as operational cost proxies.

## End-to-end verification

- [ ] Authenticated browser verification covers a small audio single PUT, multipart video, exact-file Pause and resume, refreshed grants, simulated lost finalize response, leaving during Verifying, completed replay, safe Discard, and navigation into the queued Project.
- [ ] The created Project retains the frozen brand, language, caption, generation, and source facts and proceeds through the unchanged Ingest Job path.
- [ ] Link and RSS intake, project lists, processing timeline, quota messaging, and post-ingest generation remain unchanged.
- [ ] Repository typecheck, lint, full tests, production build, migration deploy chain, uncached focused suites, disposable database drill, isolated R2 contracts, and browser checks all pass.
- [ ] Final Standards and Spec review reports no unresolved findings.

## Rollout and recovery safety

- [ ] Apply pending migrations before deploying code that reads the new session shape.
- [ ] Use the pre-production direct cutover. Do not add a feature flag, shadow writes, mixed-version protocol, or fallback to the removed implementation.
- [ ] Reset incomplete local test Upload Sessions and browser resume records as needed; do not migrate obsolete pre-production state.
- [ ] Rollback instructions preserve or deliberately reset local session data and never ask operators to delete an unscoped storage prefix.

## Scope boundaries

- [ ] Do not broaden this ticket into upload history, batch uploads, a generic job framework, billing changes, new media validation products, or unrelated architecture candidates.
- [ ] Do not mark the recommendation complete from unit tests alone. Provider, database, browser, cost, and recovery evidence are all required.

## Fresh-task handoff

Implement after ticket 07 with `/implement`; use `/tdd` for any uncovered contract or recovery case; finish with `/code-review`; run the complete uncached verification matrix and record reproducible completion evidence in this ticket and the architecture review.
