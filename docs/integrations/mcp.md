# Narriflow MCP integration

Narriflow serves `/mcp` through the SDK v2 request-scoped HTTP factory. Modern
`2026-07-28` exchanges have no initialization handshake or session. Older
Streamable HTTP clients use SDK legacy handling with the same tool/admission
implementation. Stdio in `apps/mcp` revalidates its API key on every request.

## Access and workflow

Discover `workspaceId` with `narriflow_list_workspaces`. Workspace tools require
current membership, role, active Business entitlement and resource ownership.
API keys are restricted to their own workspace. OAuth tokens must have the
canonical `/mcp` resource in their verified audience. Both credentials use:

| Scope | Tools |
| --- | --- |
| Discovery, no scope | `narriflow_list_workspaces` |
| `projects:read` | `narriflow_list_projects`, `narriflow_get_project`, `narriflow_list_clips`, `narriflow_get_clip` |
| `usage:read` | `narriflow_get_workspace_usage` |
| `exports:read` | `narriflow_get_clip_export` |
| `autopilot:read` | `narriflow_list_autopilot_rules` |
| `publishing:read` | `narriflow_list_social_accounts`, `narriflow_get_publishing_options`, `narriflow_list_social_publications`, `narriflow_get_social_publication` |
| `processing:write` | `narriflow_submit_video`, `narriflow_upload_video`, `narriflow_generate_clips` |
| `exports:write` | `narriflow_create_clip_export` |
| `autopilot:write` | `narriflow_create_rss_autopilot_rule`, `narriflow_run_autopilot_rule_now` |
| `publishing:write` | `narriflow_prepare_social_post`, `narriflow_schedule_social_post`, `narriflow_recheck_social_publication`, `narriflow_confirm_social_publication`, `narriflow_publish_social_publication_again` |

New API keys default to all five read grants; writes require explicit grants.
Run-now requires `processing.consume`, marks the rule due, preserves worker
leases and uses normal quota admission.

Mutations require explicit workspace selection and a UUID
`clientIdempotencyKey`. Retry unchanged input with the same key after a lost
response. Changed immutable input returns a typed conflict. Domain records
and replay receipts commit together. Link submission commits ingest and
generation settings together, using canonical Content Pack defaults/quota.
New forced generations cannot overlap active generation work.

Follow project progress, list clips, review their editor revisions and create
exports for selected aspect ratios/resolution. Clip lists default to 20,
capped at 50. Excerpts are opt-in. Results contain compact product facts and
ordinary review/download links. Temporary media URLs and upload grants appear
only in client/App metadata.

Prepare the exact export variant, revision, destination, caption, provider
settings and time before scheduling. Preparation is not approval. Scheduling
requires an accepted MRTR form, App button or authenticated web confirmation
of that same intent, then rechecks review approval. Signed continuations bind
caller/workspace/tool/intent for ten minutes. Accepted scheduling retries can
replay after expiry; expired unaccepted intents require new preparation.
Recovery tools inspect/reconcile existing operations; publish-again requires
explicit duplicate-risk acknowledgement.

## Configuration

Use app-local environment files or deployment secret stores:

```dotenv
NEXT_PUBLIC_APP_URL=https://app.example.com
CLERK_OAUTH_ISSUER=https://clerk.app.example.com
CLERK_SECRET_KEY=<Clerk backend secret>
MCP_CONTINUATION_SECRET=<one shared secret with at least 32 bytes>

# Optional additions: hostnames for Hosts, full origins for Origins.
MCP_ALLOWED_HOSTS=app.example.com
MCP_ALLOWED_ORIGINS=https://trusted-client.example.com:8443
```

Continuation secrets must match across web/stdio instances that create or
accept state. Keep them out of tracked files and upload-helper environments.
Production URLs use HTTPS. Browser origins match scheme, host and port;
CORS headers appear only for accepted origins. MCP JSON is bounded to 1 MiB;
media bytes transfer directly to storage.

In Clerk, enable audience claims derived from RFC 8707 `resource`, require
PKCE S256, retain hosted user consent, and create all nine application scopes.
Set read defaults and configure each intended application's scope ceiling.
Advertising scopes alone does not grant them. Clients must send the exact
canonical resource matching `NEXT_PUBLIC_APP_URL` plus `/mcp`. Online
verification on every request enforces audience, expiry and revocation.
See [Clerk's OAuth contract](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).

Discovery documents are `/.well-known/oauth-protected-resource/mcp`, its root
alias, and the authorization-server mirror. The integration page verifies
discovery, PKCE/scopes advertisement and continuation-secret presence; it
does not establish actual consent or token resource binding.

The budget is 300 authenticated requests per credential/user per minute;
actual denials return 429. During Redis outages, reads/status and accepted
replay remain available; new mutations pause with retryable errors.
Credential/scope failures have standard Bearer challenges. Clerk outages
and throttling have retryable availability responses. Bounded diagnostics
exclude tokens, transcripts, grants and raw provider errors.

## Clients and upload

For installed Codex versions supporting these flags:

```bash
codex mcp add narriflow --url https://app.example.com/mcp --oauth-resource https://app.example.com/mcp
codex mcp login narriflow --scopes projects:read,exports:read,usage:read,autopilot:read,publishing:read
```

For Claude Code:

```bash
claude mcp add --transport http narriflow https://app.example.com/mcp
claude mcp login narriflow
```

Configure ChatGPT's remote connector with the public HTTPS endpoint and
complete its own OAuth consent. Record actual client versions/capabilities
in the [acceptance runbook](../runbooks/mcp-launch-acceptance.md).

The upload tool opens a capable assistant picker or authenticated web handoff.
They reuse Upload Sessions, multipart transfer/resume, exact-object verification
and atomic ingest handoff. The local helper supports Codex/Claude Code:

```bash
# Load NARRIFLOW_API_KEY and NARRIFLOW_URL through your environment/secret store.
bun run mcp:upload --file /absolute/path/video.mp4 --workspace <workspaceId> --key <UUID>
```

Its key needs `processing:write`. Reuse the same UUID and unchanged file to
resume. The helper prints its operation key before networking and never sends
the Narriflow credential to storage. `--settings` accepts a JSON file matching
the MCP generation-settings contract. Attachment adapters remain disabled
until their specific host file contract is tested.

Stdio runs with `bun --cwd apps/mcp run start`. Supply `NARRIFLOW_API_KEY` and
the existing service database/storage/Redis environment. Signed web handoffs
also require the canonical app URL and shared continuation secret. The upload
helper needs only its key and Narriflow URL, without service credentials.

## Extensions and verification

Versioned `ui://narriflow/v2/` resources use the standard MCP Apps bridge for
upload, progress, clip review and exact-post confirmation. App-only actions
use their public workflow's grants. Static templates can be public-cacheable;
private results use zero TTL. CSP explicitly declares app/storage/media origins.
Cards follow the host's light/dark theme. Clip review groups preview, scores and
Studio navigation; upload shows file selection and committed generation settings.
Signed handoff links and internal identifiers are not printed in the cards.
After a resource-version update, refresh the client's Narriflow tool catalog
before invoking a fresh card. Previously cached cards keep their original resource URI.

Tasks require verified modern per-request extension capabilities. Durable
handles support modern `tasks/get`, `tasks/update` and cooperative
`tasks/cancel`, with five-second suggested polling. Ownership, originating
operation, result contract and terminal snapshot persist for seven days.
Expiry does not cancel domain work; completed outcomes remain immutable.
Generation Tasks follow transcription, detection and default render lineage.
Unsupported clients receive ordinary operation IDs/status guidance.
Task HTTP requests send `MCP-Name` equal to `params.taskId`.

Apply the `McpOperation` and `McpTask` migrations before running/deploying
their code. Verify both database URLs select the intended shared database.
Run lint, typecheck, tests, dependency audit, build, `test:mcp:integration`,
`test:mcp:db` and lifecycle database gates. DB fixtures use disposable schemas.
The opt-in `test:mcp:e2e` checks an existing bearer credential read-only;
it does not establish assistant OAuth consent.

Launch requires actual OAuth workflows in Codex, Claude and ChatGPT plus a
live API-key upload-helper walkthrough. Keep those gates pending until the
[acceptance evidence](../runbooks/mcp-launch-acceptance.md) records them.
