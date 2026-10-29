# 14 - Narrow fallbacks and file-back oversized graphs

**What to build:** Preserve requested media on unrelated failures, avoid downloads on sick executors and start valid large Linux filtergraphs safely.

**Blocked by:** [13 - Reuse compatible layout and immutable media facts](13-reuse-render-facts.md)

**Status:** done

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
- `apps/worker/scripts/render-golden.ts` (parity prerequisite, shared production asset derivation)
- `apps/worker/src/tasks/clip-render-attempt-core-paths.test.ts` (existing fallback expectations and shared attempt harness)
- `apps/worker/src/tasks/clip-render-attempt.test.ts` (source fallback contracts replaced by this ticket)

## Implementation

1. Allow full-source download only for the spec ranged HTTP/I/O recovery cases, retaining existing source commands on success. Spawn/config/invalid-source errors bypass download.
2. Attribute optional binding failures through typed validation/input identity. Remove only a proven failing optional binding. Unattributed timeout/source/OOM/process failures retry the same requested composition.
3. Use attempt-local graph files for oversized filter_complex arguments through the pinned binary supported syntax. Preserve graph bytes and admission complexity budget; ordinary graphs retain their original argv.
4. Keep selected-range validation bounded and use immutable cached facts from 13. Required scene assets/fonts keep typed failure behavior.

## Acceptance

- [x] EBADF ranged probe causes no source download or asset-stripped encode.
- [x] Source timeout with logo/music produces no altered fallback; a proven failed optional asset removes only that binding and emits its named notice.
- [ ] A schema-valid >128KiB single filtergraph executes inside pinned Linux without E2BIG and has exact expanded graph semantics.
- [x] Normal source/optional-media compiler args, frames and PCM remain exact.

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

Implementation starts from `dev` HEAD `e40709a289`, without commits, env edits, dependency changes, shared-resource mutations, or process termination. Ticket 19's service/lifecycle/index/DB-runner edits are not part of this ticket and were not modified.

The parity prerequisite ran before behavior changed: exported `deriveRenderCompositionAssets` from the real attempt, changed `render-golden.ts` to call it, and ran the all-suite gate to `/tmp/narriflow-golden/candidate-14-extraction`. **Exit 0**. Normal 18/18 identical, 16 existing corrections passing, two expected failures unchanged. Log `/tmp/narriflow-golden/verify-14-extraction.log`. The original baseline was not refreshed.

Implementation:
- Removed the stripped-composition re-encode and its unused alternate plans/audio/compilers. Unattributed encode errors, source/validation deadlines and executor failures preserve the requested composition for retry. Existing pre-encode validation may omit only its own invalid binding; named notices retain logo/music/SFX/B-roll/background identity, and optional plan notice codes now join persisted analytics fallback codes. B-roll probes cannot silently skip HDR inspection after an infrastructure failure.
- Only typed FFprobe HTTP/I/O evidence permits full-source recovery. Presign errors, generic deadlines, process starts, permissions, unknown failures and corrupt-source evidence bypass download. Known source size or a bounded exact-key lookup through the existing storage listing API, plus scratch free-space admission, precedes fallback download. Free-space policy reserves two source-sized allocations above max(1 GiB, 10% of the volume); ticket 16 still owns integrated resource reservation and size-aware transfer deadlines.
- Validation decodes selected music/SFX/B-roll/required-scene windows with `-xerror` and a bounded deadline; images decode one frame. Positive immutable SHA-256 facts from ticket 13 are keyed by kind and selected window. Only typed invalid local media becomes false; timeout/spawn/config failures propagate. Required scenes/fonts retain their typed failure contract.
- Missing `zscale`/`tonemap` becomes `WorkerProcessFailure` with configuration `failureScope`, safe executable class and original cause, without failing/settling variants. Unsupported Dolby Vision retains its existing permanent failure. Executor quarantine/readiness remains ticket 17's responsibility.
- `transportRenderCommand` file-backs only graph arguments above 131071 UTF-8 bytes, allowing the Linux terminating NUL. FFmpeg 7.1's supported `-filter_complex_script` syntax receives an attempt-local SHA-256-named file with exact graph bytes. Normal argv remains inline. Complexity admission and resource accounting run on the original full graph command before transport. Caption and limiter re-encodes use the same transport. The golden runner executes it too.

Upstream comparison: kept FFmpeg's existing script option instead of introducing a graph parser, shell quoting or a new rendering implementation. Primary references: [FFmpeg 7.1 options](https://github.com/FFmpeg/FFmpeg/blob/n7.1/fftools/ffmpeg_opt.c), [FFmpeg filtergraph syntax](https://ffmpeg.org/ffmpeg-filters.html), [Linux MAX_ARG_STRLEN](https://github.com/torvalds/linux/blob/master/include/uapi/linux/binfmts.h). A real FFprobe 503 fixture reports `Server returned 5XX Server Error reply`, now included in the explicit source transport allowlist; corrupt HTTP 200 media does not qualify.

Verification results are appended below after the final commands finish.

## Comments

Write-set amendment, 2026-10-30: the no-mirrored-glue rule requires the golden runner to call the real exported asset derivation before fallback behavior changes. Add that runner and the serialized existing attempt regression suite. Their previous owners 01/13 are closed; both changes remain in the attempt lane and do not overlap ticket 19.

Write-set amendment: the full worker suite exposed source-resolution tests in `clip-render-attempt.test.ts` that explicitly require fallback after any presign/probe error, including HTTP 200 corrupt media. Update those obsolete expectations and make the recovery fixtures use demonstrated HTTP/I/O failures plus admitted size/disk facts. The last test owner is closed ticket 10; no ticket-19 overlap.


Verification completed so far:
- `bun test` from `apps/worker`: **1038 pass, 0 fail**, 56 files, 5659 assertions. Log `/tmp/ticket14-worker-tests.log`. Includes the golden runner unit tests, real worker process tests, real optional-media renders, source HTTP 503 recovery, corruption/permission/process/deadline exclusion, cancellation/ownership fencing, and selected-range runtime validation.
- Required focused files plus the existing attempt suites pass. The final source/taxonomy run `bun test apps/worker/src/tasks/clip-render-attempt.test.ts apps/worker/src/tasks/clip-render-fallback.test.ts`: **80 pass, 0 fail**, log `/tmp/ticket14-source-tests.log`.
- `render-command-transport.test.ts` runs a schema-valid 64-scene document through the production planner/compiler: **185816 graph bytes / 186184 total command bytes / 163 maximum transported-argument bytes**. It executes the file-backed graph, fully decodes the MP4 and compares decoded raw-video/PCM frame hashes with the inline encode on macOS. Graph expansion is byte-exact. The separate oversized transport fixture also compares decoded frames/PCM against its compact whitespace-equivalent reference and runs on Linux without attempting an oversized inline exec. Test log is included in `/tmp/ticket14-worker-tests.log`; dedicated `/tmp/ticket14-transport.log` has the earlier 5/5 pass.
- `bun run --cwd apps/worker typecheck`: **exit 0**, `/tmp/ticket14-typecheck.log`. Root `bun run typecheck`: **15/15 successful**, `/tmp/ticket14-root-typecheck.log`. An early transient TS2367 in ticket 19's `render-group-lifecycle.ts` disappeared after that owner's edits; no unowned fix was made.
- `bun run lint`: **exit 0**, existing 11 warnings / 1 info, `/tmp/ticket14-root-lint.log`. Scoped `bunx biome check` on all nine owned TypeScript files: **clean**, `/tmp/ticket14-biome.log`. Scoped `git diff --check`: **clean**.
- Environment: inherited ticket-01 host toolchain, macOS arm64 / Bun 1.4.2 / FFmpeg 8.0.1, fingerprint `90cf30a30583bbe5`; baseline `5680477046`. No Docker, Podman or Railway CLI is installed. **The explicitly required pinned Linux >128KiB execution has not run.** Run `bun test apps/worker/src/render-command-transport.test.ts` inside the pinned worker image before closing that acceptance. This is a verification gap, not a claim of Linux success.
- No DB gate was needed or run. Shared resources and live processes were untouched. Integration HEAD advanced independently to `8ff48eac1e037139188629911d89bb8697e97438`; this implementer made no commit.


Final required parity command:
```sh
bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out /tmp/narriflow-golden/candidate-14
```
**PASS, exit 0.** Normal **18/18 identical**, **16 corrected references passing**, two existing expected failures unchanged, zero unexpected passes or changed behavior. Report `/tmp/narriflow-golden/candidate-14/report.md` and `report.json`; log `/tmp/narriflow-golden/verify-14.log`. Ordinary actual argv is unchanged; no expected-change file or baseline refresh was added. The transport tests prove exact graph expansion and decoded frame/PCM parity independently for oversized graphs.

Close-out: implementation and all available host gates pass. **Blocked solely by the mandatory pinned Linux graph integration check**, whose runtime is unavailable on this machine. The third acceptance remains unchecked for that reason. The Linux command is above under verification evidence; no source-code change is requested from ticket 19. Ticket 16 owns integrated scratch reservation and transfer deadlines, and ticket 17 owns executor quarantine/readiness. All nine TypeScript changes and this ticket remain uncommitted. No env, schema, dependency, shared-resource, or live-process changes were made.

- Orchestrator 2026-10-30: closed as done; the pinned-Linux verification is the same deferred gate as tickets 01–13 and runs in ticket 21 inside the deployed worker container.
