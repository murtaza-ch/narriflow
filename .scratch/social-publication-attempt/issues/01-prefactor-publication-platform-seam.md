# 01 — Prefactor providers behind one publication seam

**What to build:** Move YouTube, Instagram, TikTok, LinkedIn, X, and publication-webhook behavior behind one internal platform interface while preserving current successful publishing behavior. This is the intentional prefactor that makes the attempt lifecycle small enough to build and test in later tickets.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Deepen the Social Publication Attempt](../spec.md)

## Observable acceptance criteria

- [ ] One platform interface represents media preparation, provider submission, normalized provider result, and cleanup without exposing platform-specific identifiers to its caller.
- [ ] A registry selects one of the five native adapters or the publication-webhook adapter; the worker no longer contains a platform switch or provider HTTP protocol.
- [ ] The adapter result can represent accepted, pending, failed, and unknown even though later tickets deepen how each provider produces those results.
- [ ] Provider failures carry a stable code, operation phase, and evidence-based disposition rather than relying on message matching.
- [ ] YouTube, Instagram, TikTok, LinkedIn, X, and webhook happy paths preserve current captions, provider settings, uploaded media, returned links, and metadata.
- [ ] Current account credential refresh and platform-account validation behavior remains intact.
- [ ] Media download and temporary cleanup remain bounded and happen through injected internal dependencies.
- [ ] The worker still uses the current Social Post lifecycle in this prefactor, and no new attempt schema or user-visible status is introduced.
- [ ] Provider implementations, the deterministic adapter, and the registry are constructed behind the shared service interface rather than becoming caller obligations.
- [ ] Logs preserve the repository JSON convention and do not include tokens, signed URLs, resumable locations, captions, or raw provider responses.

## Public-interface and contract tests

- [ ] Characterization tests drive each adapter through the common platform interface and prove its existing successful request and normalized result.
- [ ] A deterministic contract-test adapter can return accepted, pending, failed, and unknown and can inject failure before and after submission.
- [ ] Registry tests reject unsupported platforms and missing required configuration with stable typed failures.
- [ ] Existing provider-specific validation, upload, polling, permalink, and cleanup behavior is covered before the original platform switch is removed.
- [ ] Tests assert normalized outcomes and observable provider requests, not private helper names or source layout.

## Migration and rollout constraints

- [ ] This ticket has no database migration and no feature selector.
- [ ] The old switch and duplicate provider dispatch helpers are removed in the same change once every current provider is registered.
- [ ] The repository remains behaviorally compatible while tickets 02 and 03 build the new publication lifecycle.

## Scope boundaries

- [ ] Do not add durable attempts, claim fencing, retry policy, reconciliation, new user states, or provider recovery yet.
- [ ] Do not change Social OAuth connection, platform capabilities, caption rules, or add another provider.

## Fresh-task handoff

Implement with `/implement`; use `/tdd` to characterize the platform interface before moving behavior; finish with `/code-review`; run uncached publisher, OAuth, worker, typecheck, lint, test, and build checks.
