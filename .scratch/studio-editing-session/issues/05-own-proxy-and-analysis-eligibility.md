# 05 — Own proxy and analysis eligibility in the Studio Editing Session

**What to build:** Keep the preview proxy, waveform, and automatic layout aligned with the working document from the instant a boundary edit occurs through cloud invalidation and replacement generation.

**Blocked by:** 04 — Converge cloud revisions inside the Studio Editing Session.

**Status:** completed

- [x] Proxy descriptors carry a window fingerprint that is compared with the live Clip Editor Document.
- [x] A local boundary edit makes a mismatched proxy ineligible immediately, before cloud acknowledgement.
- [x] Undo may reuse the prior proxy only when it restores the exact fingerprint and the server has not invalidated the asset.
- [x] Source media becomes the temporary active asset while a matching replacement proxy is unavailable.
- [x] A boundary-save acknowledgement retires the invalidated proxy and waveform as one transition.
- [x] Boundary and deleted-range changes invalidate automatic layout according to their existing input rules.
- [x] Polling is bounded and adopts only proxy or analysis results matching the current inputs.
- [x] Stale results from prior documents, polls, or session generations are ignored.
- [x] Existing server persistence and preview status contracts are unchanged.
- [x] Interface tests cover local ineligibility, undo reuse, acknowledged invalidation, source fallback, matching replacement, and stale response rejection.
- [x] Exactly one module owns proxy and analysis eligibility after cutover.
- [x] Repository typecheck and tests pass.
