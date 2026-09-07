## Problem Statement

Narriflow's architecture review is marked complete, but three cross-cutting problems remain in the current codebase.

Clip deletion and several compensation paths discard object-storage deletion failures. A user can receive a successful deletion even though render, preview, or dub media remains in storage with no database reference and no retry record. This weakens deletion guarantees, creates unbounded storage leakage, and makes privacy-related cleanup impossible to prove.

Repository verification also gives mixed signals. The root lint command reports success without linting code, while CI invokes the real Biome check separately. The normal test aggregate is substantial, but database suites intentionally skip unless run through disposable-schema commands. CI enforces only the Workflow Run database suite, leaving Upload Session, Workspace Billing, Social Publication Attempt, Clip Editor Document Persistence, and Authenticated Request Policy database invariants as manual checks.

Finally, Clip Editor Document equality is repeated across the Studio Editing Session, browser recovery, shared validation, and persistence. Most comparisons serialize the full document, including its transcript. No current correctness defect is known because current producers parse and normalize documents before comparison, but the repeated policy creates unnecessary editing-path work and makes future semantic drift more likely.

## Solution

Make media deletion recoverable through one Media Cleanup module. Clip deletion must fail closed when storage deletion is incomplete, preserving the Clip row so the user can retry. Mutation and compensation paths that have already committed database state must preserve every unreferenced object as a durable cleanup obligation before returning. The existing editor-specific cleanup worker becomes the shared execution owner for exact-key deletion, retry, fencing, and identifier-safe diagnostics.

Make repository verification truthful. The documented root lint command must run the real Biome check. Keep database tests isolated from the fast default unit aggregate, but run every critical disposable-schema suite in CI as explicit parallel jobs. Remove no-op scripts from official success counts where they provide no verification, and update repository guidance and architecture-review counters to match current behavior.

Define typed Clip Editor Document equality in the shared validators module. The Studio Editing Session and Clip Editor Document Persistence must use the same domain equality rules, with reference fast paths and field-aware short-circuiting. Generic JSON merging and unrelated composition, publication, form, and cache fingerprints remain local to their own contracts.

## User Stories

1. As a Narriflow user, I want clip deletion to report success only when its referenced media has been deleted, so that I can trust the deletion result.
2. As a Narriflow user, I want a temporary storage outage during clip deletion to produce a retryable failure, so that I can try again without losing the Clip record needed for recovery.
3. As a Narriflow user, I want retrying a partially completed deletion to be safe, so that objects already removed during the first attempt do not cause the retry to fail.
4. As a Narriflow user, I want preview, render, and dub media covered by the same deletion guarantee, so that no class of clip-owned media is silently left behind.
5. As a Narriflow user, I want replacing detected clips to retire old media eventually even when object storage is temporarily unavailable, so that regeneration does not accumulate invisible storage.
6. As a Narriflow user, I want a failed clip duplication to clean up any copied media, so that failed actions do not create hidden retained content.
7. As a Narriflow operator, I want every unreferenced media object to have either an active database owner or a durable cleanup obligation, so that orphaned objects are recoverable.
8. As a Narriflow operator, I want media-cleanup retries to be leased and fenced, so that multiple workers cannot incorrectly settle the same cleanup attempt.
9. As a Narriflow operator, I want missing storage objects treated as successful cleanup, so that idempotent retries converge.
10. As a Narriflow operator, I want temporary, persistent, configuration, and cancelled storage failures classified consistently, so that retry behavior and diagnostics match the failure.
11. As a Narriflow operator, I want cleanup diagnostics to contain stable project, clip, phase, attempt, outcome, and elapsed-time facts, so that I can investigate failures without exposing object keys or provider payloads.
12. As a Narriflow operator, I want cleanup obligations to survive Clip-row removal when the producing mutation has already committed, so that background recovery does not depend on a deleted relation.
13. As a Narriflow engineer, I want one Media Cleanup interface for deferred exact-key deletion, so that each producer does not recreate retry and settlement policy.
14. As a Narriflow engineer, I want synchronous Clip deletion and deferred cleanup to have distinct outcomes, so that a helper cannot silently apply best-effort semantics to a fail-closed operation.
15. As a Narriflow engineer, I want the pre-production cutover to replace the editor-only cleanup path directly, so that no legacy and generic cleanup implementations run in parallel.
16. As a Narriflow engineer, I want `bun run lint` to execute the repository's real Biome check, so that a green local command means code was inspected.
17. As a Narriflow engineer, I want packages without a meaningful lint or test task omitted from aggregate success counts, so that task totals do not imply coverage that does not exist.
18. As a Narriflow engineer, I want the fast default test aggregate to remain suitable for local development, so that database isolation does not slow every edit-test cycle.
19. As a Narriflow engineer, I want skipped database suites reported clearly in the normal aggregate, so that a green unit run is not mistaken for database verification.
20. As a Narriflow maintainer, I want every critical disposable-schema database suite enforced on pull requests, so that transaction and concurrency regressions cannot merge after a one-time manual drill.
21. As a Narriflow maintainer, I want database suites isolated from one another, so that schema state and cleanup from one module cannot make another module pass or fail.
22. As a Narriflow maintainer, I want database jobs to run in parallel where possible, so that stronger verification does not create an unnecessarily long serial CI gate.
23. As a Narriflow maintainer, I want CI to retain the existing production dependency audit and build gates, so that database coverage is additive rather than replacing current checks.
24. As an agent implementing Narriflow changes, I want repository instructions to name the actual lint and test behavior, so that I choose the right verification commands.
25. As an agent reviewing architecture work, I want the architecture report's file and test counts to match current checks, so that the report does not present stale evidence as current evidence.
26. As a Studio user, I want semantically unchanged edits to remain no-ops, so that autosave, undo history, Reset availability, and Device Draft durability do not change unnecessarily.
27. As a Studio user, I want any real Clip Editor Document change to mark the session dirty, so that no save is suppressed by an overly broad equality rule.
28. As a Studio user, I want cloud convergence and Device Draft removal to use the same equality policy, so that recovery behavior cannot disagree with autosave behavior.
29. As a Studio user editing a long transcript, I want dirty-state checks to avoid repeatedly serializing the complete document when fields already prove a difference, so that editing remains responsive.
30. As a Narriflow engineer, I want Clip Editor Document equality owned by the shared domain module, so that browser and server callers cannot drift.
31. As a Narriflow engineer, I want ordered arrays such as transcript utterances and visual layers to remain order-sensitive, so that the comparator does not erase meaningful changes.
32. As a Narriflow engineer, I want normalized deleted ranges compared according to their domain meaning, so that equivalent range sets remain no-ops.
33. As a Narriflow engineer, I want persistence to canonicalize and validate documents before equality decisions, so that equality never substitutes for schema validation.
34. As a Narriflow engineer, I want generic three-way draft merging to retain its local JSON-value comparison, so that document equality does not become an unrelated universal serializer.
35. As a Narriflow engineer, I want composition fingerprints, publication idempotency fingerprints, caption-form dirty checks, and cache signatures left under their current owners, so that unrelated contracts are not coupled.

## Implementation Decisions

- The Clip Service interface remains the user-facing seam for Clip deletion. A deletion attempt must enumerate all referenced preview, render, and dub objects, attempt every deletion, treat an already-missing object as success, and return a typed retryable failure when any genuine storage failure remains.
- Clip deletion must not remove the Clip row while genuine storage failures remain. A retry sees the same row and media inventory. Objects removed during an earlier attempt are accepted as already complete.
- The existing Project deletion behavior is the precedent for fail-closed object removal. Clip deletion should match its observable guarantees rather than call a best-effort helper.
- Deferred exact-key deletion becomes one generic Media Cleanup module. Its public interface owns claim, lease renewal, completion, rescheduling, release, storage-error classification, backoff, and safe diagnostics.
- The editor-specific cleanup obligation and worker are replaced in the same change. Narriflow's pre-production policy forbids a legacy editor worker running beside the generic worker.
- The cleanup obligation schema records a stable origin and cleanup class, project and clip identifiers where applicable, the exact private object key, attempt count, next-attempt time, claim identity and expiry, bounded failure code, completion time, and timestamps.
- Cleanup obligations must not require the source Clip row to remain. Domain identifiers are diagnostic and ownership facts, not cascading foreign keys that can erase pending cleanup work.
- Obligation uniqueness prevents two active obligations for the same cleanup meaning and exact object key. Re-admission is idempotent.
- Clip Editor Document Persistence continues to create cleanup obligations atomically with accepted document mutations that remove the last ordinary reference to mutable renders, preview proxies, or preview peaks.
- Detected-clip replacement must create cleanup obligations in the same database transaction that removes the last render references.
- Duplicate compensation must leave a durable cleanup obligation for every copied object that is not adopted by a committed duplicate Clip. The implementation may use provisional obligations, but it must preserve the invariant that every successful copy is either referenced by the duplicate Clip or recoverable by Media Cleanup.
- Cleanup diagnostics and error responses never include object keys, signed URLs, provider identifiers, raw provider bodies, or document content.
- Existing cleanup retry limits, bounded configuration, structured diagnostics, and worker polling behavior are retained unless a test proves they cannot support the generalized module.
- The browser-facing delete contract gains or reuses a stable retryable storage-incomplete failure code. Authenticated Request Policy adapters translate it without exposing provider errors.
- The root lint command runs the repository-wide Biome check directly. The official local command and CI command must have the same semantics.
- Workspace lint scripts that only print `no-op` are removed from official aggregation. Packages may omit a lint task when the root repository check already owns their files.
- The root test aggregate remains the fast unit and deterministic contract suite. It does not silently enable database tests that require migrations and disposable schemas.
- Critical database verification remains exposed as explicit disposable-schema commands. CI runs Workflow Run, Upload Session, Workspace Billing, Social Publication Attempt, Clip Editor Document Persistence, and Authenticated Request Policy database commands.
- Database CI jobs use isolated PostgreSQL state and always clean up their schema or disposable service. They may run as a matrix or equivalent parallel jobs.
- Database jobs are required checks for pull requests and pushes. A skipped database suite is not a passing database gate.
- Packages with no meaningful tests may omit a test script instead of reporting a successful no-op task. Adding broad new package-local test coverage is not implied by script cleanup.
- Repository guidance states that web tests are active and explains which commands cover fast tests versus database invariants.
- The architecture review's summary counters are refreshed from current commands after the implementation lands.
- The shared validators module owns typed `editorDocumentsEqual` and `deletedRangesEqual` interfaces.
- Equality checks use a reference fast path, then compare scalar fields and domain arrays with early exits. Ordered document arrays remain order-sensitive.
- Deleted ranges are normalized before comparison. Callers that already hold schema-parsed documents may use the typed comparator directly; persistence still parses and canonicalizes untrusted or stored input first.
- Studio Editing Session dirty-state projection, cloud convergence, Device Draft checkpoint/removal, Reset eligibility, and derived-media invalidation use the shared typed equality rules.
- Clip Editor Document Persistence uses the same typed equality after canonicalization.
- Generic draft three-way merge keeps a local arbitrary-JSON comparator for recursive merge decisions. Only its whole-document decisions may use the typed document comparator.
- No universal stable-JSON utility is introduced. Composition plans, publication intent, upload resume identity, small form dirty checks, and cache signatures remain under their existing modules.
- Equality changes do not alter the persisted Clip Editor Document schema, revision contract, API payloads, or composition-plan fingerprint format.

## Testing Decisions

- Good tests assert observable outcomes through a module interface. They do not assert private helper calls, internal array traversal, raw SQL shape, or the number of `JSON.stringify` invocations.
- Clip deletion tests drive the Clip Service interface with storage and persistence adapters. A genuine partial storage failure must attempt every object, preserve the Clip row, and return the retryable storage-incomplete outcome.
- Clip deletion tests cover already-missing objects, mixed missing and successful objects, a second attempt after partial success, database-row deletion failure after storage success, and active-publication admission rules.
- Detected-clip replacement tests verify that removing old render references and creating durable cleanup obligations is atomic. Failure before commit leaves the old references intact; success leaves obligations for every retired object.
- Duplicate tests verify that each successfully copied but unadopted object becomes recoverable cleanup work when duplicate persistence fails.
- Media Cleanup module tests cover claim fencing, expired-claim recovery, lease renewal, completion, temporary retry with bounded backoff, missing-object completion, configuration and persistent failures, cancellation, and claim loss during settlement.
- Media Cleanup diagnostics tests assert stable identifiers, phase, attempt, outcome, failure code, and elapsed time. They also assert that object keys and provider data are absent.
- PostgreSQL tests verify obligation uniqueness, concurrent claims, stale settlement rejection, persistence across Clip deletion, and atomic creation with document and detected-clip mutations.
- Existing Project deletion tests are prior art for fail-closed storage deletion and retryable row preservation.
- Existing Editor Media Cleanup deterministic and PostgreSQL suites are prior art for worker fencing, classification, and durable settlement. They should move to the generalized Media Cleanup interface rather than be duplicated.
- Existing Clip Editor Document Persistence PostgreSQL tests are prior art for atomic cleanup-obligation creation.
- Repository script verification proves that `bun run lint` invokes Biome and returns Biome's exit status. A task summary containing only successful no-op lint tasks is no longer accepted.
- CI configuration tests or review checks confirm that every critical database command is present as a required job and receives isolated PostgreSQL state.
- Each database runner must fail when its test process fails, clean up disposable state on success or failure, and preserve enough logs to identify the failing module without printing secrets.
- The normal test aggregate must continue to pass without database credentials and must report database skips honestly.
- Typed equality tests cover identical references, separately allocated equal documents, a change to each top-level document field, ordered-array reordering, normalized equivalent deleted ranges, and documents whose object properties were inserted in different orders before schema parsing.
- Studio Editing Session behavior tests verify that equal documents do not mark cloud state dirty, create history, protect navigation, or retain a redundant Device Draft.
- Studio Editing Session behavior tests verify that every real change remains dirty until the matching cloud revision is acknowledged.
- Clip Editor Document Persistence tests verify that typed equality preserves exact no-op revisions and still triggers the correct derived-media invalidation for changed windows and deleted ranges.
- Existing editor reducer tests are prior art for semantic no-op and referential-stability behavior.
- Existing Studio Editing Session durability and cloud convergence suites are prior art for Device Draft and autosave outcomes.
- Existing Clip Editor Document Persistence deterministic and PostgreSQL suites are prior art for revision and invalidation behavior.
- Performance verification uses representative large documents to confirm correct behavior and avoid obvious full-document work after an early scalar mismatch. It must not use fragile wall-clock thresholds as the sole assertion.
- Final verification runs the real lint command, typecheck, fast aggregate tests, all six critical disposable-schema database commands, production build, and the existing authenticated browser checks affected by deletion or Studio behavior.

## Out of Scope

- Auditing or rewriting every empty catch or best-effort operation in the repository.
- Changing Project deletion behavior, which already preserves the row on genuine storage failure.
- Building a bucket-wide orphan scanner or deleting unknown provider objects by prefix.
- Adding a new user-facing cleanup queue, operator dashboard, or asynchronous Clip deletion state.
- General account, Project, or legal-retention deletion policy beyond the exact Clip-owned and mutation-retired media described here.
- Removing Workflow Run protocol-version bridging.
- Folding database migrations and PostgreSQL suites into every local `bun run test` invocation.
- Adding comprehensive new test suites for Auth, Email, MCP bootstrap, Config, or the database client solely because their current package scripts are no-ops.
- Reworking live Stripe, R2, social-provider, container, or authenticated-browser contract environments beyond existing gates.
- Creating a repository-wide canonical JSON or deep-equality utility.
- Changing Clip Composition Plan fingerprints, Social Publication Attempt idempotency, publication intent keys, upload resume fingerprints, or unrelated form/cache comparisons.
- Changing the Clip Editor Document schema, revision semantics, Studio collaboration model, or persistence API.
- Re-auditing the nine completed architecture recommendations outside these remaining findings.

## Further Notes

- Recommended implementation order is Media Cleanup and Clip deletion first, verification gates second, and typed document equality third.
- The media work is the only confirmed pre-production correctness blocker in this spec. The CI work makes the architecture guarantees continuous. The equality work is a focused performance and consistency cleanup rather than a known data-loss fix.
- The current architecture report's counts are stale. At spec time, the real Biome command checks more files than the report states, web tests are active, and the fast aggregate contains substantial tests while skipping database suites by design.
- Update the Clip Editor Document Persistence ADR to describe the generic Media Cleanup execution module while preserving Clip Editor Document Persistence ownership of when editor mutations create cleanup intent. Add a focused ADR only if generalizing cleanup changes ownership beyond this clarification.
- Narriflow has no production users or production data. Replace the editor-only cleanup schema and worker directly rather than adding dual reads, dual writes, legacy cleanup parsing, or a cutover selector.
- No spec, diagnostic, issue, or test output should contain a real object key, signed URL, provider identifier, provider body, or secret.

