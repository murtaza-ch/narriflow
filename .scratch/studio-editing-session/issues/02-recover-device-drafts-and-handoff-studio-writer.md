# 02 — Recover Device Drafts and hand off one Studio Writer safely

**What to build:** Let Studio recover crash-safe device work, expose honest durability, keep one writable tab per clip, and transfer ownership without losing the outgoing writer's newest document.

**Blocked by:** 01 — Establish the Studio Editing Session seam through document edits and history.

**Status:** completed

- [x] Startup resolves Device Draft recovery and Studio Write Ownership before document mutations are accepted.
- [x] Conflict-free Device Drafts restore automatically; overlapping drafts remain durable and request an explicit decision.
- [x] IndexedDB failure leaves cloud editing available while exposing degraded durability and keeping navigation protection active.
- [x] Web Locks, BroadcastChannel, and local-storage fallback behavior is normalized behind one coordination adapter.
- [x] A second session is read-only for mutations but may inspect and play the clip.
- [x] Cooperative takeover checkpoints the outgoing writer before release, and the incoming writer reconciles before enabling edits.
- [x] An unresponsive writer can be force-taken after two seconds without allowing its later callbacks to regain ownership.
- [x] Device Draft writes carry a fenced ownership generation; older generations cannot overwrite newer checkpoints.
- [x] Existing draft records remain readable and are upgraded lazily without destructive migration.
- [x] Deterministic two-session tests cover contention, handoff, forced takeover, degraded coordination, ownership loss, and stale writes.
- [x] Browser adapter contract tests cover persistence validation, upgrade, and coordination event normalization.
- [x] Exactly one module owns draft and browser-ownership sequencing after cutover.
- [x] Repository typecheck and tests pass.
