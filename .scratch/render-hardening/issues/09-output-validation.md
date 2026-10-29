# 09 - Validate rendered media before upload or success

**What to build:** Reject empty, truncated or contract-breaking full renders and previews and persist measured duration.

**Blocked by:** [08 - Burn shared emoji and enforce glyph coverage](08-emoji-and-glyphs.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/render-output-validation.ts`
- `apps/worker/src/render-output-validation.test.ts`
- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts`
- `apps/worker/src/tasks/clip-preview.ts`
- `apps/worker/src/tasks/clip-preview.test.ts`

## Implementation

1. Implement the spec stream/size/duration/SAR/color/fps/audio/full-decode contract using Worker Process Module facts, including absent frame counts and AAC priming/padding.
2. Validate all 720p/1080p exports and previews before storage or completeClipRenderVariant. Return measured duration/size and carry peak facts from 05. Invalid output cannot upload.
3. Distinguish retryable interrupted-read truncation from confirmed impossible range/corrupt immutable source. Propagate process-start failure as executor failure, not media-invalid.
4. Use bounded full decode for these short outputs. Keep normal encode commands untouched; validation adds independent read-only processes.

## Acceptance

- [ ] Exit-zero no-stream MP4 and 20.38/30s interrupted-range output fail and never upload/complete.
- [ ] A one-frame video tolerance and explicit audio-packet allowance pass legitimate AAC outputs without hiding substantial truncation.
- [ ] Frame count, exact canvas, streams, SAR, color, pixel format, timestamps and decode are checked, including previews.
- [ ] Stored duration comes from validated media and size from the local stat. Normal golden frames/argv/audio remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/render-output-validation.test.ts apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts apps/worker/src/tasks/clip-preview.test.ts
```

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
