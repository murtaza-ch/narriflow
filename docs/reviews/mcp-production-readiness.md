# MCP production readiness audit

Audited against the July 28, 2026 protocol and SDK v2. The per-request server factory, stateless HTTP and SDK-managed resultType/cache wire fields are correct. Retain the SDK-supported older-client adapter through the same factory.

## Findings

OAuth verification did not validate audience and only advertised identity scopes. Stdio verified once at startup. RSS creation lacked caller idempotency. Results exposed internal snapshots through unknown contracts. Discovery returned id while instructions required workspaceId. Client E2E expected seven tools despite eleven registrations and used API keys rather than OAuth. MCP could not complete intake, export or initial publication.

Public development issuer metadata advertised PKCE/DCR and identity scopes, without Narriflow application scopes. This proves metadata availability, not complete application consent/resource binding. Live client OAuth remains a release gate.

## Primary sources and implementation constraints

- [Protocol release](https://blog.modelcontextprotocol.io/posts/2026-07-28/): stateless modern request metadata and result contracts.
- [SDK v2 HTTP serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html) and [older clients](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html): one request-scoped factory, supported compatibility handler.
- [Clerk BAPI contract](https://github.com/clerk/openapi-specs/blob/main/bapi/2026-05-12.yml): online verification exposes audience/scopes/revocation. Installed backend overload does not accept audience; validate verified response explicitly.
- [Input required and continuation state](https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.html): shared-key signed state is authenticated, not encrypted; bind caller and immutable intent, expire after ten minutes.
- [MCP Apps quickstart](https://apps.extensions.modelcontextprotocol.io/api/documents/quickstart.html): standard bridge, versioned HTML resource, UI capability and CSP metadata.
- [Tasks adapters and schemas](https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html): modern schemas require a narrow dispatcher because high-level tools expect final results. Tasks reference existing jobs and preserve immutable terminal results.
- [Codex protocol selection](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/protocol_mode.rs): client availability does not imply modern mode enabled by default. Record versions and negotiation in acceptance.

## Verification at audit time

57 focused tests and both MCP package typechecks passed. These establish the previous implementation baseline only. They do not establish complete OAuth, uploads, extension support or publication readiness. New implementation evidence belongs in the effort's [acceptance ticket](../../.scratch/mcp-production-readiness/issues/06-acceptance.md).

## Implementation follow-through

The dev implementation now provides strict compact contracts, 23 public tools, transactional replay identities, fresh scoped authentication, exact confirmation, Upload Session delivery, versioned Apps and negotiated durable Tasks. Independent Standards and Spec reviews found and resolved cancellation isolation, lost-response confirmation, expired-task replay, private eventual-result caching and concurrent-registration issues. [Final acceptance evidence](../runbooks/mcp-launch-acceptance.md) records 146 deterministic MCP tests, 22 MCP PostgreSQL tests, the existing database gates, provider configuration and applied migrations. Actual client/media acceptance was explicitly deferred by the user; it remains a launch gate.
