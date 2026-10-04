# 04 - Apps and upload delivery

**What to build:** Versioned standard bridge Apps, authenticated Upload Session integration adapter, resumable direct-storage CLI, verified integration UI.

**Blocked by:** [01 - Authentication](01-authentication.md), [03 - Tool workflow](03-tool-workflow.md).

**Status:** done

**Owner:** Apps implementer

- [x] Picker/handoff/CLI use existing upload adapter and keep grants outside model results.
- [x] Static Apps, CSP, capability negotiation and configuration UI verified.
- [x] Deterministic upload acceptance verifies resumability, credential isolation and exact handoff; live API-key acceptance is tracked in ticket 06.

## Comments

Independent UI/CLI implementation proceeds against existing Upload Sessions while auth/contracts are integrated.

Implemented on `dev` on 2026-10-05. The authenticated integration route reuses `createUploadSessionHttpRoutes`; the signed web handoff reuses `createUploadSessionBrowserAdapter`. Existing Upload Session grants, multipart inventory, exact-object verification and ingest handoff remain authoritative. New opens pause during limiter outages; accepted transfers and replays continue. Browser continuations verify signed actor, workspace, key and generation settings, and honor current API-key revocation and scopes.

The local helper accepts file, workspace, replay key and optional generation settings. Credentials come from environment variables. It uploads directly to storage, hashes the file identity, skips server-verified multipart parts, and records the replay key before networking. Storage requests contain no Narriflow bearer credential.

Four versioned Apps use the standard bridge. Their resources contain no private results and declare exact application and R2 domains. Static templates remain readable for host prefetch and inspection. Modern bridge calls require the per-request Apps capability; older hosts negotiate the bridge and enforce App-only visibility, while server-side scopes and domain admission remain authoritative. The browser bridge is compiled into a generated TypeScript string module using `bun run --cwd packages/mcp-core build:apps`, so Next and stdio do not need runtime filesystem paths. Transfer grants and preview URLs stay in `_meta`. The confirmation card and authenticated web form schedule only the signed exact publication intent. The web form includes the destination account's current name and handle. The integration page verifies issuer discovery, PKCE and application scopes rather than claiming the endpoint is ready.

Follow-up verification: the seven focused suites (`authenticated-request-inventory`, `mcp-configuration`, `mcp-upload-http`, `mcp-upload-handoff`, local `upload`, `mcp-apps`, and `mcp-apps-upload`) passed 33 tests and 737 assertions. Checks cover interrupted multipart resume, credential isolation, every transfer action's request budget, typed scope challenges, limiter outage admission and replay, expired handoffs continuing only accepted sessions, bounded App reconciliation polling, exactly five App transfer tools, App capability enforcement, CSP, private grant separation, missing OAuth scopes and discovery failure. Biome passed for 19 affected authored files and web typecheck passed. The root verification records the final repository-wide build and typechecks.

The confirmation action and both signed handoff pages use the repository's authenticated-request adapters and inventory. API keys default to all five read scopes through the shared validator constant; processing, exports, autopilot and publishing writes remain explicit grants.

No live uploads, ingest jobs or shared-database writes were performed. Actual API-key storage acceptance and client OAuth walkthroughs remain release gates in ticket 06.

Final spec-review fixes add exact export status polling, safe accepted-upload bridge context, terminal confirmation decisions, uncertain lost-response recovery, and expiry validation at domain acceptance. The nine owned suites now pass 41 tests with 769 assertions. Web and MCP-core typechecks, final authored-file Biome checks, and `build:apps` pass. Root owns the repository build against the regenerated bundle. Findings and external gates are recorded in [the spec review](../review-spec.md).

The user explicitly deferred live client/media acceptance until later. Ticket 06 keeps that launch gate open; this implementation ticket is complete. Root applied shared migrations and configured Clerk separately after explicit authorization.

October 5 live follow-up: the user supplied Codex cards displaying "Couldn't display Narriflow 2" despite successful tool results. Both connected `resources/read` probes failed with -32602 "MCP Apps capability is required". The same failure reproduced using the SDK's legacy stateless client, which sends capabilities during initialization but does not repeat them on each request. The fresh factory therefore cannot recover them for later resource/bridge calls. Static-template reads no longer depend on that lost state, and the SDK's serving era is passed through HTTP/stdio to the App policy and private preview delivery. Modern capability rejection remains covered. The card CSP also now includes the exact bucket hostname used by signed R2 uploads/media, alongside the account hostname. Regressions first failed, then passed for legacy resource fetch, transfer/confirmation calls, and bucket CSP; a preview test verifies private metadata stays outside model content. The full MCP integration gate now passes 151 tests / 723 assertions. After deployment of `93d47b5`, both connected resource probes passed and the user confirmed the fresh cards display in Codex. In-card playback, live file transfer and the remaining clients stay open in ticket 06.
