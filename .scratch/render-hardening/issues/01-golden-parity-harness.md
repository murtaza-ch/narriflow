# 01 - Golden parity harness and pinned reference image

**What to build:** Capture reproducible normal and known-defect references before any render behavior changes.

**Blocked by:** None

**Status:** ready-for-agent

**Suggested implementer:** Claude

**Contract:** [Render hardening spec](../spec.md). Read the relevant contract sections and AGENTS.md before claiming.

## File ownership

Exhaustive write set, relative to repository root. This ticket may also update its own issue file with status and evidence. All other paths are read-only. Shared paths are serialized by blocker ancestry. If an additional file is necessary, amend the write set and dependency edges before editing it.

- `apps/worker/Dockerfile`
- `apps/worker/runtime-lock.json`
- `apps/worker/scripts/render-golden.ts`
- `apps/worker/scripts/render-golden.test.ts`
- `apps/worker/scripts/check-render-environment.ts`
- `apps/worker/src/__fixtures__/render-golden/manifest.json`
- `apps/worker/src/__fixtures__/render-golden/documents.json`
- `apps/worker/src/__fixtures__/render-golden/evidence.json`
- `apps/worker/src/__fixtures__/render-golden/known-defects.json`

## Implementation

1. Recover current deployed Linux artifact versions before pinning. Pin base/provider image digests, package snapshot/checksums, FFmpeg/ffprobe/libass/fontconfig, Python wheel versions/hashes and YuNet commit/SHA-256; emit a runtime fingerprint. Do not upgrade dependencies to establish the baseline.
2. Implement the DB-free capture/verify CLI in the spec. Freeze source/optional-media/fonts/documents/evidence by content hash, support a read-only golden asset cache, and retain artifacts outside candidate images.
3. Cover the entire normal matrix and explicit known-defect recordings in the spec, including playback-rate changes that do not retime exports. Capture plans, argv/graph bytes, frame/PTS/audio hashes, ffprobe facts, decode, loudness/peak and review snapshots.
4. Keep known defects explicit expected failures with narrow future contracts. Exact comparisons are the default. SSIM/loudness tolerances are available only in the separately authorized encoder comparison mode.

## Acceptance

- [ ] Two captures of the frozen normal set in the pinned image produce identical plans/normalized argv, decoded frames/PTS and PCM.
- [ ] Changed crop, one changed cue, missing frame, audio drift and altered encoder argument each make the normal gate fail.
- [ ] The runner distinguishes known broken fixtures from normal references; neither skips silently nor accepts them as corrected output.
- [ ] A tampered model/font/source hash fails before rendering. Runtime fingerprint includes actual resolved fallback font files.
- [ ] Document the baseline image/commit, content hashes, command syntax, fixture staging and report paths in this ticket.

## Verification

Run from repository root. The command interface below is delivered by ticket 01 where applicable. Run media checks inside the pinned image. Record output/evidence rather than merely listing commands.

```sh
bun test apps/worker/scripts/render-golden.test.ts
docker build -f apps/worker/Dockerfile -t narriflow-render-golden .
```

Run the capture and verify docker commands in spec.md; preserve /tmp/narriflow-golden/baseline for later tickets.

DB checks, when listed, must use `bash .scratch/api-extraction/db-gate.sh ...`; never run gates against shared Neon. No shared resource mutations or deployments are authorized by this ticket.

## Evidence

Pending. Record commit/image hashes, commands, fixture reports and any unresolved acceptance here.

## Comments
