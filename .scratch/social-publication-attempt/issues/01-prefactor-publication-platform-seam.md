# 01 — Prefactor providers behind one publication seam

**What to build:** Move YouTube, Instagram, TikTok, LinkedIn, X, and publication-webhook behavior behind one internal platform interface while preserving current successful publishing behavior. This is the intentional prefactor that makes the attempt lifecycle small enough to build and test in later tickets.

**Blocked by:** None — can start immediately.

**Status:** done

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [x] One platform interface represents media preparation, provider submission, normalized provider result, and cleanup without exposing platform-specific identifiers to its caller.
- [x] A registry selects one of the five native adapters or the publication-webhook adapter; the worker no longer contains a platform switch or provider HTTP protocol.
- [x] The adapter result can represent accepted, pending, failed, and unknown even though later tickets deepen how each provider produces those results.
- [x] Provider failures carry a stable code, operation phase, and evidence-based disposition rather than relying on message matching.
- [x] YouTube, Instagram, TikTok, LinkedIn, X, and webhook happy paths preserve current captions, provider settings, uploaded media, returned links, and metadata.
- [x] Current account credential refresh and platform-account validation behavior remains intact.
- [x] Media download and temporary cleanup remain bounded and happen through injected internal dependencies.
- [x] The worker still uses the current Social Post lifecycle in this prefactor, and no new attempt schema or user-visible status is introduced.
- [x] Provider implementations, the deterministic adapter, and the registry are constructed behind the shared service interface rather than becoming caller obligations.
- [x] Logs preserve the repository JSON convention and do not include tokens, signed URLs, resumable locations, captions, or raw provider responses.

## Public-interface and contract tests

- [x] Characterization tests drive each adapter through the common platform interface and prove its existing successful request and normalized result.
- [x] A deterministic contract-test adapter can return accepted, pending, failed, and unknown and can inject failure before and after submission.
- [x] Registry tests reject unsupported platforms and missing required configuration with stable typed failures.
- [x] Existing provider-specific validation, upload, polling, permalink, and cleanup behavior is covered before the original platform switch is removed.
- [x] Tests assert normalized outcomes and observable provider requests, not private helper names or source layout.

## Migration and rollout constraints

- [x] This ticket has no database migration and no feature selector.
- [x] The old switch and duplicate provider dispatch helpers are removed in the same change once every current provider is registered.
- [x] The repository remains behaviorally compatible while tickets 02 and 03 build the new publication lifecycle.

## Scope boundaries

- [x] Do not add durable attempts, claim fencing, retry policy, reconciliation, new user states, or provider recovery yet.
- [x] Do not change Social OAuth connection, platform capabilities, caption rules, or add another provider.

## Fresh-task handoff

Implement with `/implement`; use `/tdd` to characterize the platform interface before moving behavior; finish with `/code-review`; run uncached publisher, OAuth, worker, typecheck, lint, test, and build checks.
