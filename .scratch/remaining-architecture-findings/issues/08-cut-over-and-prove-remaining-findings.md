# 08 — Cut over and prove the remaining architecture fixes

**What to build:** Complete the direct cutover for the remaining architecture findings. Remove obsolete cleanup and equality ownership, prove every new interface through its highest test seam, make all critical database checks permanent, and refresh the architecture evidence so the report describes the code that now ships.

**Blocked by:** 02 — Keep Clips retryable when storage deletion is incomplete; 03 — Make repository verification commands truthful; 04 — Gate critical PostgreSQL invariants in CI; 05 — Own Clip Editor Document equality in validators; 06 — Retire replaced detected-clip media through Media Cleanup; 07 — Recover unadopted duplicate media through Media Cleanup.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] An ownership audit finds one deferred Media Cleanup module, one fail-closed Clip deletion path, and one typed Clip Editor Document equality policy.
- [ ] No scoped deletion or compensation path discards provider deletion results after removing the last recoverable database reference.
- [ ] No editor-only cleanup schema, worker, configuration, export, fallback, dual write, or compatibility selector remains.
- [ ] No Studio or Clip Editor Document Persistence caller retains a private full-document equality policy outside the explicitly allowed generic draft merge.
- [ ] Authenticated Request Policy continues to translate Clip deletion failures safely and preserves all successful request behavior.
- [ ] The Media Cleanup and Clip Editor Document Persistence ADRs and domain glossary record the final ownership split and direct pre-production cutover.
- [ ] Repository guidance names the truthful lint command, fast aggregate, six critical PostgreSQL commands, production build, and affected browser checks.
- [ ] The architecture review marks the three remaining ledger items resolved and refreshes source, test, and Biome evidence from the final working tree.
- [ ] Uncached focused suites cover Clip deletion, detected replacement, duplicate compensation, Media Cleanup, document equality, Studio convergence, and persistence invalidation.
- [ ] All six disposable-schema PostgreSQL commands pass independently after applying the complete migration chain.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test`, the production dependency audit, and the production build pass without relying on cached no-op results.
- [ ] Authenticated browser verification covers successful Clip deletion, bounded retry presentation for an injected storage-incomplete response, equal-document no-op behavior, a real dirty edit, cloud acknowledgement, Reset eligibility, and Device Draft cleanup.
- [ ] Diagnostics from cleanup, deletion, Studio, and persistence contain stable support context and no object keys, signed URLs, provider identifiers, provider bodies, document content, or secrets.
- [ ] Existing Project deletion, Workflow Run lifecycle, Upload Session, Workspace Billing, Social Publication Attempt, Clip Composition Plan, and Clip Render Attempt contracts remain unchanged outside their new permanent CI coverage.
- [ ] No bucket-wide orphan scanner, asynchronous Clip deletion state, universal stable-JSON helper, or unrelated empty-catch cleanup is added.
- [ ] Standards and specification reviews report no unresolved findings before the architecture report is marked complete.
