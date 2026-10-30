# Codex Narriflow MCP acceptance test

Date: 2026-10-30. Live export accepted at 09:54:07.928 UTC and completed at 09:54:21.999 UTC.

## Result

PASS for the exercised OAuth session, read tools, real export, idempotent replay, file/subtitle delivery, upload handoff origin, and typed domain error. No connector failures observed. Full upload byte transfer was not exercised because the available upload tool requires an assistant picker or browser continuation.

All Narriflow requests used the actual connected `mcp__narriflow__*` tools in this Codex session. No curl, replacement HTTP client, separate bearer token, CLI media helper, browser, or social publishing was used. Shell commands only read local context and configuration; this report is the only file written.

## Connection and audience

- Local `mcp_servers.narriflow` is enabled with URL `https://narriflowapi-dev.up.railway.app/mcp`.
- Required canonical OAuth resource/audience: `https://narriflowapi-dev.up.railway.app/mcp`, including the exact `/mcp` path.
- WEB origin: `https://narriflow-dev.vercel.app`.
- Discovery exposed 35 model-callable Narriflow tools, listed below. Tool inventory came from the actual runtime catalog.
- Authenticated workspace discovery, scoped reads, export mutation and upload-handoff creation succeeded. No auth/consent error occurred.
- These successes are evidence that the connected OAuth session passes current server admission. Local source derives the resource from `API_ORIGIN + /mcp` in `apps/api/src/domains/integrations/mcp-auth.ts`, and requires verified `aud` to include that exact URL in `packages/mcp-core/src/mcp-auth.ts`. Raw token claims and the negotiated protocol/Apps/Tasks capabilities were not exposed by these tools, so they were not independently inspected. No credentials or signed grants are saved here.
- Workspace: `eac6cb57-a82e-4195-a8fc-7188d6bb45a5`, Murtaza Asghar's workspace, owner, active, Business, MCP enabled.
- Project: `53b0d959-968b-49da-aa75-2bb62a17fe23`, "Macbook PROLED XDR Impressions: They Said They Wouldn't!".
- Reviewed clip: `c133d640-ac33-435e-b3f5-df5b0c322f28`, "Touchscreens Don't Work Vertically", editor revision 4.

## Per-tool results and discovery inventory

Latency is client-observed wall time in milliseconds around the awaited MCP call, including connector/network overhead. Independent reads were batched, so these are observations rather than isolated benchmarks. PASS on negative checks means the expected rejection occurred. NOT TESTED means discovered but not invoked.

| Tool | Result | Latency ms | Evidence |
| --- | --- | --- | --- |
| `narriflow_confirm_social_publication` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_create_captioned_video` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_create_clip_export` | PASS | 1315; 572; 579; 406 | New 720p 9:16 revision-4 export accepted; unchanged replay identical; changed input under same key cleanly conflicts. Initial non-UUID key rejected. |
| `narriflow_create_review_handoff` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_create_rss_autopilot_rule` | NOT TESTED | n/a | Avoided recurring processing. |
| `narriflow_generate_clips` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_get_clip` | PASS | 640; 605 | Revision 4, timing, scores and Studio URL returned. Wrong project returned typed clip_not_found. |
| `narriflow_get_clip_export` | PASS | 882 | Ready at 100%; variant completed with asset; duration 31.965267 s. |
| `narriflow_get_clip_timeline` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_get_export_download` | PASS | 667 | Video grant, 4,938,570 bytes; SRT 1,493 characters and VTT 1,417 characters. Grant validity 15 minutes. |
| `narriflow_get_operation` | PASS | 563; 755 | Observed working/rendering at 0.05, then completed at 1, no notices or failureCode. |
| `narriflow_get_project` | PASS | 1262; 586; 463 | Selected project ready at 100%, duration 654 s. Unknown valid UUID returned null project/progress. Malformed ID rejected. |
| `narriflow_get_publishing_options` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_get_review_round` | NOT TESTED | n/a | No review round available. |
| `narriflow_get_social_publication` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_get_workspace_usage` | PASS | 741; 881 | 104 used, 0 reserved, 1,696 remaining of 1,800 before and after export; 0/20 in flight; 10,800 s per-video limit; renews 2026-11-01 UTC. |
| `narriflow_list_autopilot_rules` | PASS | 1251 | Empty rules list. |
| `narriflow_list_brand_profiles` | PASS | 1132 | Empty profiles list. |
| `narriflow_list_clips` | PASS | 1288; 590; 548 | Two distinct 3-item pages, valid continuation cursors; no transcript excerpts by default. Unknown valid project UUID returned empty list. |
| `narriflow_list_events` | PASS | 544 | Three recent operation.finished events; nextCursor 17. |
| `narriflow_list_projects` | PASS | 1261 | Four ready projects; selected project has 10 clips. |
| `narriflow_list_recipes` | PASS | 1269 | Empty recipes list. |
| `narriflow_list_review_rounds` | PASS | 601 | Empty review rounds list. |
| `narriflow_list_social_accounts` | PASS | 1302 | Empty accounts list; UTC workspace timezone. |
| `narriflow_list_social_publications` | PASS | 617; 841 | Empty project publication page. Initial caller omission of required projectId cleanly rejected. |
| `narriflow_list_workspaces` | PASS | 532 | Owner, active Business, MCP enabled. |
| `narriflow_prepare_social_post` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_propose_social_post` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_publish_social_publication_again` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_recheck_social_publication` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_run_autopilot_rule_now` | NOT TESTED | n/a | Avoided recurring processing. |
| `narriflow_schedule_social_post` | NOT TESTED | n/a | No destination/publication available, or publishing mutation excluded by task. |
| `narriflow_search_library` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_submit_video` | NOT TESTED | n/a | Outside the selected low-cost acceptance path. |
| `narriflow_upload_video` | PASS | 471 | awaiting_file; correct WEB handoff host; ten-minute continuation. Direct transfer not exposed to this model. |

## Low-cost write and operation evidence

One new render was requested, using one 720p 9:16 variant of an existing approximately 32-second clip.

- Idempotency key: `63f248a2-c195-4d84-9569-f03728100ec4`.
- Operation reference: `{"kind":"export","id":"1923735f-bee5-4e74-af2c-f2b45b160250"}`.
- Export ID: `1923735f-bee5-4e74-af2c-f2b45b160250`.
- Variant ID: `fc80c2fa-4ab7-45c1-af94-c7a2b02cf40c`.
- Acceptance returned queued, progress 0, `reused:false`, editorRevision/currentEditorRevision 4, no watermark.
- Exact unchanged replay returned byte-identical JSON serialization of structuredContent, including the same operation, export and variant IDs. The replay retains the accepted snapshot, including `reused:false` and queued; current status was checked separately.
- First status read returned working/rendering, progress 0.05, variant working.
- Next status read returned completed, progress 1, variant completed, `failureCode:null`, `notices:[]`.
- Export status separately returned ready at 100%, hasAsset true, duration 31.965267 s.
- Server timestamps show completion after 14.071 seconds.
- File tool returned `Touchscreens-Don-t-Work-Vertically-9x16-720p-v4.mp4`, 4,938,570 bytes, signed download grant expiring at 2026-10-30T10:09:55.905Z. URL intentionally omitted.
- SRT starts with sequence 1 and a timestamp cue; VTT starts with WEBVTT and timestamp cues. Contents were returned inline. Video bytes were not downloaded or visually inspected.
- Credits remained 104 used, 0 reserved and 1,696 remaining. External infrastructure cost was not measured.
- Review page: https://narriflow-dev.vercel.app/projects/53b0d959-968b-49da-aa75-2bb62a17fe23/clips/c133d640-ac33-435e-b3f5-df5b0c322f28/exports/1923735f-bee5-4e74-af2c-f2b45b160250

## Upload flow

`narriflow_upload_video` succeeded in 471 ms with `status:"awaiting_file"`, the selected workspace, and continuation expiry `2026-10-30T10:04:35.072Z`.

- Upload idempotency key: `725811f0-c54d-4ee9-ae37-c2836e97f1ef`.
- Returned handoff host: `narriflow-dev.vercel.app`.
- Returned handoff origin/path: `https://narriflow-dev.vercel.app/integrations/mcp/upload`. Signed query omitted.
- The tool offers `bun run mcp:upload --file <path> --workspace <workspaceId> --key <clientIdempotencyKey>` as a separate local-helper route.
- No model-callable open/grants/finalize tools are present in this session's actual catalog. Source registers `narriflow_upload_open`, `narriflow_upload_status`, `narriflow_upload_grants`, `narriflow_upload_finalize`, and `narriflow_upload_discard` as app-only tools. They were not invoked or bypassed.
- Per the requested conditional scope, no tiny file was generated or transferred. No Upload Session/intake operation ID was created or returned by this handoff.

## Exact negative-test responses

Malformed project ID `not-a-project-id`, `narriflow_get_project`, 463 ms, `isError:true`:

```text
Input validation error: Invalid arguments for tool narriflow_get_project: projectId: Invalid UUID
```

Unknown valid project UUID `00000000-0000-4000-8000-000000000000`:

- `narriflow_get_project`, 586 ms: `{"project":null,"progress":null}`, ordinary success.
- `narriflow_list_clips`, 548 ms: `{"items":[],"nextCursor":null}`, ordinary success.
- `narriflow_get_clip` with that project and the real selected clip ID, 605 ms, `isError:true`:

```json
{"error":"clip_not_found","kind":"missing","message":"Clip not found","retryGuidance":"refresh_resource"}
```

These null/empty responses do not themselves supply a typed missing-project error. The get-clip call supplies the clean typed domain error. None of these calls produced an internal-error/500 response; the MCP wrapper does not expose raw HTTP status.

Changed aspect ratio to 1:1 under the already accepted export key, 579 ms, `isError:true`:

```json
{"error":"operation_idempotency_conflict","kind":"conflict","message":"This request key was already accepted with different input. Use a new key for a new request.","retryGuidance":"refresh_state"}
```

Two initial caller input mistakes were corrected and are not connector failures:

- `narriflow_list_social_publications` initially omitted required projectId, 841 ms:
```text
Input validation error: Invalid arguments for tool narriflow_list_social_publications: projectId: Invalid input: expected string, received undefined
```
- `narriflow_create_clip_export` initially used non-UUID key `codex-mcp-test-20261030-export-1793354038050`, 406 ms:
```text
Input validation error: Invalid arguments for tool narriflow_create_clip_export: clientIdempotencyKey: Invalid UUID
```

One local result-sanitizing attempt after the first upload call threw `ReferenceError: URL is not defined` in the orchestration JS runtime, after 1,177 ms. This was not a Narriflow response. Retrying the same upload input and key with corrected sanitization yielded the successful 471 ms handoff above. No signed continuation was retained.

## Limits and side effects

No social destination is connected; publishing options and individual publication reads could not be exercised against real data. No social write, new video ingest, generation, recurring rule, revocation, membership change, or plan change was attempted. Tasks-specific APIs were not available in the model tool catalog; durable operation status was used.

The created export remains in the test workspace for review. Source code and pre-existing working-tree changes were left untouched. Context read included `packages/mcp-core/src/index.ts`, auth and Apps definitions, shared MCP validators, and `docs/runbooks/mcp-launch-acceptance.md`.

