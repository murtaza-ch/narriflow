# 01 - Freeze execution contracts and responsibility map

**What to build:** Freeze execution contracts and responsibility map.

**Blocked by:** none

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** command/result schemas; lock order; epoch/generation/owner/lease/deadline semantics; dispatch inventory (§4.11); source/audio binding; deletion map. New ADR 0019 "Serverless execution". Amend 0001, 0003, 0004 (evidence transport), 0005, 0007, 0010, 0011, 0012, 0014 (delivery driver), 0017, 0018. Glossary terms.
- **Files:** `docs/adr/**`, `GLOSSARY.md`, `packages/validators/src/execution*.ts`.
- **Accept:** every loop has a trigger and destination. State diagrams cover ambiguous provider acceptance, response loss, cancel, restore and no-agent. Reuse patterns from cloudflare/workflows-starter, the DO hibernation example, modal-labs/modal-examples and yt-dlp, adding Narriflow's fences.

## Evidence

Pending implementation and verification.
