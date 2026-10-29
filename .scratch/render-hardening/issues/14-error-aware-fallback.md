# 14 - Narrow fallbacks and file-back oversized graphs

**What to build:** Preserve requested media on unrelated failures, avoid downloads on sick executors and start valid large Linux filtergraphs safely.

**Blocked by:** [13 - Reuse compatible layout and immutable media facts](13-reuse-render-facts.md)

**Status:** ready-for-agent

**Suggested implementer:** Sol

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/src/tasks/clip-render-attempt.ts`
- `apps/worker/src/tasks/clip-render-attempt-runtime.ts`
- `apps/worker/src/tasks/clip-render-attempt-assets.test.ts`
- `apps/worker/src/tasks/clip-render-fallback.test.ts`
- `apps/worker/src/render-command-transport.ts`
- `apps/worker/src/render-command-transport.test.ts`

## Implementation

1. Allow full-source download only for the spec ranged HTTP/I/O recovery cases, retaining existing source commands on success. Spawn/config/invalid-source errors bypass download.
2. Attribute optional binding failures through typed validation/input identity. Remove only a proven failing optional binding. Unattributed timeout/source/OOM/process failures retry the same requested composition.
3. Use attempt-local graph files for oversized filter_complex arguments through the pinned binary supported syntax. Preserve graph bytes and admission complexity budget; ordinary graphs retain their original argv.
4. Keep selected-range validation bounded and use immutable cached facts from 13. Required scene assets/fonts keep typed failure behavior.

## Acceptance

- [ ] EBADF ranged probe causes no source download or asset-stripped encode.
- [ ] Source timeout with logo/music produces no altered fallback; a proven failed optional asset removes only that binding and emits its named notice.
- [ ] A schema-valid >128KiB single filtergraph executes inside pinned Linux without E2BIG and has exact expanded graph semantics.
- [ ] Normal source/optional-media compiler args, frames and PCM remain exact.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/src/tasks/clip-render-fallback.test.ts apps/worker/src/tasks/clip-render-attempt-assets.test.ts apps/worker/src/render-command-transport.test.ts
```

Run the >128KiB graph integration fixture inside narriflow-render-golden, not only on macOS.

Run the full normal exact golden comparison from spec.md. For an approved defect ticket, also run its declared corrected expectations; preserve all unrelated baseline results.

`bun run lint` and `bun run typecheck` must pass for the assembled change. Capture scoped failures caused by unrelated in-flight work before changing any unowned file.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
