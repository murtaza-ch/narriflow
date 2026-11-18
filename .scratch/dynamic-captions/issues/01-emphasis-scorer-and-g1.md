# 01 - Emphasis scorer and g1

**What to build:** Every cue's hero word is chosen deterministically by `assignCaptionRoles` (spec 5.3), with a blind pick-sheet review (gate G1).

**Blocked by:** None

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] `packages/validators/src/caption-emphasis.ts` and the word lists (English, Urdu, Hindi, Roman Urdu/Hindi; 20 KB cap) implement spec 5.3 exactly, including units, the confidence gate and overrides.
- [ ] Unit tests cover each signal, the never-minor rules, units, the gate, every override value, the repeat penalty against automatic picks only, masked words and untimed utterances.
- [ ] `packages/validators/scripts/emphasis-sheet.ts` exports blind sheets from a JSON transcript export and scores labels against the scorer and the baseline.
- [ ] Real transcripts are exported read-only from the dev database (`PGOPTIONS='-c default_transaction_read_only=on'`, `packages/db/.env`) into the session scratchpad, never into git.
- [ ] G1 result recorded under `## Comments` (the orchestrator runs the Sol labelling).
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
