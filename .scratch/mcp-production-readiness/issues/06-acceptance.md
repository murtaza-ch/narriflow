# 06 - Integration and acceptance

**What to build:** Deterministic MCP CI, repaired client catalog, affected repository/database gates and recorded external launch checks.

**Blocked by:** [01](01-authentication.md), [02](02-domain-retries.md), [03](03-tool-workflow.md), [04](04-apps-upload.md), [05](05-tasks.md).

**Status:** claimed

**Owner:** acceptance implementer and root integration

- [x] Code review and lint/typecheck/test/build/database gates pass.
- [ ] Clerk resource/scopes configured, migrations applied, actual OAuth client walkthroughs recorded.
- [x] Any unavailable external release gate is clearly recorded without claiming production readiness.

Independent acceptance work: repaired live smoke checks use existing environment credentials and perform reads only. The catalog follows the current shared policy registry, with App-only entries identified separately. Root scripts and CI now cover deterministic MCP integration and disposable MCP acceptance/Tasks data gates. Installed versions and pending external launch evidence are recorded in [MCP launch acceptance](../../../docs/runbooks/mcp-launch-acceptance.md).

Clerk administration and both MCP migrations are complete. Authentication commits 710801f and c130550 were integrated into dev with user authorization, reconciling all applied migration checksums before deployment. Remaining client/media and revocation gates keep this ticket open.

## Comments

October 5: the user authorized live testing of their connected Codex desktop server against an existing project. OAuth-authenticated workspace/project/clip/usage/destination discovery, pagination, optional excerpt, and workspace isolation passed. Export admission exposed a limiter cold-start defect: commands ran before lazy Redis readiness with offline queuing disabled. A regression reproduced the failure before the fix; the fix and shared Redis probe pass. Repository lint/typecheck/test/build and 146 MCP integration tests pass. The missing hosted continuation secret was added to the Vercel development project as a sensitive environment variable. Commit 0d36b72 was pushed to dev and its Vercel deployment reached READY. Live export delivery, unchanged replay, changed-input conflict, mismatched-revision rejection, upload-handoff creation, and hosted configuration read-back all passed. Claude/ChatGPT/file transfer/embedded visual/publication/revocation acceptance remains open. See the runbook for durable IDs, evidence, and client version.

October 5, refreshed connection: the connected server is now `narriflow` and advertises v2 resources. The user confirmed that the redesigned cards display. Workspace/project/clip/export reads, pagination, workspace denial, reuse of the existing export, identical unchanged replay, changed-input conflict, mismatched-revision rejection, and upload-handoff creation passed again. No additional render, file transfer or publication occurred. The inline cards were unavailable to the side-panel inspection tool, so in-card playback and buttons remain unverified. Social discovery returned no destinations. See the runbook's refreshed-connection evidence.
