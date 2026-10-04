# Narriflow MCP production readiness

**Status:** implementation verified; live launch acceptance deferred by the user

Implement the approved stateless SDK v2 architecture and complete the safe clip workflow. Both transports must use fresh credential verification and identical workspace, scope, role, entitlement, ownership, and mutation admission. Business access is required. Reads are granted separately from processing, exports, autopilot, and publication writes.

## Contracts

Strict Zod contracts live in validators. Public results project product facts, operation identifiers, status guidance, and ordinary review links; no storage keys, provider internals, full transcripts, upload grants, or temporary media URLs. Workspace discovery uses workspaceId. Mutations select workspace explicitly and require clientIdempotencyKey. Keys bind immutable input and replay accepted outcomes; domain mutation and identity commit atomically. During limiter outages preserve reads/status/replays and pause new writes.

## Workflow

Keep the eleven existing tools and add submit_video, upload_video, generate_clips, list_clips, get_clip, create_clip_export, get_clip_export, list_social_accounts, get_publishing_options, prepare_social_post, schedule_social_post, and list_social_publications. Link ingest commits generation settings atomically. Upload picker, authenticated handoff, and local CLI reuse Upload Sessions and direct storage transfer. Clip lists default to 20, capped at 50; excerpts are opt-in. Existing quota, editor revisions, exports, review, and publishing remain authoritative.

Publication preparation exposes the exact revision/export/account/caption/provider settings/time. Scheduling requires accepted confirmation of that immutable intent. Signed continuation state binds caller, workspace, tool, intent and ten-minute expiry. Preparation cannot imply approval. MRTR, capable App buttons, and authenticated web confirmation cover client capabilities.

## Extensions

Apps use the standard bridge and versioned static HTML for upload, progress, clip review, and confirmation. Static templates may be public-cacheable, private results have zero TTL, and CSP explicitly limits storage/media domains. Grants live only in client/app metadata.

Tasks reference existing work; no new scheduler. Ownership, originating operation, immutable result contract, seven-day expiry and terminal snapshot are durable. Implement modern tasks/get, tasks/update, and cooperative tasks/cancel only when negotiated. Suggested polling interval is five seconds; expiry does not cancel work; terminal outcomes are immutable. A narrow dispatcher validates task handles separately from final tool results. Unsupported clients receive durable operation IDs and status guidance.

## Security and serving

Verify Clerk tokens online, validate response schema and expiration, and require aud containing canonical /mcp URL. Advertise application scopes. Distinguish invalid tokens from throttling/outages. Stdio reauthenticates each request. Validate full browser origins, return CORS only to accepted origins, limit JSON to 1 MiB, preserve SDK modern/older exchanges, and use bounded structured diagnostics without sensitive data.

## Delivery and release gates

See [sourced audit](../../docs/reviews/mcp-production-readiness.md). Implement dependent tickets below and record evidence. Verify modern/older protocol, metadata/header mismatch, methods, CORS/cache isolation; OAuth scope/audience/expiry/revocation/outages and stdio revocation; workspace/member/role/plan isolation; concurrent duplicate/lost response/conflict/upload interruption/restart; stale revision/tampered/expired/declined confirmation/review approval; task ownership/expiry/terminal/cancel races. Run repository lint/typecheck/test/build and affected disposable-schema DB gates. Fix stale E2E catalog and add deterministic CI coverage.

External release gates remain explicit: configure Clerk resource and scopes, apply migrations before deployment, and complete actual OAuth walkthroughs in Codex/Claude/ChatGPT plus API-key upload, recording versions and capabilities. Integration UI must report verified configuration rather than unconditional Ready. Do not claim launch readiness without these gates.

## Tickets

1. [Authentication and transport](issues/01-authentication.md)
2. [Domain retry safety and atomic intake](issues/02-domain-retries.md)
3. [Contracts and complete tool workflow](issues/03-tool-workflow.md)
4. [Apps and upload delivery](issues/04-apps-upload.md)
5. [Durable Tasks](issues/05-tasks.md)
6. [Integration and acceptance](issues/06-acceptance.md)

Embedded Studio editing, new social providers, and brand/campaign/generated-media expansion are separate work.
