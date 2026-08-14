# 05 — Own proxy and analysis eligibility in the Studio Editing Session

**What to build:** Keep the preview proxy, waveform, and automatic layout aligned with the working document from the instant a boundary edit occurs through cloud invalidation and replacement generation.

**Blocked by:** 04 — Converge cloud revisions inside the Studio Editing Session.

**Status:** ready-for-agent

- [ ] Proxy descriptors carry a window fingerprint that is compared with the live Clip Editor Document.
- [ ] A local boundary edit makes a mismatched proxy ineligible immediately, before cloud acknowledgement.
- [ ] Undo may reuse the prior proxy only when it restores the exact fingerprint and the server has not invalidated the asset.
- [ ] Source media becomes the temporary active asset while a matching replacement proxy is unavailable.
- [ ] A boundary-save acknowledgement retires the invalidated proxy and waveform as one transition.
- [ ] Boundary and deleted-range changes invalidate automatic layout according to their existing input rules.
- [ ] Polling is bounded and adopts only proxy or analysis results matching the current inputs.
- [ ] Stale results from prior documents, polls, or session generations are ignored.
- [ ] Existing server persistence and preview status contracts are unchanged.
- [ ] Interface tests cover local ineligibility, undo reuse, acknowledged invalidation, source fallback, matching replacement, and stale response rejection.
- [ ] Exactly one module owns proxy and analysis eligibility after cutover.
- [ ] Repository typecheck and tests pass.
