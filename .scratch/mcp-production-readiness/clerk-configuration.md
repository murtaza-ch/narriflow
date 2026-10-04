# Development OAuth configuration

Verified configuration on October 5, 2026 for development issuer ideal-midge-4.clerk.accounts.dev. The user explicitly authorized Clerk administrator changes because CLERK_BAPI_SCOPES is unset.

Applied and read back: audience claims enabled, PKCE S256 required, all nine Narriflow scopes advertised, and the five reads added to registration defaults alongside existing email/profile/openid. DCR and JWT settings were retained. The six existing public Codex registrations now permit all nine Narriflow scopes, retain their existing built-in scope ceilings, and require consent and PKCE. A ceiling permits requesting consent; it does not add grants to existing tokens. Public discovery returned all nine application scopes and S256.

Local apps/web/.env.local now contains a generated continuation secret; its value was not logged. Hosted secret stores remain unverified. [Dashboard evidence](evidence/clerk-oauth-scopes.jpg).

## Configuration checklist

1. Enable audience claims derived from RFC 8707 resource and require PKCE S256 via PATCH /v1/instance/oauth_application_settings: {"aud_claim_enabled":true,"pkce_required":true}. Preserve unrelated settings.
2. Create the nine Narriflow application scope keys in Dashboard OAuth Applications → Scopes. The published Backend API does not expose scope-catalog creation.
3. Set read defaults to projects:read, exports:read, usage:read, autopilot:read, publishing:read; retain identity/refresh scopes only where the client needs them.
4. Configure each intended client application ceiling to support those five reads plus processing:write, exports:write, autopilot:write and publishing:write. Writes require explicit user consent. Verify DCR-created and existing registrations separately.
5. Clients must send resource=http://localhost:3000/mcp locally or the deployed canonical HTTPS /mcp URL, matching NEXT_PUBLIC_APP_URL on that server. There is no application audience allowlist field in the inspected API contract; Narriflow enforces exact audience on every online verification.
6. Read back settings and discovery. Complete actual consent and inspect verified audience/scopes without saving token bytes. Existing tokens without the canonical audience fail closed.

Fresh OAuth consent, the resulting canonical audience, application grants, and newly registered Claude/ChatGPT client ceilings still require actual client walkthroughs. Do not treat public discovery or an updated existing Codex registration as proof of those flows.

The installed Clerk Backend API skill requires administrator authorization when CLERK_BAPI_SCOPES is missing. The user provided it before the API writes.

Sources: https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth and https://github.com/clerk/openapi-specs/blob/main/bapi/2026-05-12.yml .
