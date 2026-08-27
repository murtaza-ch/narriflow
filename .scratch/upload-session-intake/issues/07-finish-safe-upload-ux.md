# 07 — Finish safe pause, discard, and verification UX

**What to build:** Give creators one clear upload flow whose controls match the real commit state. Pause preserves work, Discard cleans up only while safe, Verifying continues without the page, and a completed retry opens the same queued project.

**Blocked by:** [04 — Window multipart grants and make resume byte-accurate](04-window-multipart-grants-and-resume.md); [05 — Make finalization replayable](05-make-finalization-replayable.md); [06 — Reconcile and expire sessions without a browser](06-reconcile-and-expire-without-browser.md).

**Status:** implementation-complete-browser-gate

**Specification:** [Deepen Upload Session intake and reconciliation](../spec.md)

## Observable acceptance criteria

- [x] A browser upload adapter owns direct byte transfer, local resume state, progress, retries, grant refresh, finalization polling, and unload behavior behind one snapshot and intent interface.
- [x] React renders adapter state and sends user intents without choosing provider recovery, session transitions, grant policy, or fresh-upload fallback.
- [x] Preparing, Uploading, Paused, Verifying, Queued, and Failed states have distinct accessible copy and controls.
- [x] Pause appears only during active byte transfer, aborts and settles browser requests, preserves the server session and resume record, and never calls provider abort.
- [x] Resume with the exact file restores server-planned progress and continues missing bytes with fresh grants.
- [x] Discard is an explicit secondary destructive action available only before finalization. It first stops browser transfers, calls session discard, waits for the accepted compensation outcome, then clears local resume state.
- [x] Once finalization intent is accepted, Discard disappears. Closing the page or choosing to leave does not cancel system reconciliation.
- [x] Verifying handles HTTP 202 with server Retry-After guidance and bounded jittered status polling. It never renders `reconciliation_required` as a dead-end error.
- [x] Verifying copy tells the creator that Narriflow is checking the upload and that the page may be left safely.
- [x] Reopening or reselecting the exact file during reconciliation checks the existing session rather than starting fresh.
- [x] A `queued_for_ingest` replay clears the resume record, navigates to the same Project, and cannot create another project or transfer.
- [x] A fresh upload is offered only after the module proves the prior session and exact provider object are unavailable or terminally compensated.
- [x] Frozen title, brand, language, and generation settings cannot drift while submitting. Resume explains that the saved settings remain attached to the session.
- [x] Expected quota, expired, conflict, authorization, integrity, transient provider, and terminal compensation outcomes use stable user messages and actions.
- [x] The view follows Blueline tokens and structure, uses one solid ultramarine action, keeps destructive and Pause actions secondary, and introduces no hardcoded UI chrome colors.
- [x] Progress, speed, ETA, and time values use shared formatting helpers and remain announced without flooding assistive technology.
- [x] Hono routes expose strict open, grant, finalize, status, and discard contracts with typed status codes and no string-message branching.

## Public-interface and failure-injection tests

- [x] Browser-adapter tests use fake HTTP, upload transport, clock, local storage, and navigation adapters and do not depend on React effect order.
- [x] Tests cover pause during several active parts, pause race with a completed part, exact resume, discard success, discard cleanup delay, discard denial after finalize, unload during upload, and unload during verifying.
- [x] Status tests cover repeated 202, Retry-After, transient polling failure, queued replay, permanent terminal state, expired session, and server-proven fresh fallback.
- [x] React tests assert visible controls, accessible labels, focus behavior, and progress announcements; browser-adapter tests exercise stable recovery actions from the same snapshots.
- [x] Hono contracts prove typed mapping, strict validation, workspace isolation, rate limits, and absence of provider details.
- [ ] A real-browser checklist covers small audio, multipart video, Pause and resume, simulated lost finalize response, leaving during Verifying, completed replay, and Discard.

## Rollout and compatibility constraints

- [x] Remove the old monolithic upload orchestration and old error copy once the adapter path passes. Do not retain a hidden fallback flow.
- [x] Browser records from the former pre-production version are discarded safely without server compatibility reads.
- [x] Link and RSS intake remain visually and behaviorally unchanged.

## Scope boundaries

- [x] Do not add background transfer after tab close, multi-upload management, native file handles, service workers, or cross-device resume.
- [x] Do not redesign the upload page outside the states and controls needed for this contract.

## Fresh-task handoff

Implement after tickets 04 through 06 with `/implement`; drive the browser adapter and state UX with `/tdd`; finish with `/code-review`; run uncached web, Hono, accessibility, real-browser, typecheck, lint, and build verification.
