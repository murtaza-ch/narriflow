# 21 - Linux media parity and crash correctness

**What to build:** Linux media parity and crash correctness.

**Blocked by:** 07, 09, 10, 14

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** run the relocated golden and fault harness on the pinned Modal image (render, audio extract, detectors, pinning, wrapper death, R2 and commit boundaries). Recover the render-hardening ticket 21 Linux reference, or rebuild a frozen pre-cutover reference with recorded provenance.
- **Accept:** exact normal comparisons, no baseline refresh and no invented tolerance. Evidence covers the camera-clock fix. SIGKILL after a sibling commit, spawn failure, lease loss, storage hang, full disk and lost commit-ack all preserve correct outcomes. Image boot and model readiness measured.

## Evidence

[Actual Modal render parity](../evidence/modal-render-parity-20261031.json) passes all36 cases against the frozen pre-cutover623aadca source:18 exact normal,16 activated and2 unchanged expected failures. Original fixture recipes, captured expectations and tolerances are unchanged. Camera-clock7 tests/41 assertions pass. The [canonical-image rerun](../evidence/canonical-modal-media-parity-20261031.json) also passes36/36 and camera7/41. Its recaptured frozen reference retains every media fact; the exact one-file measurement checker overlay and the one approved ASLR diagnostic address mapping are recorded. Explicit FFmpeg thread caps and remaining live fault combinations stay open.

The current Core/RenderGroup PostgreSQL gate passes22 tests/216 assertions, including an actual Bun child killed after the first sibling commit. The charged attempt and first object remain unchanged, and a successor receives only the unfinished member before returning completed2/2. Artifact HEAD responses are controlled in this domain gate; live R2 media proof is separate.

[Current canonical native faults and resources](../evidence/canonical-linux-media-faults-20261031.json):66 native tests pass;20 source/pin/proxy cases and2 language-probe tests/10 assertions pass. A3h source reads66,060,288 of438,557,967 bytes,15.06%, for a5400–5410s clip, below20%. Sampled process-tree RSS peaks at954,265,600 bytes under an8GiB hard allocation. Frozen and relocated detector CLI output matches; model readiness and container startup observations are recorded. Actual8MiB tmpfs ENOSPC passes. A native fast-exit/start-ACK race was reproduced and fixed without changing unconfirmed-ACK behavior.

[Declared render pool limits and final native sweep](../evidence/render-thread-policy-20261031.json): decoder/filter4 and x264encoder6 pass the full36-case matrix with exact compiler argv, plans, decoded frames and PCM; camera+policy9 tests/47 assertions pass. Explicit encoder4 was measured and rejected because it changed frame0; the frozen encoder already used6. The3h render retains the same output SHA and15.06% source reads with968,404,992 bytes sampled tree RSS. After fixing Bun dotenv autoload at the shared supervisor boundary, all143 pinned Python tests pass, and the guarded PostgreSQL SIGKILL case passes22 tests/214 assertions with bounded diagnostics. Final source-image refresh and actual Function verifiers remain Root-owned; this ticket stays claimed until that refresh.
