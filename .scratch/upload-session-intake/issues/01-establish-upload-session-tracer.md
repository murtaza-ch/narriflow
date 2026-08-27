# 01 — Establish the Upload Session tracer and cut over multipart intake

**What to build:** Move the current successful local-file multipart journey behind one workspace-owned Upload Session interface. A creator can submit once, refresh or retry with the same client intent, transfer server-planned parts, and arrive at one queued Project without learning provider identifiers or creating an empty Project before the bytes are verified.

**Blocked by:** None — can start immediately.

**Status:** completed

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [x] Add the agreed Upload Session definition to the domain glossary and record its ownership, state machine, and Ingest Job handoff in an ADR.
- [x] A durable Upload Session belongs directly to a workspace while transfer is incomplete and carries a preallocated Project ID, actor facts, source declaration, browser fingerprint, frozen brand snapshot, and frozen generation settings.
- [x] A fresh open command writes the session reservation before starting provider state and enforces one immutable client idempotency key per workspace.
- [x] Replaying the same key and immutable inputs returns the same Narriflow session and transfer facts without another quota, brand, Project, or provider initiation operation.
- [x] Reusing an idempotency key with different source or generation inputs returns a stable typed conflict and changes no state.
- [x] The server computes multipart part size and count from declared bytes, validates provider limits, and rejects unsupported type or size before provider work.
- [x] The browser receives only the Narriflow session ID, preallocated Project ID, transfer plan, expiry, completed-part facts, and scoped upload grants. Provider upload ID and object key remain private.
- [x] Provider upload IDs are accepted as bounded opaque strings inside the storage adapter and are never parsed as UUIDs.
- [x] A normal multipart upload completes through the Upload Session module and creates exactly one Project, Content Pack, and Upload Finalize Ingest Job only after exact-object verification.
- [x] The Project preserves the submitted title, workspace ownership, actor attribution, brand snapshot, language, and Content Pack settings.
- [x] Retrying open after a successful handoff returns `queued_for_ingest` and the same Project ID without provider probes or duplicate rows.
- [x] Hono routes authenticate, rate-limit, validate, and translate typed module outcomes only. They do not choose transitions, part policy, storage identity, or handoff order.
- [x] The browser uses the new Narriflow session contract and a new resume-record version. It does not submit part count, provider upload ID, or object key.
- [x] Remove the old Project-owned multipart start and completion orchestration, old provider-ID UUID assumptions, and old browser resume parser in this cutover. Do not leave a compatibility route or selector.
- [x] Services continue to be re-exported through the shared service package interface.

## Public-interface and failure-injection tests

- [x] Module-interface tests drive fresh open, idempotent replay, active resume, normal multipart finalize, completed replay, immutable-input conflict, unsupported input, quota refusal, and workspace isolation.
- [x] Tests assert observable session, provider, Project, Content Pack, Ingest Job, and returned outcome facts rather than private helper or SDK call order.
- [x] A recording storage adapter proves one provider initiation on the normal and idempotent-replay paths and verifies opaque provider identity never escapes.
- [x] Disposable PostgreSQL tests prove the workspace idempotency constraint and exactly-one handoff under concurrent open and finalize calls.
- [x] Browser contract tests prove the current-version record is written before the first request, exact-file replay uses the same client key, corrupt records fail safely, and provider details never enter browser storage.
- [x] Hono contract tests prove authentication, rate limiting, strict payloads, typed status mapping, and workspace ownership.

## Migration and cutover constraints

- [x] Replace the pre-production Upload Session shape directly. Apply the migration before code that reads it and reset incomplete local sessions rather than adding dual reads or writes.
- [x] Keep the existing 5 GiB product limit, supported media types, quota gate, Content Pack meaning, and post-ingest behavior unchanged.
- [x] Until ticket 03 lands, all accepted files may continue through the new multipart tracer. The old implementation must not remain active beside it.
- [x] The repository stays green after this ticket. Later tickets deepen recovery and optimize transfer without repairing a knowingly broken foundation.

## Scope boundaries

- [x] Do not add single PUT, bounded grant windows, background reconciliation, finalization leases, or redesigned Pause and Discard UX in this ticket.
- [x] Do not change link or RSS intake, Ingest Job claiming, post-ingest Workflow Runs, billing policy, or project retention policy.

## Completion evidence

- Upload Session is workspace-owned and durable before provider work, with immutable workspace idempotency, a preallocated Project ID, frozen brand/generation inputs, private provider identity, and one atomic Project/Content Pack/Ingest Job handoff after exact-object verification.
- The old Project-owned multipart routes, browser resume shape, and worker re-probe were removed. The current browser, Hono boundary, service package, R2 adapter, worker intake, migration, glossary, and ADR all use the new session contract.
- Module, browser, HTTP, worker, live R2, and disposable PostgreSQL tests pass, including concurrent open/finalize and exactly-once handoff. The full monorepo typecheck, tests, Biome, and production build pass.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the public seam and database concurrency with `/tdd`; finish with `/code-review`; run uncached focused tests, the migration chain, `bun run typecheck`, `bun run lint`, and the production build.
