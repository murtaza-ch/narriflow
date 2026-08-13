# Narriflow MCP integration

Narriflow exposes one remote MCP endpoint at `https://<app-origin>/mcp` and a
local stdio fallback in `apps/mcp`. The remote endpoint implements MCP
`2026-07-28` with `@modelcontextprotocol/server` v2: there is no initialization
handshake or protocol session for current clients, and a fresh server instance
handles each HTTP request. The v2 handler also accepts stateless 2025-era
Streamable HTTP clients during the compatibility window.

## What is exposed

| Tool | Required workspace capability | API-key scope | Billing/cost behavior |
| --- | --- | --- | --- |
| `narriflow_list_workspaces` | Membership | None | Shows whether MCP is enabled per workspace |
| `narriflow_list_projects` | `content.view` | `projects:read` | Active Business workspace |
| `narriflow_get_project` | `content.view` | `projects:read` | Active Business workspace |
| `narriflow_get_workspace_usage` | `content.view` | `usage:read` | Reports the existing monthly minute quota |
| `narriflow_list_autopilot_rules` | `content.view` | `autopilot:read` | Active Business workspace |
| `narriflow_create_rss_autopilot_rule` | `content.edit` | `autopilot:write` | Later imports use the normal processing quota gate |
| `narriflow_run_autopilot_rule_now` | `content.edit` | `autopilot:write` | Marks the rule due; it does not bypass quota checks |

MCP and workspace API keys are Business-plan integration capabilities. OAuth
identifies the Narriflow user, then every tool re-checks workspace membership,
role, subscription state, and the specific capability. An API key is bound to
one workspace and cannot select another workspace.

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

Keys created in **Settings -> Developer access** receive read scopes by default. Enable the
autopilot-write option only for clients that should be able to change rules.

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

Run it with `bun --cwd apps/mcp run start`. The key's workspace and scopes are
enforced exactly as they are on the remote endpoint.

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
