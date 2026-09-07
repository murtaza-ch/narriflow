# Plan 001: App-wide error handling, boundaries, and user-facing error messages

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If a STOP condition occurs, stop and report — do not improvise.
>
> **Drift check (run first)**: `git diff --stat 05d273d..HEAD -- apps/web/app` —
> this repo has a large uncommitted working tree; the "Current state" excerpts
> below were taken from the working tree on disk (not HEAD). Open each cited
> file and confirm the excerpt matches before editing.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug / UX / error-handling
- **Planned at**: commit `05d273d`, 2026-07-06

## Why this matters

Narriflow is about to be sold as a professional product, but it has **zero**
error boundaries (`find apps/web/app -name error.tsx -o -name not-found.tsx`
returns nothing). A single throw in any server component (e.g.
`projectService.getProjectSnapshot`) white-screens the whole app with Next.js's
default error page. Separately, many user actions fail completely silently
(`if (!response.ok) return;`) so a creator clicks "Render", nothing happens, and
they have no idea why. And when errors *are* shown, they're raw machine codes
like `ingest_max_duration_exceeded`. This plan makes failures visible, friendly,
and recoverable — the single biggest "feels professional" upgrade available.

## Current state

Verified facts (working tree on disk):

- **No boundaries exist**: `find apps/web/app -name "error.tsx" -o -name "not-found.tsx" -o -name "loading.tsx"` → empty.
- **Silent fetch failures** (representative, there are more):
  - `apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx:74-76` —
    ```tsx
    if (!response.ok) {
      return;
    }
    ```
  - `apps/web/app/(app)/settings/social/social-accounts-panel.tsx:46-49` — `disconnect()` DELETE, `if(!response.ok) return` silently.
  - `apps/web/app/(app)/projects/[projectId]/social-scheduling-panel.tsx:112-117` — `cancelPost()` fetch DELETE, no error surface.
  - `apps/web/app/(app)/projects/[projectId]/clip-card.tsx:253-266` — `handleStatusUpdate`/`handleBoundarySave` try/finally with no catch.
- **Raw error codes rendered to users**:
  - `apps/web/app/(app)/projects/[projectId]/page.tsx` — displays `snapshot.project.ingestErrorCode` directly (search for `ingestErrorCode`).
  - `apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx` — displays `transcript.errorCode` directly (search for `errorCode`).
- **A good pattern already exists to copy**: `apps/web/app/(app)/projects/[projectId]/content-suite-panel.tsx` uses local `const [error, setError] = useState<string|null>(null)` + try/catch/finally and renders the error inline. Match this pattern.
- **Toaster**: check whether a toast system is mounted. Run `grep -rn "toaster\|Toaster\|createToaster\|useToast" packages/ui apps/web/app | head`. If Chakra's toaster is available, use it; **if not, do NOT introduce a new dependency** — use the local inline `[error,setError]` + a small inline error text pattern from `content-suite-panel.tsx` instead. Decide once and be consistent.

Repo conventions:
- Chakra UI v3 (`@chakra-ui/react`) with semantic tokens (`bg.panel`, `fg.muted`, `danger.solid`, `border`). Match existing components' token usage (see `project-events.tsx`).
- Client components start with `"use client";`.
- App Router route groups: `apps/web/app/(app)/...` and `apps/web/app/(marketing)/...`.

## Commands you will need

| Purpose   | Command                              | Expected |
|-----------|--------------------------------------|----------|
| Typecheck | `bun run typecheck`                  | exit 0, no errors |
| Tests     | `bun run test`                       | all pass |
| Find boundaries | `find apps/web/app -name "error.tsx"` | lists new files after step 1 |

## Scope

**In scope** (create/modify only these):
- Create `apps/web/app/(app)/error.tsx` (route-group error boundary, client component).
- Create `apps/web/app/(app)/not-found.tsx`.
- Create `apps/web/app/(app)/projects/[projectId]/error.tsx`.
- Create `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/error.tsx`.
- Create `apps/web/app/global-error.tsx` (root-level catch, must render `<html><body>`).
- Create `packages/validators/src/error-messages.ts` (map error code → friendly text) and export it from `packages/validators/src/index.ts`.
- Modify these to surface errors + friendly codes:
  - `apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx`
  - `apps/web/app/(app)/settings/social/social-accounts-panel.tsx`
  - `apps/web/app/(app)/projects/[projectId]/social-scheduling-panel.tsx`
  - `apps/web/app/(app)/projects/[projectId]/clip-card.tsx`
  - `apps/web/app/(app)/projects/[projectId]/page.tsx` (use friendly map for `ingestErrorCode`)
  - `apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx` (use friendly map for `errorCode`)
- Add a test: `packages/validators/src/error-messages.test.ts`.

**Out of scope** (do NOT touch):
- Any server action or service-layer file. This plan is presentation-only.
- The studio autosave data-loss guard — that is Plan 004.
- Do not add a new npm dependency (no toast library) unless one is already mounted.

## Steps

### Step 1: Friendly error-message map

Create `packages/validators/src/error-messages.ts`:

```ts
/** Maps internal error codes to user-facing copy. Keep messages calm,
 *  specific, and actionable. Fall back to a generic message for unknowns. */
export const USER_ERROR_MESSAGES: Record<string, string> = {
  ingest_max_duration_exceeded: "This video is longer than your plan allows. Upgrade or trim it and try again.",
  ingest_download_failed: "We couldn't download that source. Check the link and try again.",
  ingest_unsupported_format: "That media format isn't supported. Please upload an MP4, MOV, or common audio file.",
  quota_exceeded: "You've used all your processing minutes for this month. Upgrade to keep going.",
  transcription_failed: "Transcription didn't complete. Please retry — if it keeps failing, contact support.",
  moment_detection_failed: "Clip detection didn't complete. Please retry generation.",
  clip_rendering_failed: "A clip failed to render. Try rendering it again.",
  dubbing_failed: "Voiceover dubbing didn't complete. Please try again.",
  // Extend as new codes appear.
};

export function userErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return USER_ERROR_MESSAGES[code] ?? "Something went wrong. Please try again or contact support.";
}
```

Before finalizing the keys, run `grep -rhoE '"[a-z_]+_(failed|exceeded|error|unsupported)"' packages/services/src apps/worker/src | sort -u` and fold any additional real error codes you find into the map (best-effort; the fallback covers the rest).

Export both from `packages/validators/src/index.ts` (add `export * from "./error-messages";` next to the other re-exports — confirm the file uses that style first).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Error boundaries

Create client-component error boundaries. Root `global-error.tsx` must render its own `<html>`/`<body>`. Example for `apps/web/app/(app)/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("app_error_boundary", error);
  }, [error]);

  return (
    <Box display="flex" minH="60dvh" alignItems="center" justifyContent="center" p="24px">
      <Stack gap="12px" maxW="420px" textAlign="center">
        <Heading size="md">Something went wrong</Heading>
        <Text color="fg.muted" fontSize="14px">
          We hit an unexpected error loading this page. You can try again, and if it keeps happening, contact support.
        </Text>
        <Button onClick={reset} alignSelf="center">Try again</Button>
      </Stack>
    </Box>
  );
}
```

- `projects/[projectId]/error.tsx` and `.../studio/error.tsx`: same shape, context-specific copy ("We couldn't load this project" / "We couldn't load the editor") and, where sensible, a secondary link back (`/projects`). The studio one should keep dark-surface styling consistent with the editor.
- `not-found.tsx`: a friendly 404 with a link to `/projects`.
- `global-error.tsx`: wraps content in `<html lang="en"><body>...</body></html>`, generic copy, `reset` button.

**Verify**: `find apps/web/app -name "error.tsx" -o -name "not-found.tsx" -o -name "global-error.tsx"` lists all five new files; `bun run typecheck` → exit 0.

### Step 3: Surface silent fetch failures

For each of the four action components, add local error state (mirror `content-suite-panel.tsx`) and a pending/disabled state on the triggering button. Concretely, for `render-clips-button.tsx`:

- Add `const [error, setError] = useState<string | null>(null);`
- Wrap `handleRender` in try/catch; on `!response.ok`, read the JSON body if present (`const body = await response.json().catch(() => null)`) and `setError(userErrorMessage(body?.error) ?? "Could not start rendering. Please try again.")`; on thrown error, set a generic message; use `console.error` for the raw detail.
- Render the error text near the button (small `<Text color="danger.solid" fontSize="12px">`).
- Ensure the button is disabled while the request is in flight (there is already `isPending` from a transition in some of these — reuse it; otherwise add a local `submitting` flag).

Apply the equivalent to `social-accounts-panel.tsx` (`disconnect`), `social-scheduling-panel.tsx` (`cancelPost` and `schedulePost` — add a pending flag to prevent double-submit), and `clip-card.tsx` (`handleStatusUpdate`/`handleBoundarySave` — add a `catch` that surfaces a message).

**Verify**: `grep -n "if (!response.ok) {" apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx` shows the block now sets error state (not a bare `return`). `bun run typecheck` → exit 0.

### Step 4: Friendly error codes in project/transcript views

- `projects/[projectId]/page.tsx`: replace the raw `ingestErrorCode` render with `userErrorMessage(snapshot.project.ingestErrorCode)`.
- `transcript-panel.tsx`: replace raw `errorCode` render with `userErrorMessage(transcript.errorCode)`.

Keep the raw code available to devs via `console` only if helpful; do not show it in the UI.

**Verify**: `grep -rn "userErrorMessage" apps/web/app/(app)/projects/[projectId]/page.tsx apps/web/app/(app)/projects/[projectId]/transcript-panel.tsx` → both matched. `bun run typecheck` → exit 0.

## Test plan

- New test `packages/validators/src/error-messages.test.ts` (model after `packages/validators/src/caption-preset.test.ts` structure — `import { describe, expect, test } from "bun:test"`):
  - `userErrorMessage("quota_exceeded")` returns the friendly quota string.
  - `userErrorMessage("totally_unknown_code")` returns the generic fallback.
  - `userErrorMessage(null)` and `userErrorMessage(undefined)` return `null`.
- Verification: `bun run test` → all pass including the 3 new cases.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun run test` exits 0; `error-messages.test.ts` exists and passes
- [ ] `find apps/web/app -name "error.tsx" -o -name "not-found.tsx" -o -name "global-error.tsx"` lists 5 files
- [ ] `grep -rn "if (!response.ok) {\s*$" apps/web/app/(app)/projects/[projectId]/render-clips-button.tsx` no longer shows a bare `return;` inside (error is surfaced)
- [ ] No files outside the in-scope list are modified (`git status`)

## STOP conditions

- The cited excerpts don't match the working tree (codebase drifted) — report the diff.
- A toast system turns out to be half-wired and using it breaks typecheck — fall back to the inline `[error,setError]` pattern and note it.
- Adding `export * from "./error-messages"` to the validators index causes a name collision — report it; rename the export.

## Maintenance notes

- When new worker error codes are added, extend `USER_ERROR_MESSAGES`. The fallback keeps unknown codes safe in the meantime.
- Reviewer should confirm no raw `errorCode`/`ingestErrorCode` strings remain rendered in JSX (`grep -rn "errorCode}" apps/web/app`).
