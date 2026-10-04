# MCP launch acceptance

Evidence recorded on October 5, 2026. Implementation and automated verification are complete on dev. The user subsequently authorized live testing of their Codex desktop connection and selected an existing development project. Codex reads, export delivery, retry safety, and upload-handoff creation are verified; full launch acceptance remains open.

## Automated coverage

`bun run test:mcp:integration` runs the deterministic MCP transport, authentication, tool, continuation, App, and upload-helper suites, plus browser/MCP admission parity. CI invokes it explicitly. `bun run test:mcp:db` applies repository migrations in a disposable `mcp_test_` schema, checks durable acceptance and Tasks, and drops that schema. It does not migrate shared development data.

The final deterministic MCP gate passed 146 tests with 697 assertions across 18 files. Coverage includes modern complete responses, SDK-supported 2025-11-25 exchanges through the same factory, revocation, private zero-TTL caller isolation, routing header mismatches, malformed metadata, methods/CORS/body bounds, scope challenges, Apps/upload recovery, exact confirmation, and negotiated Tasks. Eventual nested Task ToolResults explicitly carry private zero-TTL fields, and Task expiry does not prevent durable operation replay.

The final disposable MCP database gate passed 22 tests with 123 assertions, applied all 99 migrations, and removed its schema. It covers duplicate acceptance, lost responses, changed-input conflicts, atomic intake/settings, exact export cancellation and worker-claim races, concurrent Task registration, ownership, immutable outcomes, render retry/requeue, later cache changes and cancellation that preserves later Studio work.

All eight existing disposable database commands passed against a temporary local PostgreSQL 17 cluster: workflow (99 tests), upload (3), workspace billing (9), social publication (26), editor persistence (27), authenticated policy and automatic entry (10), brand profiles (11), and Vizard expansion (38). These fixtures created no real media jobs or publications.

Repository lint, typecheck, tests and build passed after integration; lint reports six existing warnings and one informational diagnostic. Production dependency audit passed at the high threshold after updating Next to 16.3.6 and brace-expansion to 2.1.6. Passing a synthetic verifier or a bearer-token smoke check does not establish OAuth consent in a real assistant.

## Installed client facts

| Client | Observed version | Observed negotiation/capability evidence | Full OAuth workflow |
| --- | --- | --- | --- |
| Codex CLI | 0.160.0 | `codex features list` reports local `mcp_2026_07_28` disabled. Apps and Tasks are unverified. | Pending |
| Codex desktop | 26.930.31730 (build 12947) | Connected OAuth server exposes 23 public tools as `narriflow-2`. Actual protocol revision and Apps/Tasks negotiation have not been captured. | Reads, export delivery/retries, and upload-handoff creation verified; full workflow pending |
| Claude Code | 2.1.289 | CLI offers HTTP transport and `claude mcp login`. Actual negotiated revision, Apps and Tasks are unverified. | Pending |
| ChatGPT | Not recorded | No actual client connection or extension exchange recorded. | Pending |

These facts came from installed CLI version/help/feature commands. They describe this machine, not universal client support. For each walkthrough record the actual version, endpoint, negotiated protocol revision, extension capabilities, test workspace, and result. If a client lacks Apps or Tasks, complete the ordinary-tool and web-handoff flow and record that limitation.

## Clerk configuration gate

After explicit administrator authorization, the configured development instance was updated and read back: audience claims enabled, PKCE S256 required, all nine Narriflow scopes advertised, and five read defaults alongside existing identity defaults. Six existing public Codex registrations now permit requesting the application scopes and require consent/PKCE; their existing built-in ceilings were preserved. DCR remains enabled. Public discovery returned HTTP 200 with all nine application scopes and S256. These facts do not prove issued-token grants or resource binding. [Configuration evidence](../../.scratch/mcp-production-readiness/clerk-configuration.md).

Clients must send RFC 8707 resource equal to the exact canonical `/mcp` URL. Clerk derives the audience from that parameter; Narriflow verifies it on every request. Read scopes are `projects:read`, `exports:read`, `usage:read`, `autopilot:read`, and `publishing:read`; processing, export, Autopilot and publishing writes require explicit grants. Verify fresh issued-token audience and consent without saving token bytes. New DCR registrations and actual Claude/ChatGPT ceilings remain part of the deferred walkthrough.

A generated continuation secret is configured in apps/web/.env.local without logging its value. Live inspection found it missing from Vercel's `narriflow-dev` project. The same secret was added as a sensitive Production environment variable (this development project deploys `dev` to its Production target). After deployment, the integration page changed from "Confirmation setup needed" to "Discovery verified" and the upload tool generated a signed handoff. Exact-post confirmation still requires a connected destination and its own walkthrough. Other stdio environments must use the same secret.

The newer [authentication verification](authentication.md) records that this development instance issues JWT access tokens and rejected immediate JWT revocation with HTTP 400. Online verification checks expiry and any verified revocation state, but does not make those JWTs immediately revocable. Immediate OAuth revocation is therefore an unresolved launch requirement: configure a revocable token contract or approve an explicit revocation design, then prove it with actual client credentials. API-key revocation remains checked against current database state on every request. The administrator changes in this effort preserved the existing token format.

The user authorized integrating existing authentication commits 710801f and c130550 into dev. The shared database's 97 applied migration checksums matched the reconciled repository; DIRECT_URL and DATABASE_URL identified the same database. Both additive MCP migrations were then applied once. Prisma reports all 99 migrations up to date. No migration was reset, reapplied, or marked resolved.

## Read-only live smoke check

The repaired `bun run test:mcp:e2e` uses an existing credential and a running endpoint. It performs public metadata discovery, challenges, complete tool-catalog comparison, workspace discovery and optional project reads through modern and older SDK clients. It does not create/revoke keys, select an arbitrary Business workspace, start Next.js or workers, submit media, export, or publish.

Set these environment values outside tracked files:

| Variable | Required value |
| --- | --- |
| `MCP_E2E_ALLOW_LIVE` | `1` to enable read-only network checks |
| `MCP_E2E_AUTH_MODE` | `oauth` or `api_key`, explicitly chosen |
| `MCP_E2E_TOKEN` | Existing scoped credential, supplied through the environment |
| `MCP_E2E_BASE_URL` | Canonical running Narriflow origin |
| `MCP_E2E_WORKSPACE_ID` | Optional eligible workspace for project reads |

For OAuth, use a fresh resource-bound token with the requested read grants. The smoke output records observed protocol versions and server capabilities, and explicitly leaves authorization-code consent and real-client delivery unverified. Temporary credentials and raw responses containing media grants must not be committed.

## Actual client walkthrough

Use an explicitly selected active Business workspace and test destinations. Apply pending migrations once to the shared development database before starting code that uses the new tables; verify both `DIRECT_URL` and `DATABASE_URL` first. Then complete each assistant's own login and consent flow. The installed CLI commands support `codex mcp add NAME --url URL --oauth-resource URL`, `codex mcp login NAME --scopes SCOPE,SCOPE`, `claude mcp add --transport http NAME URL`, and `claude mcp login NAME`. Record ChatGPT's actual setup and version when its connection is performed.

For Codex, Claude, and ChatGPT separately:

1. Discover `workspaceId`, verify read-only consent, and confirm an ungranted write fails with a scope challenge. Grant writes explicitly through that client's OAuth consent.
2. Submit a supported link with generation settings. Retry its unchanged key after a lost response, then verify changed settings under that key conflict. Follow its durable operation to completion.
3. Select a clip, inspect scores/timing and an optional excerpt, review the linked editor revision, and request the selected export format. Verify a new request with a stale revision is rejected.
4. Inspect a connected destination and provider settings. Prepare the exact post, then test decline, expiry and changed intent. Approve the selected revision/export/account/caption/settings/time and schedule it. Verify the review gate still applies and unchanged scheduling replay returns the accepted post.
5. When Apps or Tasks are negotiated, record the actual upload/review/confirmation bridge and task ownership/reconnect/terminal/cancellation behavior. Use web handoff, ordinary durable IDs and status tools when extensions are absent.
6. Revoke the credential and verify the next request fails. Remove membership, change role, restrict the workspace and downgrade in controlled fixtures, checking the next request each time.

Also perform an API-key upload-helper walkthrough with a user-selected local file: direct transfer to storage, interruption/resume, exact-object verification and one ingest handoff. Record the command/version and durable identifiers; exclude upload grants and tokens. The existing local-helper tests exercise transfer behavior but do not prove a live storage or host-attachment contract. Enable attachment adapters only after their specific host file contract passes an actual walkthrough.

## Codex desktop live acceptance

The user connected Narriflow in Codex desktop and selected project `0b076c05-52b5-4dfd-a1fc-764d3173124c` in workspace `cdda3632-7e10-4704-819b-3dfe7d84b850`. Actual connected tools, rather than a separate API-key client, returned these results:

- Workspace discovery returned the explicit workspaceId, owner role, active Business access, and MCP eligibility.
- Project status reported the 647-second video ready with ten clips. Clip reads returned revision, scores, timing, and ordinary Studio links. Transcript excerpts were absent by default; opting in returned a 343-character excerpt.
- Two consecutive three-item pages returned distinct clips and a continuation cursor. Project discovery and usage also succeeded (11 of 1,800 minutes).
- Requests using a workspace the caller does not belong to returned `workspace_access_denied` without project data.
- Social account/publication and Autopilot discovery succeeded with empty lists. No destination was connected and no real publication was scheduled.
- Creating a 1080p 9:16 export of clip `a0e2c2c3-a7a1-45ae-b569-33f1eb984b9b` at revision 0 failed twice with `mcp_mutations_unavailable`, using the same idempotency key. No export was accepted by those requests.

The limiter failure reproduced against healthy shared Upstash: an explicit connection returned PONG while the limiter returned unavailable. With offline queuing disabled, the limiter issued INCR before its lazy connection was ready, then disconnected that client. The fix awaits one shared connection promise before issuing commands. A real-ioredis TCP regression first failed, then passed: four concurrent cold-start requests all observe available Redis and only two are admitted under a limit of two. The shared Redis probe also reports available after the fix. Outage admission policy is unchanged.

Verification after this fix: repository lint, typecheck, tests, and build passed; MCP integration passed 146 tests / 697 assertions; limiter tests passed five tests. No schema or domain lifecycle changed.

Commit `0d36b72de969dc203f1c1d7dbf9eea79b2c4991e` was pushed to dev and Vercel deployment `dpl_7M1ygWq84kKEqua4FydwJGgW4kHs` reached READY with the canonical alias assigned. The subsequent actual Codex tool calls verified:

- Retrying the original unchanged export request accepted export `5cba21d7-b9a1-4546-ba05-44bbeb82a1b2`, initially queued. The status tool observed it ready at 100%, with a completed 1080p 9:16 asset lasting 19.043 seconds. The worker completed it in about 22 seconds.
- An unchanged replay returned the same export and variant identifiers and the original immutable acceptance outcome. A changed aspect ratio under that key returned `mcp_idempotency_conflict`.
- A fresh request with expected revision 1 while the clip remained revision 0 returned `editor_revision_conflict` and currentRevision 0. This proves mismatched-revision admission; a genuinely stale prior revision remains covered by deterministic/database tests rather than this unchanged v0 live fixture.
- The upload tool returned `awaiting_file`, the correct workspace, a ten-minute expiry, and a Narriflow handoff URL. No file bytes were supplied or ingest work started by this check.
- Chrome opened the ordinary [export delivery page](https://narriflow-dev.vercel.app/projects/0b076c05-52b5-4dfd-a1fc-764d3173124c/clips/a0e2c2c3-a7a1-45ae-b569-33f1eb984b9b/exports/5cba21d7-b9a1-4546-ba05-44bbeb82a1b2), displaying Ready, version 0, 1080p, and a 4.4 MB download. Actual video playback reached its 19.043-second end, with a played range, readyState 4, and no media error. Screenshots were saved locally without tokens or temporary media URLs in this document.

The user asked to ignore the existing YouTube import problem; no new import or generation was attempted. Claude, ChatGPT, API-key media upload, actual extension visuals/negotiation, controlled role/plan/revocation checks, and exact-post confirmation remain unverified. The ordinary Narriflow export page is visually verified; an embedded Codex App card has not been observed. Successful OAuth-authenticated reads and mutations prove this connected token passes server audience and the exercised read/processing/export scope admission; they do not establish all fresh-consent or revocation gates.

## Codex card failure follow-up

The user supplied screenshots of upload and clip-review cards failing with "Couldn't display Narriflow 2". The attached tool trace showed a successful upload outcome and App metadata; it did not show a domain failure. Connected `resources/read` calls for both card resources failed with -32602 "MCP Apps capability is required". A deterministic SDK legacy client reproduced the same error, despite advertising Apps in its initialize request. Previous App tests only exercised modern requests.

The [SDK legacy serving contract](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md) creates a fresh server instance per request; older clients do not repeat the capability envelope. Requiring that lost initialize state at resource fetch and App-only calls rejected legitimate hosts. Static HTML templates now support ordinary resource prefetch/inspection. The SDK serving era is propagated to App calls and private preview delivery. Modern calls still require an Apps declaration; legacy hosts negotiate the standard bridge and enforce tool visibility. Scope, current credential, workspace/role/Business, ownership, confirmation, and limiter/domain checks are unchanged. This follows the [MCP Apps host visibility and bridge contract](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

The resource CSP also allowed the R2 account origin but omitted the bucket origin used by signed upload and preview URLs. It now permits both exact origins, without a wildcard. No App HTML or bundled JavaScript changed.

Regression commands: `bun test packages/mcp-core/src/mcp-apps.test.ts` first failed on legacy resource and bridge calls, then passed seven tests. The bucket-origin regression also failed before its fix. Private preview delivery is checked in the workflow suite, and HTTP wire tests verify SDK era propagation. `bun run test:mcp:integration` passes 151 tests / 723 assertions. Repository lint, typecheck, tests and build pass. No schema or domain lifecycle changed.

Commit `93d47b591292e08a858419fc8d0c50aaf0ef514f` was pushed to dev. Vercel deployment `dpl_BGmykqN8o1xCxD3weYuPd3rPS4nZ` reached READY with the canonical alias assigned. Through the same connected Codex MCP server, both previously failing `resources/read` calls now return HTML with `text/html;profile=mcp-app`, the App bridge, and the exact R2 bucket origin in connect/resource CSP. A fresh read of clip `a0e2c2c3-a7a1-45ae-b569-33f1eb984b9b` succeeded with a preview available, and a fresh upload handoff returned `awaiting_file` with a ten-minute expiry. No file was transferred. Actual card rendering is still awaiting observation of a fresh or retried card in Codex.
