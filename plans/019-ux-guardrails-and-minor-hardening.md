# Plan 019: UX guardrails (destructive confirms, reliable studio flush) + minor worker hardening

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check (run first)**: excerpts taken from disk on 2026-07-07
> (uncommitted working tree). If an excerpt doesn't match the live file, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (do not run concurrently with plan 016 — different files,
  but both touch `apps/worker/src`; concurrent is actually fine EXCEPT
  render-clips.ts which this plan must NOT touch)
- **Category**: ux / bug
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

Four small, real gaps that bite users or ops:
1. Disconnecting a social account and deleting an autopilot rule fire
   immediately on click with no confirmation — inconsistent with template
   deletion, which already confirms
   (`apps/web/app/(app)/settings/brand-templates/_components/template-gallery.tsx:129`
   uses `if (!confirm(...))`). An accidental disconnect breaks scheduled posts.
2. The studio warns on tab close while a save is pending, but the pending save
   itself is only flushed on React unmount — closing the tab can still lose the
   last edit because a normal `fetch` may be killed with the page.
3. AssemblyAI HTTP calls in the worker have no per-request timeout; a hung
   connection stalls that workflow run until the 30-minute reaper fires
   (an overall polling deadline exists — `assemblyai_transcription_timeout`,
   `apps/worker/src/tasks/transcribe.ts:402` — but it only advances between
   requests).
4. If the database goes down, the worker poll loop logs an error every 2.5s
   forever instead of exiting so the container orchestrator can restart it
   cleanly.

## Current state

- `apps/web/app/(app)/settings/social/social-accounts-panel.tsx:50-72` —
  `async function disconnect(accountId: string)` does `fetch(..., { method: "DELETE" })`
  directly; invoked at line 220: `onClick={() => disconnect(account.id)}`.
  It already sets `disconnectError` via `userErrorMessage(body?.error)` on
  failure — keep that.
- `apps/web/app/(app)/autopilot/autopilot-panel.tsx:109-111` —
  `async function deleteRule(ruleId: string) { await mutate(\`/api/autopilot/rules/${ruleId}\`, { method: "DELETE" }); }`
  invoked at line 267: `onClick={() => deleteRule(rule.id)}`.
- Confirm-dialog convention (match it):
  `apps/web/app/(app)/settings/brand-templates/_components/template-gallery.tsx:129`
  uses the browser `confirm()` with a specific sentence.
- Studio flush: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx:557-585`:
  ```ts
  // Warn on tab close/refresh while a save is pending or in flight.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasPendingSaveRef.current || saveState === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    ...
  // Flush a pending debounced save on unmount ...
  useEffect(
    () => () => {
      if (hasPendingSaveRef.current) {
        void persistRef.current();
      }
    },
    [],
  );
  ```
  `persistEdits` (search for its definition in the same file) performs the
  PATCH via `fetch`. The improvement: pass `keepalive: true` on the save
  request when flushing during page dismissal so the browser lets it complete,
  and also flush on `pagehide` (fires on tab close/navigation away, incl.
  mobile, where `beforeunload` may not).
- Transcribe fetches: `apps/worker/src/tasks/transcribe.ts:215` (upload),
  `:268` (submit), `:308-315` (poll) — plain `fetch(...)` with no `signal`.
- Worker loop: `apps/worker/src/index.ts:98-171` — `pollIngestQueue()` wraps
  everything in try/catch that logs `ingest_queue_poll_failed` and continues;
  no failure counter.
- Conventions: structured logs `console.warn(JSON.stringify({ level, message, ...ctx }))`;
  web client errors surface via `userErrorMessage` from `@narriflow/validators`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Scope

**In scope**:
- `apps/web/app/(app)/settings/social/social-accounts-panel.tsx`
- `apps/web/app/(app)/autopilot/autopilot-panel.tsx`
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`
- `apps/worker/src/tasks/transcribe.ts`
- `apps/worker/src/index.ts`

**Out of scope**:
- `apps/worker/src/tasks/render-clips.ts` (plan 016 owns it — do not touch).
- `apps/web/app/api/[[...route]]/route.ts` (plans 015/017 own it).
- Introducing a modal/dialog component — use `confirm()` per the existing
  convention; a nicer dialog is a later polish.
- Changing autosave debounce timing or the save-state UI.

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly and leave
changes uncommitted.

## Steps

### Step 1: Confirmation on destructive actions

- `social-accounts-panel.tsx`: at the top of `disconnect()`, add
  `if (!confirm("Disconnect this account? Scheduled posts that target it will fail until you reconnect.")) return;`
- `autopilot-panel.tsx`: at the top of `deleteRule()`, add
  `if (!confirm("Delete this autopilot rule? New episodes from this feed will no longer be imported.")) return;`

**Verify**: `grep -n "confirm(" "apps/web/app/(app)/settings/social/social-accounts-panel.tsx" "apps/web/app/(app)/autopilot/autopilot-panel.tsx"` → 1 match each; `bun run typecheck` → exit 0.

### Step 2: Reliable studio flush on page dismissal

In `studio-shell.tsx`:
1. Give `persistEdits` an optional flag (e.g. `persistEdits(opts?: { keepalive?: boolean })`)
   that forwards `keepalive: true` to its `fetch` call(s) when set. Note the
   keepalive body limit (~64KB) — pass keepalive only for the dismissal flush;
   if the payload can exceed that, still attempt it (best effort) — do not
   restructure the save.
2. Add a `pagehide` listener alongside the existing `beforeunload` one: on
   `pagehide`, if `hasPendingSaveRef.current`, call
   `void persistRef.current({ keepalive: true })`. Keep the `beforeunload`
   warning exactly as is.
3. The unmount flush may also pass `{ keepalive: true }` (harmless in-app).

**Verify**: `grep -n "pagehide\|keepalive" "apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx"` → ≥2 matches; `bun run typecheck` → exit 0; `bun run test` → all pass.

### Step 3: Per-request timeouts on AssemblyAI calls

In `transcribe.ts`, add `signal: AbortSignal.timeout(<ms>)` to the three fetch
sites: upload (line ~215) — 10 minutes (large file body); submit (~268) — 30s;
poll (~308) — 30s. Wrap so an `AbortError`/`TimeoutError` surfaces as the
existing `WorkflowWorkerError` codes (`assemblyai_upload_failed`,
`assemblyai_transcription_poll_failed`, etc.) with a "timed out" message —
follow how non-OK responses are already converted in each function. Bun
supports `AbortSignal.timeout`.

**Verify**: `grep -n "AbortSignal.timeout" apps/worker/src/tasks/transcribe.ts` → 3 matches; `bun run typecheck` → exit 0.

### Step 4: Crash-out on persistent poll failures

In `apps/worker/src/index.ts` `pollIngestQueue()`: add a module-level
`let consecutivePollFailures = 0;`. In the catch block increment it; reset to 0
at the start of the `try` body's success path (e.g. right after
`lastPollAt = ...` assignment, or in a `finally`-adjacent success line — reset
whenever the try completes without throwing). When the counter reaches a
threshold (default 20, env-overridable `WORKER_MAX_CONSECUTIVE_POLL_FAILURES`),
log `worker_poll_failures_exceeded` at error level and `process.exit(1)` so the
orchestrator restarts the container. Document the env knob in
`apps/worker/.env.example` — wait, that file is in scope only for this line;
add `WORKER_MAX_CONSECUTIVE_POLL_FAILURES=20` matching the existing comment
style (this is an allowed exception to the scope list; only this line).

**Verify**: `grep -n "consecutivePollFailures\|worker_poll_failures_exceeded" apps/worker/src/index.ts` → ≥3 matches; `bun run typecheck` → exit 0.

## Test plan

- No new unit tests required: Steps 1-2 are browser-behavior wiring (no test
  harness for these components), Steps 3-4 are timeout/exit wiring around IO.
  Do NOT write mock-heavy tests that assert nothing.
- Full gate: `bun run typecheck` && `bun run test` && `bunx @biomejs/biome check .` all exit 0.

## Done criteria

- [ ] `bun run typecheck`, `bun run test`, `bunx @biomejs/biome check .` all exit 0
- [ ] Both destructive actions confirm before firing (greps in Step 1)
- [ ] Studio flushes with `keepalive` on `pagehide` (grep in Step 2)
- [ ] Three AssemblyAI fetches carry `AbortSignal.timeout` (grep in Step 3)
- [ ] Worker exits after N consecutive poll failures (grep in Step 4)
- [ ] Only in-scope files (+ one `.env.example` line) modified (`git status --short`)

## STOP conditions

- Excerpts don't match the live code (drift).
- `persistEdits` performs its saves through something other than `fetch`
  (e.g. a server action) where `keepalive` doesn't apply — report instead of
  forcing it.
- `AbortSignal.timeout` is unavailable in the worker's Bun runtime (typecheck
  or runtime error) — report; do not hand-roll a controller with timers unless
  the plan reviewer approves.

## Maintenance notes

- The `confirm()` calls are the app's convention today; when a design-system
  dialog lands, replace all three sites (including template-gallery) together.
- If autosave payloads grow (e.g. full transcript blobs), revisit the keepalive
  64KB note in Step 2 — a dedicated lightweight "flush marker" endpoint is the
  upgrade path.
- The poll-failure exit assumes the deployment restarts crashed containers
  (Docker/orchestrator). If the worker ever runs bare, wrap it in a supervisor.
