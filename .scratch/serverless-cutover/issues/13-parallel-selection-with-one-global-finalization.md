# 13 - Parallel selection with one global finalization

**What to build:** Parallel selection with one global finalization.

**Blocked by:** 03, 05

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** move `detect-clips.ts` into `packages/services/src/clip-selection*.ts`. Bounded concurrent windows with per-window result references, then one global finalization. Prompt, settings and guidance semantics preserved.
- **Accept:** 2/4/6 windows for 1/2/3 h. Replay reuses committed windows without duplicate Clips. Cross-project token and request limits are fair, with explicit 429 backoff. No Workflow payload over 1 MiB.

## Evidence

Pending implementation and verification.

Preparation is owned by the contracts worktree on the integration branch. Dependency acceptance remains open; this ticket is not complete. Existing detector prompt, scoring, transcript slicing, cue, guidance and caption-only policies will move as one implementation before durable window orchestration is added.

Primary comparison before unfamiliar permit work: [Bottleneck](https://github.com/SGrondin/bottleneck) separates weighted reservoir accounting from concurrency bounds; its distributed implementation depends on Redis. [Graphile Worker](https://github.com/graphile/worker) demonstrates PostgreSQL ownership and async job delivery, but provider token/request permits are a separate concern. This cutover reuses PostgreSQL with explicit in-flight request/estimated-token limits, a persisted fair queue, and provider Retry-After; no Redis limiter or speculative RPM/TPM bucket is added. Launch limits remain explicit configuration.
