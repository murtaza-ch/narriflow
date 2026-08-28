# 07 — Cut over and prove every document persistence path

**What to build:** Finish the direct cutover so every Clip Editor Document initialization, read, and post-creation mutation uses the canonical codec and persistence owner, then prove the complete editor flow without retaining obsolete orchestration or unsafe document-owned JSON conversions.

**Blocked by:** 02 — Retry obsolete editor media cleanup; 03 — Reset the complete document through persistence; 04 — Make timeline field updates revision-safe; 05 — Make presentation edits invalidation-complete; 06 — Make Apply to all one atomic project mutation.

**Status:** ready-for-agent

**Specification:** [Deepen Clip Editor Document persistence](../spec.md)

- [ ] Detected, duplicated, and selection-created clips use the canonical document codec for every document-owned JSON value they initialize.
- [ ] An audit of all Clip Editor Document field writes finds one post-creation mutation owner and no route, service, worker, or server-rendered page that bypasses it.
- [ ] Document-owned persistence contains no double Prisma JSON casts or raw JSON-to-domain assertions; unrelated LLM, analysis, and provider payload conversions remain outside this ticket.
- [ ] Obsolete Clip Service mutation methods, persistence planners, equality rules, invalidation selection, cleanup scheduling, and shallow orchestration tests are removed after equivalent public-interface coverage exists.
- [ ] Service exports expose the new module without preserving a second legacy persistence facade.
- [ ] Existing editor URLs, methods, successful response shapes, Studio cloud convergence, Device Draft recovery, write ownership, preview eligibility, playback, and export preparation remain compatible.
- [ ] The final invalidation matrix proves mutable renders always retire on a real document change, previews retire only for window changes, and composition evidence retires only when its declared document inputs change.
- [ ] The final original-capture matrix proves that the first real full, Reset-related, field, or project-selection mutation establishes one immutable baseline and every later path preserves it.
- [ ] The final error matrix distinguishes missing, forbidden, stale revision, invalid boundary, empty timeline, unsafe media, corrupt stored document, transient contention, and unavailable persistence outcomes.
- [ ] Cleanup diagnostics and mutation diagnostics follow the structured logging convention and contain no document contents, media URLs, object keys, or provider bodies.
- [ ] Pending database migrations are generated, reviewed, and applied to the isolated verification schema before database tests run.
- [ ] The full deterministic module suite, PostgreSQL invariant suite, worker cleanup suite, retained validator and planner suites, Studio Editing Session tests, Clip Composition Plan tests, and Clip Render Attempt tests pass.
- [ ] Real-browser verification covers autosave, interrupted-response retry, stale-tab conflict recovery, Reset, boundary preview replacement, Apply to all changed and no-op outcomes, atomic related layout changes, and retained input after retryable failure.
- [ ] Repository typecheck, tests, lint, and affected production builds pass with no compatibility switch, shadow mode, dual read, dual write, or fallback persistence path.
- [ ] Standards and specification code reviews report no unresolved findings before completion.
