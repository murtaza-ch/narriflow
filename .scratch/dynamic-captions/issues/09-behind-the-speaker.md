# 09 - Behind the speaker

**What to build:** A hero can sit behind the person, with the Depth style and a toggle (spec 5.12, gate G3).

**Blocked by:** 06

**Status:** ready-for-agent

Spec: [../spec.md](../spec.md). Follow the spec; where a ticket and the spec disagree, the spec wins.

## Acceptance

- [ ] Model vendored in both places with a hash test; `person_matte.py`; plan `mattes`; matte mode of the visual stack; split caption track and graph.
- [ ] Typed degradation `caption_matte_unavailable` in worker and Studio.
- [ ] G3 on 5 real clips recorded before the Studio half starts.
- [ ] Studio segmenter worker, person canvas, layer order; Depth style; toggle; Sol visual review recorded.
- [ ] `bun run lint`, `bun run typecheck`, `bun run test` pass (Bun 1.4.4). No PostgreSQL or heavy suites.

## Comments
