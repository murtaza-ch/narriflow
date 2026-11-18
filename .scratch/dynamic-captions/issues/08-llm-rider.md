# 08 - Llm rider

**What to build:** Only if G1 failed: emphasis words from the clip selection call feed the scorer (spec 5.13).

**Blocked by:** 01

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Built only if G1 recorded a failure after one tuning round; otherwise mark `done` with "not needed" and the G1 numbers.
- [ ] Schema, prompt, persistence migration, scorer bonus, critical-path review of the selection contract.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments

G1 failed for native script after one tuning round (72.6% held-out, bar 80%); see ticket 01. This ticket is needed.
