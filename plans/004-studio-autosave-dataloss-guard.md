# Plan 004: Prevent studio edit loss on navigation/unload

> **Executor instructions**: Follow step by step; verify each step. STOP if the
> excerpts don't match.
>
> **Drift check (run first)**: `git diff --stat 05d273d..HEAD -- "apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio"` — excerpts are from the working tree on disk.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (touches the studio autosave lifecycle)
- **Depends on**: none
- **Category**: bug / correctness
- **Planned at**: commit `05d273d`, 2026-07-06

## Why this matters

The studio editor autosaves transcript/caption/studio edits on a debounce
(~1.5s). If the user hits Back, closes the tab, or the component unmounts inside
that window, the pending edit is lost silently — the autosave timeout is cleared
on unmount but not flushed. For a paid editor where users fine-tune captions,
silent loss of work is a trust-killer. This adds a `beforeunload` warning while
a save is pending and flushes the pending save on unmount.

## Current state

- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`:
  - `persistEdits` is a `useCallback` depending on `captionPreset`, `utterances`, `studioEdits` (around lines 305-325).
  - The autosave effect (around lines 525-545) sets a debounce `setTimeout` and clears it on cleanup.
  - `saveState` is a state value with `"idle" | "saving" | "saved" | "error"` (used by `top-bar.tsx`).
- Confirm exact line numbers by opening the file; the structure (debounced autosave + `saveState`) is what matters, not the literal lines.

Conventions: client component, React hooks, `useRef` used elsewhere in this file.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | all pass |

## Scope

**In scope**:
- `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx` only.

**Out of scope**:
- Do not change the debounce interval or the persist payload shape.
- Do not add router-navigation interception (Next App Router lacks a stable
  blocking API; `beforeunload` covers tab-close/refresh, and an unmount flush
  covers in-app navigation). Do not pull in a routing-events hack.

## Steps

### Step 1: Track "dirty/pending" state

Introduce a ref that is true whenever there are unsaved changes (set it when an
edit happens / when the debounce is scheduled, clear it when `persistEdits`
resolves successfully). A ref (not state) avoids re-render churn and is readable
from event handlers. Example:

```ts
const hasPendingSaveRef = useRef(false);
```

Set `hasPendingSaveRef.current = true` where edits schedule the autosave; set it
`false` inside `persistEdits` after a successful save.

### Step 2: Warn on tab close/refresh while a save is pending

Add an effect:

```ts
useEffect(() => {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (hasPendingSaveRef.current || saveState === "saving") {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => window.removeEventListener("beforeunload", onBeforeUnload);
}, [saveState]);
```

### Step 3: Flush pending save on unmount (in-app navigation)

In the autosave effect's cleanup (or a dedicated unmount effect), if a debounce
timeout is still pending, call `persistEdits()` immediately so the last edit is
sent before the component tears down. Use a ref to the latest `persistEdits` so
the unmount effect (`useEffect(() => () => {...}, [])`) always calls the current
version without re-subscribing:

```ts
const persistRef = useRef(persistEdits);
useEffect(() => { persistRef.current = persistEdits; }, [persistEdits]);
useEffect(() => () => {
  if (hasPendingSaveRef.current) { void persistRef.current(); }
}, []);
```

Ensure `persistEdits` is safe to call during unmount (it must not `setState` on
an unmounted component in a way that throws — a fire-and-forget fetch is fine;
guard any post-await `setState` with a mounted check if one isn't already there).

**Verify**: `bun run typecheck` → exit 0. `grep -n "beforeunload" apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx` → matched.

## Test plan

- This is lifecycle/DOM behavior not covered by the current headless suite; do
  not fabricate a brittle jsdom test. Rely on typecheck + full test suite
  staying green.
- Manual verification (document in your report, run only if a dev server is
  available): open a clip studio, edit a caption, immediately hit browser Back —
  expect the `beforeunload` prompt when refreshing mid-save, and confirm the
  edit persists after reload following in-app navigation.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0
- [ ] `grep -n "beforeunload" .../studio-shell.tsx` → matched
- [ ] `grep -n "hasPendingSaveRef" .../studio-shell.tsx` → matched
- [ ] Only `studio-shell.tsx` modified (`git status`)

## STOP conditions

- `persistEdits` or `saveState` is structured differently than described (e.g.
  save is not debounced but immediate) → the data-loss window may not exist as
  described; STOP and report what you found.
- Calling `persistEdits` on unmount triggers a React "setState on unmounted
  component" warning that can't be cleanly guarded → report; keep the
  `beforeunload` guard (step 2) which is independently valuable.

## Maintenance notes

- If Next.js ships a stable navigation-blocking API, replace the unmount-flush
  with an explicit "unsaved changes" confirm on in-app navigation.
- Reviewer: confirm the unmount flush does not double-save (pending flag cleared on success).
