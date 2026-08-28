# 02 — Freeze an idempotent publication intent

**What to build:** Make scheduling create one idempotent Social Post tied to the exact immutable Clip Export Variant, caption, account, settings, and schedule the editor approved, with truthful preparation UX when the export is not ready yet.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] Scheduling accepts a workspace-scoped client idempotency key and returns the original Social Post when the same immutable request is replayed.
- [ ] Reusing the key with a different clip revision, aspect ratio, account, platform, caption, provider settings, or scheduled time returns a typed conflict and changes no state.
- [ ] The browser creates and retains the key before the first scheduling request so a double click, request retry, or lost response cannot create two Social Posts.
- [ ] One exact Clip Export Variant, editor revision, export fingerprint, storage identity, byte length, aspect ratio, caption, provider settings, account, and capability version become Frozen Publication State.
- [ ] Scheduling reuses an existing matching Clip Export or requests one idempotently for the current editor revision and selected output.
- [ ] A Social Post waiting for its exact export projects Preparing video and cannot be claimed for provider submission.
- [ ] Export completion advances the same Social Post to Scheduled without another editor action; export failure shows a media-preparation failure rather than a provider rejection.
- [ ] Later editor saves, ordinary render-cache updates, new exports, account display changes, or refreshed access locations cannot change the frozen publication bytes or content.
- [ ] Missing or deleted frozen media blocks publication before any provider call and gives an actionable product error.
- [ ] Cancel works during Preparing video and Scheduled and atomically prevents later readiness or worker work from reviving the post.
- [ ] The project Publish view and Calendar show Preparing video, its schedule, selected account, and cancellation consistently.
- [ ] Exact export media remains protected from deletion while a nonterminal Social Post references it.
- [ ] Existing `publishing.manage` authorization, workspace isolation, account-platform validation, and accessible-project policy remain enforced.

## Public-interface and failure-injection tests

- [ ] Service and HTTP tests cover fresh schedule, exact replay, immutable-input conflict, concurrent duplicate submission, workspace isolation, wrong account, missing clip, and cancellation.
- [ ] Disposable PostgreSQL tests prove uniqueness and exactly one Social Post under concurrent scheduling.
- [ ] Export integration tests cover existing ready export, newly requested export, partial export, failed export, retry, later editor revision, and protected media retention.
- [ ] Browser tests prove the key exists before the request, survives a lost response, is replaced for a materially edited request, and never exposes storage identity.
- [ ] Failure injection before and after Social Post creation, export request, export binding, readiness projection, and cancellation leaves one recoverable intent.

## Migration and cutover constraints

- [ ] Apply the additive intent and export-reference migration before scheduling code reads it.
- [ ] Existing terminal local Social Posts may remain historical; reset unsupported local nonterminal fixtures rather than adding dual media selection.
- [ ] New Social Posts use only exact Clip Export Variants. Do not retain execution-time fallback to any completed clip render.

## Scope boundaries

- [ ] Do not add Social Publication Attempts, provider submission, attempt retries, or reconciliation.
- [ ] Do not add assisted copy, thumbnails, approval gates, bulk scheduling, or new export options.

## Fresh-task handoff

Implement with `/implement`; drive idempotency and exact export freezing with `/tdd`; finish with `/code-review`; run uncached scheduling, export, HTTP, browser, database, typecheck, lint, test, and build checks.
