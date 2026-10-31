# Candidate code review

Reviewed base `9a56538bf7f704c783f5c0f20b200ca8b7bafd2a` through candidate `62efbf1540b12f1f853c4b5ae06eefdd43ddbfe0`. The Standards and Spec axes ran independently. This review does not close the integrated cloud gates or authorize an acceptance claim.

## Standards

- P2, documented boundary violation. The local-device HTTP module implemented source eligibility and the bounded reconnect SQL policy. AGENTS.md requires HTTP modules to admit, validate, call services and serialize. Resolved by `01ad5b96`: `local-fetch-device-execution.ts` owns eligibility and known-Workspace reconciliation; HTTP retains signature/body/cursor parsing, with lazy database access and injected delivery. Eighteen focused tests, 922 API tests and eight actual workerd checks pass. No authorization bypass was demonstrated.
- P3, design judgment. `native-operation-driver.ts` repeats watchdog registration and retry-result classification in its dependency-wait and active-execution paths. Current behavior is tested and correct. Retained as two explicit wait states during this cutover; no new abstraction was introduced for this judgment alone.

## Spec

- P1, source-read acceptance remains open. Spec §7.6 requires selected-window reads at most 20% of a three-hour source. The first full 12-window diagnostic measured 357.55%. Bounded cache/backpressure changes and a declared representative-source benchmark are in progress. The index-heavy compact source remains a failure diagnostic; no partial-window result is substituted for aggregate acceptance.
- P1, integrated acceptance remains open. Deployed 45-minute 10GiB transfer/pin, qualified restore, laptop fetch, live provider flows, idle/cold measurements and latency/quota cohorts must pass with raw evidence before cutover. Prepared drivers and deterministic tests do not establish those results.
- Final cleanup. The temporary `CutoverVerification` export remains in the candidate only for the full-Worker memory gate. Remove that export and its fixed verification entrypoint before the deletion-inclusive release.

No additional authority/restore/scheduler correctness defect or material product scope creep was confirmed by the independent Spec review. `packages/email` remains unchanged. Neon Free is the owner's explicit replacement for the earlier Launch prerequisite.

## Subsequent live-gate findings

The real epoch2 fixture then found three related Ingest defects outside that review pin: fresh admission inherited epoch1, manual retry omitted its initial Import dispatch, and the open-admission guard was attached to cancellation instead of new retry admission. `0368ce07` and `2a16d31a` fix these through the locked current epoch and atomic dispatch. Pinned Bun1.3.6 tests cover actual Core starts, current-epoch retries, proof-bound restoration and fresh post-restore admission: 28 PostgreSQL tests and175 assertions pass. The exact never-started bad fixture was cancelled through the current domain command, preserving its zero charged starts; no storage or provider work had begun.

Standards: two findings, the documented P2 resolved and the P3 judgment retained. Spec: two acceptance blockers and one final cleanup remain; no additional confirmed code defect from that axis. The three subsequent live Ingest defects are fixed, with deployment and broader acceptance still tracked separately.
