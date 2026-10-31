# 23 - Remove obsolete code; dev/CI/docs

**What to build:** Remove obsolete code; dev/CI/docs.

**Blocked by:** 22

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** the §6 deletion list. Move useful tests instead of dropping coverage. Update dev startup, `env:check`, CI, AGENTS.md, README and runbooks.
- **Accept:** a repo-wide search finds no polling scheduler, worker URL or obsolete dependency. Static and fast gates rerun on the exact deletion-inclusive SHA.

## Evidence

Pending implementation and verification.
