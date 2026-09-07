# Plan 015: Close SSRF gap on user-supplied media URLs + missing rate limits

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check (run first)**: the repo working tree is uncommitted product
> work; excerpts below were taken from files on disk on 2026-07-07. If an
> excerpt doesn't match the live file, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

The worker downloads two user-controlled URLs with plain `fetch` and no SSRF
validation: the studio B-roll pick (`clip.brollUrl`) and the studio music track
(`studioEdits.music.url`). Both are validated only as `z.string().url()`, so a
user can point them at internal services (cloud metadata endpoints, localhost
admin ports) and make the worker fetch them. The repo already has the guard —
`assertPublicHttpUrl` in `packages/services/src/url-guard.ts` — applied to RSS
and YouTube ingest; this plan applies the same guard to these two paths.
Separately, two API endpoints that cost money per call were missed by the
rate-limiting pass: `GET /broll/search` (calls the Pexels API) and
`POST /brand-templates/logo/presign` (R2 presign). Every other expensive
endpoint already has a `checkRateLimit` call.

## Current state

- `packages/services/src/url-guard.ts` — the existing guard. Signature:
  `export function assertPublicHttpUrl(raw: string): URL` — throws
  `UnsafeUrlError` (message `unsafe_url:<reason>`) on non-http(s) schemes and
  private/loopback/link-local hosts. Already exported from
  `packages/services/src/index.ts` (verify with grep; if not, export it).
- `apps/worker/src/tasks/render-clips.ts:1687-1737` — B-roll selection. The
  user-picked URL takes priority:
  ```ts
  const userBrollUrl = clip.brollUrl ?? null;
  ...
  if (userBrollUrl) {
    downloadUrl = userBrollUrl;
  } else {
    ... searchPexelsVideos(query, orientation) ...   // Pexels-derived, trusted
  }
  ...
  await downloadUrlToFile(downloadUrl, brollPath, "broll_download_failed");
  ```
- `apps/worker/src/tasks/render-clips.ts:1740-1760` — music download:
  ```ts
  if (studioEdits.music.url) {
    const musicPath = join(tempDir, `music-${clip.id}.bin`);
    try {
      await downloadUrlToFile(
        studioEdits.music.url,
        musicPath,
        "music_download_failed",
      );
  ```
  Both paths already wrap the download in try/catch and degrade gracefully
  (B-roll: `brollPlan = null`; music: logs `clip_music_download_failed`).
- Validation at write time: `packages/validators/src/clip.ts:132` and `:176`
  validate `brollUrl` as `z.string().url()`; `packages/validators/src/studio-edits.ts:33`
  validates music `url: z.string().url().nullable().default(null)`. These stay
  as-is (zod-level); the network-boundary check belongs where the fetch happens
  (worker) plus a cheap reject at the API write path (defense in depth).
- `packages/services/src/clip.service.ts:859-872` — `brollUrl` write path
  (method updating `data: { brollUrl }`). Add the guard here too so bad URLs
  are rejected at save time with a clear error instead of failing silently at
  render time.
- Rate limiting exemplar — `apps/web/app/api/[[...route]]/route.ts:423-429`:
  ```ts
  const rl = await checkRateLimit(`presign:${appUser.id}`, 60, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: "Too many requests. Please wait a moment and try again." },
      429,
    );
  }
  ```
  `checkRateLimit(key, limit, windowSeconds)` from `@narriflow/services`
  (`packages/services/src/rate-limit.ts:29`) — fails open when Redis is absent.
- Missing sites: `apps/web/app/api/[[...route]]/route.ts:998` (`app.get("/broll/search", ...)`)
  and `:1604` (`app.post("/brand-templates/logo/presign", ...)`) — neither has a
  `checkRateLimit` call (verified by grep: rl calls exist at lines 216, 423,
  787, 844, 1050, 1243, 1364 only).
- Convention: structured logs are `console.warn(JSON.stringify({ level, message, ...ctx }))`
  (see CLAUDE.md); worker uses a local `log(level, message, ctx)` helper in
  render-clips.ts — match it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 tasks |
| Tests | `bun run test` | all pass (~90 tests) |
| Lint | `bunx @biomejs/biome check .` | exit 0 |

## Scope

**In scope**:
- `apps/worker/src/tasks/render-clips.ts` (guard the two download sites)
- `packages/services/src/clip.service.ts` (guard the `brollUrl` write path)
- `apps/web/app/api/[[...route]]/route.ts` (two `checkRateLimit` insertions ONLY)
- `packages/services/src/url-guard.test.ts` or the existing services test file
  for url-guard, if adding cases (optional)

**Out of scope**:
- `packages/services/src/url-guard.ts` itself — do not change the guard logic.
- The zod schemas in `packages/validators` — leave `z.string().url()` as-is.
- Any other endpoint's rate limits; the Pexels client (`searchPexelsVideos`)
  — its URLs come from the Pexels API response, not the user.
- DNS-rebinding-resistant resolution (guard is structural by design — documented).

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly and leave
changes uncommitted (the tree holds the user's uncommitted product).

## Steps

### Step 1: Guard the worker downloads

In `apps/worker/src/tasks/render-clips.ts`, import `assertPublicHttpUrl` and
`UnsafeUrlError` from `@narriflow/services` (check `packages/services/src/index.ts`
exports them; add the export if missing — `url-guard.ts` already exists there).

- B-roll: where `downloadUrl = userBrollUrl;` is assigned (~line 1695), wrap:
  validate `userBrollUrl` with `assertPublicHttpUrl` in a try/catch; on
  `UnsafeUrlError`, log via the local `log("warn", "clip_broll_url_rejected", { workflowRunId: run.id, clipId: clip.id, reason: ... })`
  and fall through to the auto-search branch (i.e. treat the pick as absent).
  Do NOT validate the Pexels-derived `selected.downloadUrl`.
- Music: before `downloadUrlToFile(studioEdits.music.url, ...)` (~line 1744),
  validate with `assertPublicHttpUrl`; on `UnsafeUrlError`, log
  `clip_music_url_rejected` the same way and skip the music plan (leave
  `musicPlan = null`) — mirror the existing catch behavior.

**Verify**: `grep -n "assertPublicHttpUrl" apps/worker/src/tasks/render-clips.ts` → ≥2 call sites; `bun run typecheck` → exit 0.

### Step 2: Reject unsafe URLs at the API write path

In `packages/services/src/clip.service.ts`, in the method that persists
`brollUrl` (~lines 859-872): when the incoming `brollUrl` is a non-null string,
call `assertPublicHttpUrl(brollUrl)` before the prisma update and let
`UnsafeUrlError` propagate (the route's existing error handling maps thrown
errors to a 4xx). Check how the route handler for this update catches errors —
if it returns raw 500s for service throws, catch `UnsafeUrlError` in the route
and return `c.json({ error: "invalid_url", message: "That URL is not allowed." }, 400)`.
If a music-URL write path exists in the studio-edits save service with a
similar single choke point, apply the same one-line guard; if the studio-edits
save is a generic JSON blob save with no per-field handling, skip it (worker
guard from Step 1 is the enforcement point) and note that in your report.

**Verify**: `bun run typecheck` → exit 0; `bun run test` → all pass.

### Step 3: Add the two missing rate limits

In `apps/web/app/api/[[...route]]/route.ts`, immediately after the
`getCurrentAppUser()` / unauthorized check in each handler:
- `GET /broll/search` (line ~998): `const rl = await checkRateLimit(\`broll-search:${appUser.id}\`, 60, 60);`
- `POST /brand-templates/logo/presign` (line ~1604): `const rl = await checkRateLimit(\`logo-presign:${appUser.id}\`, 30, 60);`

Copy the exact 429 response shape from the exemplar at lines 423-429.

**Verify**: `grep -n "broll-search:\|logo-presign:" "apps/web/app/api/[[...route]]/route.ts"` → 2 matches; `bun run typecheck` → exit 0.

## Test plan

- Add a worker unit test in the existing worker test area (model after
  `apps/worker/src/tasks/detect-clips.test.ts` structure) ONLY if there is a
  pure exported helper to test; the URL guard itself is already covered by
  services tests. If the guard calls are inline (not extracted), rely on
  typecheck + suite + the greps above and say so — do NOT write a mock-heavy
  test that asserts nothing.
- Full gate: `bun run typecheck` && `bun run test` && `bunx @biomejs/biome check .` all exit 0.

## Done criteria

- [ ] `bun run typecheck` exits 0; `bun run test` exits 0; `bunx @biomejs/biome check .` exits 0
- [ ] `grep -n "assertPublicHttpUrl" apps/worker/src/tasks/render-clips.ts` → ≥2 sites (b-roll + music)
- [ ] `grep -n "assertPublicHttpUrl" packages/services/src/clip.service.ts` → ≥1 site (brollUrl write)
- [ ] `grep -c "checkRateLimit" "apps/web/app/api/[[...route]]/route.ts"` → exactly 2 more than before (was 7 call sites incl. import line; verify +2 handler calls)
- [ ] Only in-scope files modified (`git status --short`)

## STOP conditions

- The excerpts above don't match the live code (drift).
- `assertPublicHttpUrl` is not exported from `@narriflow/services` and adding
  the export causes typecheck errors elsewhere.
- The `brollUrl` write path in clip.service.ts has moved or been renamed such
  that you cannot find a single choke point.

## Maintenance notes

- Any future user-supplied URL that the worker or services fetch MUST go
  through `assertPublicHttpUrl` — grep for `downloadUrlToFile(` and raw
  `fetch(` on user data when reviewing new features.
- The guard is structural (no DNS resolution); if the product ever handles
  hostile multi-tenant traffic at scale, upgrade to resolve-and-pin.
