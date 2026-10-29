# 02 - Normalize process starts and expose complete media facts

**What to build:** Give all callers one typed process-start failure and one bounded media inspection contract without changing normal media decisions.

**Blocked by:** [01 - Golden parity harness and pinned reference image](01-golden-parity-harness.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/worker-process.ts`
- `apps/worker/src/worker-process.test.ts`
- `packages/validators/src/source-probe.ts`
- `packages/validators/src/source-probe.test.ts`

## Implementation

1. Wrap synchronous spawn throws and asynchronous error events through the same classifier and diagnostics, for execute and persistent helper start. Preserve cancellation reasons and TERM/KILL ownership.
2. Expose safe errno, executable class and bounded diagnostics. Missing/forbidden executables are configuration-health failures, not permanent content defects. Provide enough typed information for the later executor quarantine ticket.
3. Extend the sole media parser with coded/display dimensions, matrix/reflection/SAR, average/base rational fps, stream clocks/starts/audio span, codecs/profile/pixel format/color, size and frame-count facts. Add bounded frame/packet inspection when requested for validation or timestamp diagnosis.
4. Keep existing width/height/fps consumer behavior until the geometry/clock tickets adopt new facts. Keep facts optional only where genuinely absent; update the persisted source validator for facts needed by later cache reuse. Avoid legacy raw-probe readers.

## Acceptance

- [ ] Sync EBADF/EMFILE/EAGAIN and asynchronous spawn errors produce matching stable codes and diagnostics; pre-aborted starts spawn nothing.
- [ ] Missing executable and startup timeout are distinguishable from source-media-invalid; failures preserve cause and never expose signed URLs.
- [ ] Real and injected probes cover display matrices/reflection, SAR, 90000/1 base vs 15/1 average, late audio, cover art, HDR tags and absent nb_frames.
- [ ] Normal golden argv, frames and PCM remain exact. No caller uses a second ffprobe parser.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/worker-process.test.ts packages/validators/src/source-probe.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
