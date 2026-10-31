# 08 - Link STT admission from verified Source Audio

**What to build:** Link STT admission from verified Source Audio.

**Blocked by:** 05

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.7: separate audio and video readiness, immutable binding, once-only settlement, whole-source cap/credit, mismatch handling with refund-needed evidence.
- **Files:** `packages/services/src/{processing-usage,ingest-job-lifecycle,workflow-run-lifecycle,project.service}.ts`, source artifact service, typed failures, DB tests.
- **Accept:** audio and video callbacks in either order, concurrency, a 60.01 s duration, month rollover, restriction, missing reservation, cap overflow and retry all debit exactly once. A mismatch blocks rendering. Source readiness stays truthful to clients.

## Evidence

Root has exact whole-source audio usage settlement and A/V binding validation. Real isolated PostgreSQL verifies one debit under concurrent admissions, 60.01-second rounding, cap and restriction refusal, missing reservation and source revision fencing. Source-ready STT handoff, operator refund proof, truthful client readiness and full integration remain open.
