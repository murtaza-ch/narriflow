# 07 Web client

**What to build:** Edits are never left behind, progress stays live without wasting requests, and routes load only what they use.

**Blocked by:** None

**Status:** done

Owns: `apps/web/**` except `app/(app)/upload/**` (ticket 04) and `lib/post-auth-redirect.ts` (ticket 01), plus `packages/api-client/**`.

**Owner UI rules:** no borders, soft fills, shadowless dropdowns, grey field focus, blue accent, neutral primary buttons. No redesigns. The Studio preview must keep matching exports, so do not change preview composition.

## Must fix
1. **Leaving the Studio can leave the newest edits only on the device (medium).** `studio-editing-session.ts:959`, `studio-cloud-http.ts:131`, `top-bar.tsx:328`. Back is a plain `router.push`; close-time sync is skipped while a save runs and refused above 48 KiB, a page-unload cap that also applies inside the SPA. Make Back and other in-Studio navigations await `session.perform({type:"checkpoint-cloud"})` with a short timeout. On `reason:"unmount"` use the normal `cloud.save`, not keepalive. Keep generation handling correct so the in-flight response is not ignored into a false conflict.
2. **Project page never stops its progress stream (medium).** `project-events-provider.tsx:140`, `packages/api-client/src/progress/socket.ts:54`. Enable only while the project has active work and the document is visible; re-enable on focus or after a command. Compare `use-ingest-stream.ts:118`.
3. **Socket backoff never resets on a clean renewal (medium).** `socket.ts:97,121`. Set `attempt = 0` on connected; reconnect immediately when the close was the local expiry.
4. **No request timeout on autosave (medium).** `transport.ts:213`, `studio-editing-session.ts:1395`. `AbortSignal.timeout(~30s)` in the Studio cloud adapter's `save` and `reset`, classified transient. Not on uploads.
5. **Project and Studio routes ship everything up front (medium).** `/projects/[projectId]` 2,543 KB raw; Studio 2,510 KB; `/home` 1,717 KB. `next/dynamic` for `edit-clip-length-dialog`, `publishing-*`, `dubbing-panel`, `review-panel`, `campaign-*` and Studio tool panels. Keep loading states consistent. Measure before and after from `.next/diagnostics/route-bundle-stats.json`.
6. **Studio saves never refresh project caches (low).** `studio-shell.tsx`, `studio/page.tsx`, `clip-row.tsx:457`. Call `invalidateProjectClips` after the final checkpoint.
7. **Device Drafts not keyed by user (low).** `local-editor-draft.ts:44`, `lib/sign-out-storage.ts`. Add `userId`. No migration needed.
8. **Transient media failures stick for the tab's life (low).** `waveform-peaks.ts:62`, `timeline-preview-manager.ts:179`. Do not cache failures.
9. **Auth form ships to every route (low).** `app/layout.tsx`, `app/_components/auth/auth-modal.tsx:7`. `next/dynamic` inside the active branch.
10. **Possible missing invalidation (check).** `campaign-editor-action-preview.tsx:494` has no visible invalidation; trace the caller.

## Reuse
- One multi-query page gate helper (`settings/workspace/page.tsx`, `settings/members/page.tsx`, `recipes/recipes-screen.tsx`, `brand-kit/styles/[id]/style-screen.tsx`).
- Generalise `intentIn` (`recipes/recipes-panel.tsx`, `autopilot/autopilot-panel.tsx`).
- One blob download helper (`projects/[projectId]/transcript-download.ts:46`, `exports/[exportId]/export-delivery-client.tsx:65,306,331`, `upload/_components/upload-screen.tsx:147`). The upload copy revokes too early.
- `apps/web/lib/format.ts` for `formatBytes` and `formatTime` copies.

## Verification
`bun run --cwd apps/web test`, typecheck, `bun run check:web-split`. Verify user-visible changes in the browser preview where the running app allows it.

## Comments

### Ticket 07 implementation, 2026-11-04

**Fixed**
1. Studio leave (confirmed). `close` with `reason` `unmount` or `navigation` now waits (up to `CLOSE_CHECKPOINT_TIMEOUT_MS`, 5 s) for the regular cloud save to make the document current, keeping the session generation unchanged so an in-flight response is applied (no false conflict) and the newest edit goes out after it. Only `pagehide` still uses the 48 KiB keepalive. The Device Draft write at close is unchanged, so a timeout or blocked save still leaves the draft intact. Back, "backToProject", duplicate and the "Open new clip" toast go through `leaveStudio` (`studio-leave.ts`), which awaits `checkpoint-cloud` with the same timeout. Delete and export navigations are unchanged (the clip is gone; export already `prepare-cloud-revision`d). Failing-first tests: 4 in `studio-editing-session-cloud.test.ts` (unmount uses `save`, in-flight response kept and newest edit sent on revision 4, timeout, pagehide during the wait); one existing test (`close rejects new edits while its final Device Draft is still writing`) changed to release the wait through the timeout.
2. Project page stream (confirmed). `ProjectEventsProvider` takes `active` (`view.hasActiveWork` = `progress.active || transcriptInFlight || renderStatus.inFlightCount > 0`) and enables the stream only while active and the tab is visible (`lib/use-document-visible.ts`). `sinceSeq` is the newest seq the page holds, so a resumed stream replays only what it missed. Window-focus refetch (already on) re-derives `active` after a hidden period; a command refetches the Project and turns it on.
3. Socket backoff (confirmed). `attempt` resets on `connected`; a renewal at local expiry after an opened connection reconnects at once (never when it expired before opening, so a clock-skewed ticket cannot spin). Two new tests in `socket.test.ts`.
4. Autosave timeout (confirmed; classification was already transient because the session treats any rejection as `network`). `save` and `reset` carry `AbortSignal.timeout(30 s)` (`CLOUD_WRITE_TIMEOUT_MS`); load and uploads do not.
5. Bundles (measured, uncompressed first-load JS from `route-bundle-stats.json`, built with a temporary `distDir`, config restored, `.next` untouched):
   `/projects/[projectId]` 2543 -> 2287 KB (-256), Studio 2510 -> 2219 KB (-292), `/home` 1717 -> 1685 KB (-33, auth form). All 54 routes sum 88,091 -> 85,396 KB. Done with `next/dynamic`: Studio tool panels (9); project tab panels (transcript, repurpose, dubbing, review, analytics); `EditClipLengthDialog` (mounted on first open, chunk prefetched on hover/focus); publishing composer and posts list (`publishing-composer.tsx` split out of `publishing-provider.tsx`); `useInternalReviews` and its types moved to `internal-reviews.ts` so the header's share button no longer pulls the review panel in. Skipped: `campaign-editor-action-preview` (its shared outcome components are used by the always-loaded command bar; the preview itself is about 15 KB of source) and the small Studio dialogs.
6. Project caches (confirmed). `createStudioCloudHttp({ onWritten })` fires after any 2xx save or reset; the shell invalidates the project clip reads (inactive queries only turn stale, so no extra requests).
7. Device Drafts (confirmed). Key is now `userId:projectId:clipId`; records carry `userId` and the parser checks it. The cross-tab lease and channel stay per clip. Old drafts under the previous key are simply never read (pre-production policy).
8. Sticky media failures (confirmed). Peaks failures and malformed answers are no longer cached. A thumbnail video that errors or times out is disposed so the next job opens a fresh element.
9. Auth form dynamic import in `auth-modal.tsx`.
10. `campaign-editor-action-preview` (partly rejected): the success path already invalidates through `receiveEditorActionResult` -> `invalidateAfterCampaignApply`. The failure path did not, unlike the motion and bundle paths; it now refetches on a lost response or conflict.

**Reuse**: `gateQueries` (`app/_components/query-gate.ts`) now backs workspace settings, members, recipes and the style editor (a failed background refresh keeps its data; superseded failures stay loading). `intentIn` takes any `{ createIntent }` and `intentFor` covers the keyed map in recipes and autopilot panels. `lib/download.ts` (`saveBlob`, `downloadUrl`) replaces the transcript and export-delivery copies. `formatFileSize` and `formatUtcDateTime` in `lib/format.ts` replace three `formatTime` and two byte formatters. Not touched: `upload/_components/upload-screen.tsx:147` (ticket 04 owns it; it still revokes the object URL immediately and can use `lib/download.ts`) and `upload-session-status.tsx` `formatBytes` (binary units, different output).

**Verification**: `bun test` in apps/web 1066 pass, 1 fail (`repository-verification.test.ts`: root `package.json` has `test:schema-drift:db`, which another ticket added; not mine). `packages/api-client` 231 pass. `tsc` clean for apps/web (remaining errors during the run were in other tickets' `packages/services` files). Biome clean for apps/web and packages/api-client (11 existing CSS warnings). `check:web-split` passes. `next build` succeeded in a separate dist dir with the numbers above.
Not checked in a real browser: Back/leave behaviour with a slow save, the paused project stream on tab hide, lazy panels' loading states, trim dialog's first open after the chunk prefetch.
Schema changes needed: none.

