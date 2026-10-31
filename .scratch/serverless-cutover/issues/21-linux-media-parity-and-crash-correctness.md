# 21 - Linux media parity and crash correctness

**What to build:** Linux media parity and crash correctness.

**Blocked by:** 07, 09, 10, 14

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** run the relocated golden and fault harness on the pinned Modal image (render, audio extract, detectors, pinning, wrapper death, R2 and commit boundaries). Recover the render-hardening ticket 21 Linux reference, or rebuild a frozen pre-cutover reference with recorded provenance.
- **Accept:** exact normal comparisons, no baseline refresh and no invented tolerance. Evidence covers the camera-clock fix. SIGKILL after a sibling commit, spawn failure, lease loss, storage hang, full disk and lost commit-ack all preserve correct outcomes. Image boot and model readiness measured.

## Evidence

[Actual Modal render parity](../evidence/modal-render-parity-20261031.json) passes all36 cases against the frozen pre-cutover623aadca source:18 exact normal,16 activated and2 unchanged expected failures. Original fixture recipes, captured expectations and tolerances are unchanged. Camera-clock7 tests/41 assertions pass. Final canonical image, standalone thread caps and full domain crash/commit gates remain open.
