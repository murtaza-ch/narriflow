# 08 — Preserve optional-asset fallbacks inside the Clip Render Attempt

**What to build:** Resolve and apply optional logos, B-roll, music, sound effects, and backgrounds inside the attempt while preserving every current omission, degradation, attribution, and solid-color fallback.

**Blocked by:** [07 — Preserve all core render paths and resume semantics](07-preserve-core-render-paths-and-resume-semantics.md).

**Status:** completed

**Specification:** [Deepen the Clip Render Attempt](../spec.md)

## Observable acceptance criteria

- [x] Brand snapshot and logo failures preserve current logo omission behavior without failing independent output.
- [x] B-roll provider, selection, download, decode, and timing failures preserve current skip/degrade behavior and attribution metadata for successfully used assets.
- [x] Music and sound-effect lookup, download, decode, and mix failures preserve current fallbacks and audio behavior.
- [x] Background image resolution and probe failures preserve the current solid-color fallback.
- [x] Optional access locations may refresh, but the selected keys and treatment remain part of Frozen Rendering State.
- [x] Every fallback records a typed phase, asset class, stable code, and disposition without signed URLs, credentials, or command text.

## Public-interface and failure-injection tests

- [x] Tests call only `ClipRenderAttempt.execute` and inject each optional failure at lookup, parse, presign, download, probe, decode, command, and cleanup.
- [x] Tests prove unaffected variants still settle, required-source failures remain fatal, attribution remains present only for used B-roll, and fallback outputs match existing media fixtures.
- [x] Production remote-asset, storage, and media adapter contracts normalize missing, unauthorized, rate-limited, corrupt, timed-out, and cancelled outcomes.

## Migration and mixed-version considerations

- [x] Existing asset services and snapshots remain the source of truth; no asset schema or provider contract is migrated.
- [x] Legacy helpers remain available until cutover and can coexist with the new adapters without duplicate downloads in one attempt.
- [x] Existing exports retain their frozen snapshot semantics across retries.

## Rollout and recovery safety

- [x] Dark-run comparison covers assets present, absent, corrupt, expired, and provider-unavailable cases before production enablement.
- [x] Rollback requires no asset-data migration and leaves attempt-unique orphan handling intact.

## Scope boundaries

- [x] Do not make optional assets required, add providers, change asset selection UX, redesign attribution persistence, or alter mixing/composition policy.
- [x] Do not change lifecycle ownership, Studio Editing Session, Ingest Jobs, or Clip Composition Plan.

## Completion evidence

- `ClipRenderAttempt.execute` failure injection covers lookup, parse, presign, download, probe, decode, command, cleanup, cancellation, attribution, and fatal required-source behavior for every optional asset class.
- Optional media is fully decoded before adoption, provider B-roll is validated before cache write, access-refresh failures use a stable domain code, and command fallbacks diagnose degradation only after the fallback output settles.
- The full worker suite, services suite, live isolated R2 contract, uncached monorepo gate, and real Chrome rendered-media playback all pass.

## Fresh-task handoff

Implement in a fresh task with `/implement`; drive the change with `/tdd`, finish with `/code-review`, and run uncached interface, adapter, and real-media fallback tests, `bun run typecheck`, `bun run lint`, and a production build.
