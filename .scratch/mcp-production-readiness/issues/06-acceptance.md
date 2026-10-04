# 06 - Integration and acceptance

**What to build:** Deterministic MCP CI, repaired client catalog, affected repository/database gates and recorded external launch checks.

**Blocked by:** [01](01-authentication.md), [02](02-domain-retries.md), [03](03-tool-workflow.md), [04](04-apps-upload.md), [05](05-tasks.md).

**Status:** claimed

**Owner:** acceptance implementer and root integration

- [x] Code review and lint/typecheck/test/build/database gates pass.
- [ ] Clerk resource/scopes configured, migrations applied, actual OAuth client walkthroughs recorded.
- [x] Any unavailable external release gate is clearly recorded without claiming production readiness.

Independent acceptance work: repaired live smoke checks use existing environment credentials and perform reads only. The catalog follows the current shared policy registry, with App-only entries identified separately. Root scripts and CI now cover deterministic MCP integration and disposable MCP acceptance/Tasks data gates. Installed versions and pending external launch evidence are recorded in [MCP launch acceptance](../../../docs/runbooks/mcp-launch-acceptance.md).

Clerk administration and both MCP migrations are complete. Authentication commits 710801f and c130550 were integrated into dev with user authorization, reconciling all applied migration checksums before deployment. The user explicitly deferred live Codex/Claude/ChatGPT and API-key media walkthroughs until later. Those checks and hosted continuation-secret verification keep this launch-acceptance ticket open; implementation and automated checks are complete.
