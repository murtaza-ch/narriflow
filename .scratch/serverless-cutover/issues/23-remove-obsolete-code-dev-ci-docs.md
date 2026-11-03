# 23 - Remove obsolete code; dev/CI/docs

**What to build:** Remove obsolete code; dev/CI/docs.

**Blocked by:** 22

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** the §6 deletion list. Move useful tests instead of dropping coverage. Update dev startup, `env:check`, CI, AGENTS.md, README and runbooks.
- **Accept:** a repo-wide search finds no polling scheduler, worker URL or obsolete dependency. Static and fast gates rerun on the exact deletion-inclusive SHA.

## Evidence

Root is integrating the deletion-inclusive candidate. `9d3d5ac2` removes the Bun worker app, API Docker/native smoke, optional Redis and obsolete dependencies. `be3e5ebf` removes the Ingest poller and ports source/usage/intake-event cases through actual Core. `c718e9d5` removes the Workflow supervisor and ports its main suite. Native and PostgreSQL CI now run explicitly; every database runner refuses shared development before connecting.

Acceptance remains open. Remaining fixture ports, docs and exact release-SHA gates must pass before completion. The integrated cloud gates and single cutover remain separate blockers.

## Local verification policy, 2026-11-03

At the owner's request, GitHub CI stays disabled. The repository pre-push hook runs lint, forced typechecking and deterministic suites, all twelve isolated local PostgreSQL gates, API inventory/OpenAPI/Worker checks, MCP integration, the production dependency audit, environment consistency, Zapier/Make checks, production builds, browser-bundle separation and the pinned Linux media suite. The hook is not bypassed. Shared development is not a test database. The latest runbook records the still-failed live speech gate and closed candidate intake; this ticket and the single cutover remain open.
