# 13 - Parallel selection with one global finalization

**What to build:** Parallel selection with one global finalization.

**Blocked by:** 03, 05

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** move `detect-clips.ts` into `packages/services/src/clip-selection*.ts`. Bounded concurrent windows with per-window result references, then one global finalization. Prompt, settings and guidance semantics preserved.
- **Accept:** 2/4/6 windows for 1/2/3 h. Replay reuses committed windows without duplicate Clips. Cross-project token and request limits are fair, with explicit 429 backoff. No Workflow payload over 1 MiB.

## Evidence

Pending implementation and verification.
