# Launch the Narriflow assistant connector

**Status:** claimed

**Map:** the retired External integrations map, sequence steps 3 to 7; open items now live in the [automation map](../automation/map.md).

**Blocked by:** Processing Usage, for directory submission only; shipped ([ADR 0012](../../docs/adr/0012-processing-usage.md)). Implementation tickets in this spec can start immediately.

**Builds on:** [MCP production readiness](../mcp-production-readiness/spec.md). That effort's acceptance ticket stays open until this spec's live acceptance passes.

## Problem Statement

Narriflow's remote MCP server lets assistants such as Codex, Claude, and ChatGPT read projects, submit videos, generate clips, export, and prepare social posts. It has OAuth through Clerk, workspace API keys, idempotent receipts, Apps cards, and Tasks. Live testing has covered Codex only. The connector still can't deliver the promise a listing would make: an original recording becomes branded clips that a client approves and the assistant can hand back as files.

The gaps are concrete:

- **No file delivery.** `narriflow_get_clip_export` signs download URLs in memory and then discards them in `mcpExport`. The only "download link" is a web page that needs a signed-in Narriflow session. No tool returns a file an assistant or automation can fetch.
- **No brand choice.** Generation settings accept a caption preset but no Brand Profile. The upload route rejects `brandProfileId` outright. Assistant callers always get the Workspace default.
- **Subtitles only for whole projects.** SRT and VTT exist for the whole project transcript, not for a clip export. Assistants and editors can't get subtitles that match a clip.
- **Wrong aspect ratio in caption-only mode.** Caption-only generation ignores the requested aspect ratio and auto-renders 16:9 (`detect-clips.ts` passes `"16:9"` instead of `contentPack.defaultAspectRatio`). This is a product defect for web users too.
- **Status can describe the wrong work.** `narriflow_get_project` is the status tool for every operation. It reports the Project's active or latest Workflow Run. A web regeneration or an Autopilot run can therefore stand in for the work the assistant started. Lineage-correct status exists only for clients that negotiate MCP Tasks.
- **Silent output changes.** Export silently replaces 1080p with 720p, and adds a watermark, on plans without those features. A caller can't tell what it actually received.
- **No review handoff.** Review Rounds exist but nothing in MCP reaches them. An assistant can't hand exports to a client or learn whether the client approved.
- **Revocation and continuation gaps.** Clerk issues JWT OAuth access tokens and refused immediate revocation, so a user who disconnects an assistant can't stop it at once. Signed continuations rebuild OAuth principals with synthetic `processing:write` and `publishing:write` scopes and never recheck the originating grant.
- **Stale ADR addendum.** ADR 0009's 2026-10-04 addendum says application scopes apply only to API keys. The code checks application scopes for OAuth principals too.
- **No listing package.** There is no public connector page, no listing copy or screenshots, no reviewer account, and no recorded Claude or ChatGPT walkthrough. Competitors such as OpusClip (29 tools, with downloads and editing) and Descript are already listed in Claude's directory.

## Solution

Close the gaps, prove one complete journey on real assistant clients, and submit to Claude's directory. Prepare the ChatGPT submission separately. New capabilities are transport-neutral service functions that MCP adapts today and the public REST API reuses later.

1. **Revocable credentials.** Switch the Clerk OAuth application to opaque access tokens. Prove that verification still returns the `/mcp` audience and that revocation takes effect on the next request. Signed continuations carry the originating principal's granted scopes, and admission requires the needed scope from that signed set.
2. **Operation Status.** One services module derives the state of an accepted mutation from its lineage. It reuses the logic MCP Tasks already use. An intake operation continues from its Ingest Job into the generation lineage it handed off. A new `narriflow_get_operation` tool and MCP Tasks both read it. Mutation results point to it instead of `narriflow_get_project`.
3. **Download Grants.** A new read tool, `narriflow_get_export_download`, returns short-lived download URLs for a completed export's video files and subtitle files. List and get results stay free of bearer URLs.
4. **Subtitles.** SRT and VTT text is generated on demand from an export's frozen snapshot, using the same cue derivation as burned-in captions. No extra files are stored.
5. **Explicit output.** Export results report requested and granted resolution and watermark, with a reason when they differ.
6. **Brand selection.** Generation accepts an optional Brand Profile, validated for the actor. A new read tool lists the Workspace's Brand Profiles.
7. **Caption-only fix.** Caption-only generation honors the requested aspect ratio.
8. **Review handoff.** A tool returns a Narriflow link that opens the existing Review Round composer with the chosen exports selected. A signed-in member sends the round. Read tools report rounds and per-item decisions. Approval stays a human action in Narriflow.
9. **Launch package.** A public connector page, listing assets, a reviewer account, and live acceptance in Claude, ChatGPT, and Codex, followed by the Claude directory submission.

## User Stories

1. As an assistant user, I want disconnecting Narriflow from my assistant to stop its access on the next request, so that I stay in control of my workspaces.
2. As an assistant user, I want a confirmation link prepared by my assistant to stop working when my assistant never had permission for that action, so that a link can't grant more than the connection did.
3. As an assistant user, I want my assistant to see which workspaces I belong to and act only in the one it names, so that work never lands in the wrong client's workspace.
4. As an assistant user, I want to pick a Brand Profile when I submit a video, so that clips match the client's look without opening Narriflow.
5. As an assistant user, I want my assistant to list my Brand Profiles by name, so that I can say "use the Acme brand."
6. As an assistant user, I want to keep choosing caption presets, clip count, length, aspect ratio, and language, so that I keep the control I have today.
7. As an assistant user, I want caption-only processing to produce my requested aspect ratio, so that a vertical request gives a vertical video.
8. As a web user, I want the same caption-only fix in the web app, so that the defect disappears everywhere.
9. As an assistant user, I want one operation ID that reports progress from submission to finished clips, so that I don't need to know when ingest hands off to generation.
10. As an assistant user, I want status to describe only the work I started, so that someone else's regeneration can't look like my result.
11. As an assistant user, I want status to say how many clips succeeded and which failed, so that partial results are clear.
12. As an assistant user, I want a downloadable file link for a finished export, so that my assistant can give me the MP4 or pass it to another tool.
13. As an assistant user, I want the link to say when it expires and to be refreshable, so that an expired link isn't a dead end.
14. As an assistant user, I want SRT and VTT files that match the exported clip, so that I can upload native captions or hand them to an editor.
15. As an assistant user, I want subtitles even when captions aren't burned into the video, so that I can use platform captions instead.
16. As an assistant user, I want the export to say if I received 720p or a watermark instead of what I asked for, and why, so that output never changes silently.
17. As an assistant user, I want my assistant to give me a link that opens Narriflow's client review with the chosen exports already selected, so that sending to a client takes one step.
18. As an agency operator, I want to send the review round myself in Narriflow, so that no assistant emails my client without my approval.
19. As an assistant user, I want my assistant to check whether the client approved or requested changes, so that it can fetch approved files or summarize the feedback.
20. As an assistant user, I want existing tools to keep working when new tools appear, so that the connector doesn't break my setup.
21. As a prospective user, I want a public page that explains what the connector does, how to connect it, what data it reads, and how to disconnect, so that I can trust it before connecting.
22. As a directory reviewer, I want a ready reviewer account with sample content and password sign-in, so that I can test every tool without email codes.
23. As a directory reviewer, I want accurate tool annotations, so that I can see which tools read, which write, and which reach outside Narriflow.
24. As a ChatGPT user, I want access errors to explain the situation without sales prompts or checkout links, so that the plugin follows ChatGPT's rules.
25. As the owner, I want a recorded walkthrough of the full journey on Claude, ChatGPT, and Codex, so that the listing promises only what works.
26. As an operator, I want download grant issuance logged without the URL, so that delivery can be audited without leaking bearer links.

## Implementation Decisions

### Credentials

- An administrator switches the Clerk OAuth application's access-token format to opaque in the Clerk dashboard. That changes shared configuration, so it needs explicit owner authorization at the time. The verifier in `packages/mcp-core/src/mcp-auth.ts` already calls Clerk's online verification endpoint and needs no format-specific code.
- The first acceptance step obtains a fresh opaque token through a real client and records whether the verification response includes `aud` with the canonical `/mcp` URL. If it doesn't, stop and report. Do not weaken the audience check. The options are then a Clerk configuration fix or a reviewed design change.
- Prove revocation by revoking a live connection and observing `invalid_token` on the next tool call. Record the result in `docs/runbooks/mcp-launch-acceptance.md`.
- Signed continuation state (`mcp-confirmation.ts`, publication and upload handoff) gains the originating principal kind and its granted scopes. `continuationPrincipal` stops synthesizing scopes. Admission requires the needed scope from the signed set for both principal kinds. API-key continuations keep their live key recheck.
- OAuth continuations expire at the earlier of ten minutes and the originating token's expiration, which the verifier already reads (`mcp-auth.ts`). If Clerk offers a per-user lookup of a client's active authorization, admission also rechecks it. Record the investigation result in the runbook either way.
- Separate the upload handoff from browser recovery:
  - The signed upload handoff authorizes only the initial `open`, within its expiry and with `processing:write` in its signed scopes.
  - After open, `status`, `grants`, `finalize`, and `discard` for that Upload Session run under the signed-in actor's own authority over the session. They recheck current membership, `processing.consume`, and Business access. They never reconstruct the assistant's principal.
  - Remove the expiry bypass from `requireMcpUploadHandoffAdmission` and `allowAcceptedTransfer` from continuation admission. A person can always finish their own open upload. An expired or revoked assistant credential can't start one.
- Workspace scope for OAuth stays as implemented. A connection acts for the user in any Workspace where the user's current role allows the tool, each mutation names its Workspace explicitly, and Business access is checked per Workspace. The public connector page and consent copy state this. Changing to per-Workspace consent is a separate decision listed in the map's Fog section.
- Amend ADR 0009 with a dated addendum. OAuth principals carry the application scopes granted at consent, and admission checks them exactly as for API keys. This supersedes the 2026-10-04 sentence that limits application scopes to API keys.

### Operation Status

- Add **Operation Status** to `GLOSSARY.md`. It is the transport-neutral, lineage-derived state of one accepted mutation, such as an intake, generation, or export. It reports `working`, `completed`, `partial`, `failed`, or `cancelled`, with per-item outcomes and result references. Avoid "task state," "project status," and "job status."
- Create `packages/services/src/operation-status.ts`. Generalize `getMcpTaskDomainState` (`mcp-task-runtime.ts`) and `generationTaskState` (`mcp-generation-task.ts`) into it. MCP Tasks call the module rather than owning the logic. The input is `{ workspaceId, actor, kind, id }`. Access uses `accessibleProjectWhere()`.
- Kinds are `intake`, `generation`, and `export`:
  - `intake` covers an upload or link intake. For uploads it starts at the Upload Session, so finalization, reconciliation, and permanent pre-handoff failure are reported. It then follows the Ingest Job and the generation lineage the Ingest Job handed off.
  - `generation` covers the originating run, its detection run, and its frozen render IDs.
  - `export` covers a Clip Export and its variants.
- `narriflow_upload_video` finalize returns the Upload Session as its intake operation.
- Intake lineage must be stored, not inferred. Today handoff acknowledgment records only timestamps (`ingest-job-lifecycle.ts`), and `acknowledgeExistingGeneration` finds the existing `stt` run and discards its ID. Add a nullable `generationRunId` to Ingest Job. Write it atomically in both handoff paths: the run created by `admitWithHandoff`, or the existing run found by acknowledgment. Intake status follows that run's lineage. It never looks up "the Project's latest run."
- The module offers two reads. The actor read applies Project access and conceals inaccessible work. The trusted worker read, used only by the REST callback loop, reports `unavailable` when the Project or its lineage was deleted, expired, or purged. The result carries the state, a progress fraction, per-clip or per-variant outcomes, the Project, clip, and export IDs produced, and a typed failure code. It never carries media URLs.
- Mutation results from `narriflow_submit_video`, `narriflow_upload_video` finalize, `narriflow_generate_clips`, and `narriflow_create_clip_export` return `operation: { kind, id }` and `statusTool: "narriflow_get_operation"`. `narriflow_get_project` stays a Project snapshot.
- The new tool `narriflow_get_operation` needs `projects:read` for intake and generation, `exports:read` for export, and `content.view` capability. It is annotated read-only.

### Download Grants and subtitles

- Add **Download Grant** to `GLOSSARY.md`. It is one short-lived, private URL issued on explicit request for one finished export file or subtitle file. Avoid "download link" for the web review page.
- `narriflow_get_export_download` takes `workspaceId`, `exportId`, and an optional `variantId`. It needs `exports:read` and `content.download`. For each completed variant it returns the variant ID, aspect ratio, granted resolution, file name, size, `downloadUrl`, and `expiresAt`. It also returns `subtitles: [{ format, fileName, content }]`, with SRT and VTT text inline (clips are at most a few minutes long, so the text is small). The TTL is the existing 15 minutes. Calling again issues fresh grants.
- Update the `mcp-production-readiness` contract sentence to say: public results contain no temporary media URLs, except the result of the dedicated download tool. List, get, and export tools remain URL-free. Diagnostics never log URLs.
- The transport-neutral service function lives beside `clipExportService` (`toExportSnapshot(row, includeDownloadUrls)` already signs). It records a structured log with export, variant, actor, credential kind, and expiry, but never the URL.
- Subtitles are generated on demand from the export's frozen snapshot, which already holds timed transcript and edit data (`clip-export.service.ts`). Nothing is stored, so there is no readiness state, retry path, or cleanup inventory. One pure function in `packages/composition-plan` derives cues exactly as burn-in does: `preset.wordsPerCue` grouping, edited-time mapping across cuts and inserted scenes, and censor masks (`clip-composition-plan.ts` caption cue derivation). A thin formatter renders SRT and VTT. When the revision has captions turned off, the same derivation runs while ignoring visibility. If the frozen snapshot lacks the word timing needed, stop and report rather than reading a newer revision.
- The web export page offers the same SRT and VTT downloads through an authenticated route that calls the same function.
- Update AGENTS.md: its cue-model line still names `CAPTION_CHUNK_SIZE`, which exists only there. Point it at the composition plan's cue derivation and `CAPTION_POSITION_Y_DEFAULTS`.
- Export input has no watermark choice, so results gain `requested: { resolution }` and `granted: { resolution, watermark }`, with `reason: "plan_limit"` when the granted resolution differs or a watermark is applied. The idempotency fingerprint uses the requested input, while the receipt records the granted output.

### Choice and generation

- `narriflow_submit_video` and `narriflow_upload_video` gain an optional `brandProfileId` beside `generation`. It is not added to the shared generation settings, because `narriflow_generate_clips` keeps the Project's brand. The intake services resolve it through `brandProfileService.resolveForProject` with the actor, as web intake does. An inaccessible or foreign profile returns `missing`. The upload route's rejection of `brandProfileId` is removed, and the handoff fingerprint includes it. `brandTemplateId` stays web-only.
- The new tool `narriflow_list_brand_profiles` needs `projects:read` and `content.view`. It returns ID, name, whether the profile is the default, and the profile's default caption preset. Caption preset IDs remain the validated enum in the tool schema.
- `detect-clips.ts` caption-only branch auto-renders with `contentPack.defaultAspectRatio`. A worker test asserts the requested ratio for caption-only and clip modes.

### Review handoff

- The new tool `narriflow_create_review_handoff` takes `workspaceId` and items of `{ exportId, variantIds }`. It needs `exports:read` and `content.view`. It applies the Review Round rules up front: every item belongs to one Project, there is at most one export per clip, and the exports are complete and current (`review.service.ts` round creation). It then returns a Narriflow URL that opens the existing composer (`review-panel.tsx`) with those items preselected. It creates no Review Round and sends nothing, so it is annotated read-only.
- The composer page accepts the preselection, rechecks access and revisions, and leaves title, recipients, passcode, expiry, and sending to the signed-in member.
- The new tools `narriflow_list_review_rounds` (filter by Project) and `narriflow_get_review_round` need `exports:read` and `content.view`. They return round ID, title, status, expiry, and per-item decisions and comment counts. They never return access tokens, passcodes, or reviewer emails.
- Review Rounds stay Business-only, matching MCP admission. No new scope is added.

### Launch package

- Add a public connector page under the marketing routes. It covers what the connector does, setup for Claude, ChatGPT, and Codex, the tool list in plain language, the data Narriflow reads and stores, how to disconnect, the privacy and terms links, and a support contact. The in-app integrations page links to it.
- Listing assets live under `docs/integrations/listing/`:
  - Name, short and long descriptions, an icon, and sample prompts.
  - For ChatGPT, at least five positive test cases. Each states the prompt, the expected tools, and the expected result, and they use media reviewers can access. Add three negative test cases, the demonstration video, and the verification materials that OpenAI's submission page requires at the time.
  - For Claude, three to five Apps card screenshots (upload, progress, clip review, publication confirmation, export download). They meet the dimension and cropping rules on Claude's submission page at the time.
  - Check both requirement pages again on the day of submission. Their rules change.
- The reviewer account is a dedicated Business Workspace with password sign-in and no email-code or device-trust challenge. It holds a seeded Project created from an uploaded file (not a YouTube link), a Brand Profile, generated clips, and one export. The plan is comped through Stripe, with no code path for free Business access. Credentials are handed over through the submission form, never committed.
- Access errors (`mcp_workspace_access_unavailable` and similar) use neutral copy that names the requirement without upgrade prompts or checkout links, as ChatGPT's plugin rules require.
- Tool annotations are reviewed against behavior. New tools are read-only, and write tools keep `openWorldHint` where they contact providers. Bump the server version from `0.3.0`.

### Acceptance and submission

- Live acceptance runs the full journey on Claude (web connector and Claude Code), ChatGPT (developer mode), and Codex desktop:
  1. Connect with scoped consent, then list workspaces.
  2. Upload an original file through the card or CLI, choosing a Brand Profile.
  3. Follow Operation Status to completion.
  4. Inspect clips and export one.
  5. Fetch Download Grants for video and subtitles.
  6. Create the review handoff, send and approve the round in Narriflow, then read the decision.
  7. Revoke the connection and observe denial.
- Beyond the journey, every public tool is called at least once on Claude. These gates inherited from `docs/runbooks/mcp-launch-acceptance.md` must pass before submission:
  - Exact-post confirmation, including decline, expiry, and changed intent.
  - Revocation.
  - Membership removal, role change, and downgrade.
  - "Unavailable" may be recorded only for a host capability a client doesn't support, such as Apps cards or Tasks in a given client. It is never recorded for a Narriflow security or confirmation gate.
- Record client versions, negotiated capabilities, and IDs in the runbook.
- Submitting to Claude's directory is an outward-facing action. The owner submits, or explicitly authorizes the submission at the time. ChatGPT submission materials are prepared in the same folder. Their submission waits for the Claude listing and the owner's go-ahead.
- Directory submission was blocked until Processing Usage shipped ([ADR 0012](../../docs/adr/0012-processing-usage.md)); it has.

## Testing Decisions

- The Operation Status module is the primary seam for status. Tests build lineages with the disposable PostgreSQL pattern and assert derived state. Cases:
  - An intake with no handoff, then after handoff.
  - Generation with detection and frozen renders, plus a later unrelated regeneration that must not leak in.
  - Partial render failure, cancellation, an export with mixed variants, and a missing artifact.
- Existing MCP Task tests are retargeted at the module rather than duplicated.
- MCP tool contract tests cover every new tool's input and output schema, scope, capability, Business admission, Workspace isolation, and annotations. The existing exhaustive capability-parity test includes the new tools.
- Download Grant tests prove grants only for completed variants with assets, fresh grants on each call, the expiry value, denial without `content.download`, and absence of URLs in other tool results and in logs (using a recording diagnostics adapter).
- Subtitle tests feed fixed frozen snapshots through the shared cue derivation and compare SRT and VTT output exactly. Cases:
  - Captions on and off.
  - Cuts and inserted scenes shifting edited time.
  - Censored words.
  - Different `wordsPerCue` presets.
  - Cue boundaries at clip start and end.
  - Non-ASCII text.
  - An export whose revision is older than the current editor revision.
  - A parity test asserts that burn-in and subtitles produce the same cue text and timing for one snapshot.
- Continuation tests cover these cases:
  - An OAuth state created with read scopes only is refused for write.
  - An API-key state is refused after revocation.
  - Expiry happens at token expiration.
  - Tampered scope lists are refused.
  - Upload `grants` and `finalize` after the handoff expires or the assistant is revoked succeed only under the signed-in actor's own session authority, and a new `open` is refused.
- Lineage tests cover both handoff paths writing `generationRunId`, and a later regeneration that must not change an intake's status.
- Brand selection tests cover an accessible profile, a profile from another Workspace, a personal profile of another member, and omission falling back to the default.
- Worker tests assert the caption-only aspect ratio.
- Review handoff tests cover incomplete exports, stale revisions, foreign Workspaces, and the composer's preselection recheck. Review read tests assert that no tokens, passcodes, or emails appear.
- Final verification runs `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:workflow:db`, and the MCP integration suites, plus the recorded live acceptance.

## Out of Scope

- Editing and trimming tools, clip regeneration with new instructions, and other parity work with OpusClip's tool count.
- Creating or sending Review Rounds from the assistant, and assistant-driven approval.
- Per-Workspace OAuth consent, CIMD adoption, and removing DCR. DCR keeps working, and CIMD is a later change.
- Opening the connector to Creator or Pro.
- MCP Registry publication and listings for Gemini or Copilot.
- The public REST API, customer webhooks, and automation templates. See the [REST API guide](../../docs/integrations/rest-api.md).
- Renaming `McpOperation` or `MCP_CANCELLED`. The REST spec owns receipt normalization.

## Further Notes

- Claude directory submission requires OAuth, accurate tool annotations, documentation and privacy URLs, a populated reviewer account, and three to five screenshots for MCP Apps. Listings start as Community connectors after an automated scan. See [Claude connector submission](https://claude.com/docs/connectors/building/submission.md).
- ChatGPT plugin review needs verification, five positive and three negative test cases, a video, and a reviewer account without email codes. Plugins may not sell subscriptions or credits, show upgrade prompts, or link to checkout. See [ChatGPT app submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines).
- Clerk issues JWTs by default and supports opaque tokens that "can be revoked immediately." Opaque tokens require online verification, which Narriflow already performs. See [How Clerk implements OAuth](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth).
- YouTube imports from Railway are unreliable because of IP reputation. The reviewer account and the walkthrough use uploaded files.
- Load-bearing code locations:
  - `packages/mcp-core/src/mcp-projections.ts` `mcpExport`; `packages/services/src/clip-export.service.ts` `toExportSnapshot` and the 1080p downgrade.
  - `packages/validators/src/mcp.ts` `mcpGenerationSettingsSchema` and `buildMcpContentPack`.
  - `apps/web/app/mcp/integrations/[workspaceId]/[...upload]/route.ts` brand rejection.
  - `apps/worker/src/tasks/detect-clips.ts` caption-only branch.
  - `packages/services/src/project.service.ts` `getProjectSnapshot`.
  - `packages/services/src/mcp-generation-task.ts` and `mcp-task-runtime.ts`.
  - `apps/web/lib/mcp-continuation-principal.ts`; `packages/mcp-core/src/mcp-confirmation.ts`.
  - `packages/services/src/review.service.ts`.

## Comments

2026-10-08: Code and documentation are implemented (Operation Status, Download Grants and subtitles, Brand Profile selection, explicit export output, review handoff, signed-scope continuations, caption-only fix, connector page, listing drafts). GPT-6.1-Sol reviewed the plan and the diff; its findings were fixed or answered in the commit. Verification: typecheck, fast tests, MCP integration, and all ten disposable PostgreSQL gates pass (run against a local PostgreSQL 17). Remaining owner steps before `done`: apply migration `20261008000000_ingest_job_generation_run` to the shared database, switch Clerk to opaque tokens and record the `aud` check, run the live acceptance journey, prepare the reviewer account and media, then submit. See `docs/runbooks/mcp-launch-acceptance.md` ("Assistant connector launch").

Interpretation notes: an omitted `brandProfileId` means the Workspace default, resolved at intake admission so retries keep their identity. The brand list returns the default caption style's template ID and name; that style applies when `generation.captionPreset` is `brand_default`, because Brand Profiles store a style rather than a preset ID. Snapshots whose utterances lack word timing get utterance-level cues, exactly as burn-in renders them.
