# 03 — Make repository verification commands truthful

**What to build:** Make local quality commands describe the work they actually perform. The documented lint command must run Biome, packages without meaningful tasks must stop inflating successful task counts, and the fast test aggregate must remain useful while clearly distinguishing skipped database verification.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

**Specification:** [Close the remaining architecture findings](../spec.md)

- [ ] The root lint command runs the repository-wide Biome check and returns Biome's exit status.
- [ ] Local and CI lint commands have the same semantics rather than relying on a separate hidden real command.
- [ ] Workspace lint scripts that only print a no-op success are removed from official aggregation.
- [ ] Packages with no meaningful test task may omit the task instead of contributing a successful no-op result.
- [ ] Removing no-op tasks does not claim new Auth, Email, MCP bootstrap, Config, or database-client coverage.
- [ ] The root test command continues to run every existing deterministic package suite, including active web tests.
- [ ] Database suites remain disabled in the fast aggregate unless their explicit isolation flags and database inputs are present.
- [ ] Fast aggregate output makes skipped database suites visible and cannot be described as database verification.
- [ ] Repository instructions state that web tests are active and distinguish fast tests from disposable-schema PostgreSQL commands.
- [ ] CI continues to run lint, typecheck, fast tests, production dependency audit, and production build after the script cleanup.
- [ ] A deliberate Biome violation makes the documented lint command fail in verification, while the clean working tree passes.
- [ ] Repository typecheck, truthful lint, and fast aggregate tests pass without relying on cached no-op task results.

