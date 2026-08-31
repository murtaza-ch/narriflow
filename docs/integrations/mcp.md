# Narriflow MCP integration

Narriflow exposes one remote MCP endpoint at `https://<app-origin>/mcp` and a
local stdio fallback in `apps/mcp`. The remote endpoint implements MCP
`2026-07-28` with `@modelcontextprotocol/server` v2: there is no initialization
handshake or protocol session for current clients, and a fresh server instance
handles each HTTP request. The v2 handler also accepts stateless 2025-era
Streamable HTTP clients during the compatibility window.

The same high-level workflows are available to non-interactive clients through
the [Business REST API v1](./business-api.md). MCP and REST share one sanitized
service boundary; neither exposes provider controls, review secrets, or signed
media URLs.

## What is exposed

| Tool | Required workspace capability | API-key scope | Billing/cost behavior |
| --- | --- | --- | --- |
| `narriflow_list_workspaces` | Membership | None | Shows whether MCP is enabled per workspace |
| `narriflow_list_projects` | `content.view` | `projects:read` | Active Business workspace |
| `narriflow_get_project` | `content.view` | `projects:read` | Active Business workspace |
| `narriflow_get_workspace_usage` | `content.view` | `usage:read` | Reports the existing monthly minute quota |
| `narriflow_get_social_publication` | `content.view` | `publishing:read` | Returns recovery facts without provider checkpoint state |
| `narriflow_recheck_social_publication` | `publishing.manage` | `publishing:write` | Reconciles the existing operation; never submits again |
| `narriflow_confirm_social_publication` | `publishing.manage` | `publishing:write` | Records bounded operator evidence and settles without submission |
| `narriflow_publish_social_publication_again` | `publishing.manage` | `publishing:write` | Requires explicit duplicate-risk acknowledgement and creates a linked attempt |
| `narriflow_list_autopilot_rules` | `content.view` | `autopilot:read` | Active Business workspace |
| `narriflow_create_rss_autopilot_rule` | `content.edit` | `autopilot:write` | Later imports use the normal processing quota gate |
| `narriflow_run_autopilot_rule_now` | `content.edit` | `autopilot:write` | Marks the rule due; it does not bypass quota checks |
| `narriflow_list_brand_profiles` | `content.view` | `brand:read` | Omits signed asset and font URLs |
| `narriflow_get_brand_profile` | `content.view` | `brand:read` | Reads one profile owned by the selected Workspace tenant; `brand:write` remains reserved |
| `narriflow_list_campaign_operations` | `content.view` | `campaign:operate` | Returns durable per-item status without stored option/result payloads |
| `narriflow_apply_campaign_motion` | `content.edit` | `campaign:operate` | Requires revision-fenced clips and an idempotency UUID |
| `narriflow_get_campaign_editor_action_catalog` | `content.view` | `campaign:operate` | Returns the frozen project brand and eligible styles/scenes without media URLs |
| `narriflow_preview_campaign_editor_action` | `content.view` | `campaign:operate` | Returns eligibility, unchanged clips, and revision conflicts without editor patches |
| `narriflow_apply_campaign_brand_profile` | `content.edit` | `campaign:operate` | Applies the project-frozen Brand Profile to revision-fenced clips |
| `narriflow_apply_campaign_style` | `content.edit` | `campaign:operate` | Applies one owned Brand Template to revision-fenced clips |
| `narriflow_apply_campaign_scene_template` | `content.edit` | `campaign:operate` | Inserts one owned intro/outro Scene Template into revision-fenced clips |
| `narriflow_list_review_rounds` | `content.view` | `review:read` | Omits tokens, passcodes, recipients, comments, and guest identity |
| `narriflow_create_review_round` | `review.manage` | `review:write` | Idempotent; sends durable notifications but never returns guest access secrets |
| `narriflow_generate_assisted_copy` | `publishing.manage` | `publishing:prepare` | Uses the configured model and Brand guidance; no model/prompt controls |
| `narriflow_get_assisted_copy` | `content.view` | `publishing:prepare` | Returns one typed draft and confirmation status |
| `narriflow_request_thumbnail_extraction` | `publishing.manage` | `publishing:prepare` | Extracts from one immutable export variant |
| `narriflow_get_thumbnail_extraction` | `content.view` | `publishing:prepare` | Omits storage keys and signed URLs |
| `narriflow_schedule_campaign` | `publishing.manage` | `publishing:prepare` | Enforces revisions, exact exports, approval, account ownership, copy, thumbnail, and each item’s immutable `occurrenceIndex` before creating Social Posts |
| `narriflow_submit_generated_media` | `content.edit` | `generated-media:submit` | Submits an enabled high-level image job; video remains unavailable without an approved registered adapter |
| `narriflow_get_generated_media_job` | `content.view` | `generated-media:submit` | Omits prompts, source text, provider controls/payloads, storage keys, and URLs |

MCP and workspace API keys are Business-plan integration capabilities. OAuth
identifies the Narriflow user, then every tool re-checks workspace membership,
role, subscription state, and the specific capability. An API key is bound to
one workspace and cannot select another workspace. API-key rows are re-read on
every tool authorization, including local stdio, so revocation and scope
changes take effect without restarting the client.

## Production configuration

Set these values in `apps/web/.env.local` locally and in the web deployment's
secret/configuration store in production:

```dotenv
NEXT_PUBLIC_APP_URL=https://app.example.com
CLERK_OAUTH_ISSUER=https://clerk.app.example.com

# Optional Clerk Account Portal origin used for the hosted OAuth consent screen.
CLERK_OAUTH_CONSENT_ORIGIN=https://accounts.example.com

# Optional comma-separated additions. Values may be hostnames or origins.
MCP_ALLOWED_HOSTS=app.example.com
MCP_ALLOWED_ORIGINS=
```

`CLERK_OAUTH_ISSUER` is the Clerk Frontend API/authorization-server issuer,
not `https://api.clerk.com`. Production origins must use HTTPS. Requests with
an unrecognized `Host` or browser `Origin` are rejected before token
verification.

Clerk's hosted Account Portal owns the consent UI as well as PKCE, grants,
codes, tokens, refresh, and revocation. Narriflow continues to enforce
workspace membership, role, subscription, and tool capabilities after Clerk
authenticates the user.

`CLERK_OAUTH_CONSENT_ORIGIN` is the Clerk Account Portal origin.
Development `*.clerk.accounts.dev` issuers derive their matching
`*.accounts.dev` portal automatically; set it explicitly only when a production
deployment uses a custom Account Portal domain.

In Clerk Dashboard:

1. Open **Paths -> OAuth consent** and select Clerk's hosted Account Portal.
2. Open **OAuth applications** and keep the consent screen enabled.
3. Choose the access-token format that matches the rest of the deployment.
   Narriflow currently verifies both JWT and opaque OAuth access tokens through
   Clerk on every request for uniform revocation and expiry handling.
4. Enable and advertise Client ID Metadata Documents (CIMD) when available.
   MCP `2026-07-28` prefers CIMD over Dynamic Client Registration (DCR).
5. Enable DCR only when a client still requires it. It is a public client
   registration endpoint, so monitor registrations and remove abandoned or
   suspicious clients.
6. Configure default scopes for clients that omit `scope`. Use the minimum:
   `openid profile email`; add `offline_access` only when refresh tokens are
   required.

The deployment publishes these discovery documents automatically:

- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource` (compatibility alias)
- `/.well-known/oauth-authorization-server` (a compatibility mirror of Clerk)

## Codex and ChatGPT desktop

OAuth is the recommended setup:

```toml
[mcp_servers.narriflow]
url = "https://app.example.com/mcp"
auth = "oauth"
default_tools_approval_mode = "writes"
```

Then run:

```bash
codex mcp login narriflow
```

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share the same MCP
configuration on a Codex host. In the desktop or IDE UI, choose **Streamable
HTTP**, enter the same URL, and authenticate when prompted.

For a non-interactive Business workspace, create a scoped Narriflow API key and
load it from the environment instead of putting the secret in `config.toml`:

```toml
[mcp_servers.narriflow]
url = "https://app.example.com/mcp"
bearer_token_env_var = "NARRIFLOW_API_KEY"
default_tools_approval_mode = "writes"
```

Keys created in **Settings -> Developer access** receive read scopes by default.
Enable only the write scopes the client needs. `brand:write` is reserved and
does not expose a public Brand Profile mutation in this version.

## Claude

For Claude, Claude Desktop, Cowork, and mobile, add a **custom remote
connector** with `https://app.example.com/mcp`. These clients connect from
Anthropic's cloud, so the URL must be publicly reachable. Complete the Clerk
OAuth consent flow for each Narriflow user.

For Claude Code:

```bash
claude mcp add --transport http narriflow https://app.example.com/mcp
```

Open `/mcp` in Claude Code and complete authentication in the browser. For
Team/Enterprise Claude accounts, an owner first registers the custom connector
and each member then connects their own Narriflow identity.

## Local stdio fallback

The stdio server authenticates with a workspace API key rather than a raw
database user ID:

```dotenv
DATABASE_URL=postgresql://...
NARRIFLOW_API_KEY=nf_...
```

Run it with `bun run --cwd apps/mcp start`. The key's workspace and scopes are
enforced exactly as they are on the remote endpoint. The startup process keeps
only credential identity; each tool call reloads the active row and fails
closed if it was revoked, rebound, or changed.

## Operations and security

- The HTTP handler is stateless and safe behind a round-robin load balancer.
  Database, Redis, and SDK connection pools may be reused by an instance, but
  no MCP session state is stored.
- The server advertises public five-minute cache hints for its deterministic
  tool catalog and discovery response. Workspace data is never publicly
  cacheable.
- Write tools carry MCP write annotations so capable clients can prompt for
  approval. Narriflow logs their user, workspace, client, credential type, and
  tool name without logging tokens.
- Idempotent workflow tools require a caller-supplied UUID and return the same
  durable result after a lost response. Reusing a key with changed input is a
  conflict.
- Workflow failures expose the same stable, content-free domain codes as REST.
  Do not branch on message text.
- The MCP endpoint has a distributed-when-Redis-is-available request limit of
  300 requests per credential/user per minute. It fails open if optional Redis
  is unavailable, matching the application's existing availability policy.
- Rotate or revoke an API key from **Settings -> Developer access**. OAuth grants are
  revoked from Clerk or by disconnecting the connector in the client.

## Verification

After deployment, verify discovery, authentication, and tools with the current
MCP Inspector, then test both an OAuth client and an API-key client. Run:

```bash
bun run typecheck
bun run test
```

For a real Codex OAuth check, add the remote server, complete the Narriflow
consent screen, and invoke a read tool from a fresh Codex process:

```bash
codex mcp add narriflow --url https://app.example.com/mcp
codex mcp login narriflow
```

Apply all pending Prisma migrations before deployment; this MCP change itself
does not add a migration.

Generated still images also require the parent and image rollout controls plus
the configured OpenAI image adapter. Keep generated video disabled until an
approved provider adapter and the required production and real-media evidence
exist; configuration fields alone do not make the tool available.
