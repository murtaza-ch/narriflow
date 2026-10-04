# Recovery and verification — 4 October 2026

The recoverable pre-October 3 work has been preserved and integrated with the architecture fixes already in this checkout. The original report's classification of B4, B12, X2 and X8 as absent/inapplicable was incomplete: the referenced uncommitted code had been deleted. Those entries are now addressed in the recovered implementation.

## Recovered work

| Work | Current state |
| --- | --- |
| October 3 layout engine, Automatic zoom policy, crop tracking, 128-scene limit | Recovered from Git objects and ported into the current Layout Evidence and Clip Render Attempt architecture. The obsolete renderer remains archived, with its relevant behavior ported into current modules. |
| Composition planner, FFmpeg adapter, Studio preview | Recovered and reconciled with the existing source-geometry, inserted-scene, caption, cancellation, and settlement fixes. |
| September 14 framing reviews and three images | Restored byte-for-byte from the original Git blobs. |
| September 28 marketing homepage, shared smooth-scroll, Stage sources | Recovered from archived Next.js source maps. Package wiring was recreated for the current repository. Missing gallery videos use the recovered Stage compositions. |
| Later marketing edits, deleted tools/videos additions, public/videos/home assets, exact lost small config edits and old lockfile | Exact originals remain unavailable. Existing older Remotion demos draw different stories; the unavailable duplicate tooling was not revived. The current lockfile contains the required Stage workspace wiring. |

## Findings addressed

- B4: the planner clips crop tracks to each visible source fragment and shifts inserted fragments to final composition time. B-roll and Scene Layout boundaries use the same range helper. Studio and FFmpeg sample the resulting clock consistently; manual overrides retain precedence.
- B12: Automatic allows 128 scenes and Split 64. A tracked 128-scene, four-target plan measures 639,263 bytes, so the plan cap is now 1 MiB. Maximal 48-key tracks across that boundary return `plan_size_exceeded`. All four compiled FFmpeg commands remain within the separate default 512 KiB command budget. Static and tracked headroom share one framing calculation, including portrait and square cases.
- X2: ADR 0004 records the current caps, tracking clock, and measured budgets.
- X8: Stage maps the canonical validator preset catalog, chunk size, formatter, punctuation policy, and cue end times. React state updates repaint reduced-motion canvases without requiring caller-side invalidation.
- Unknown API paths return 404; registered handlers missing an admission declaration still fail closed with 500 and never execute.
- Personal Workspace auth resolution keeps fresh reads but avoids repeated provisioning writes. A complete user without a selection cookie now uses three model calls instead of eight; missing or downgraded Owner membership still takes the repair path. Local read-only auth profiles measured 1.07–1.11 seconds. Warm server renders measured Projects 2.8 seconds and Home 3.6–4.2 seconds; a cold Projects request was 5.6 seconds, so latency remains variable.
- No stale `render-clips.ts` references remain in live apps, packages, or scripts. Historical architecture reports retain their original references.

## Local data and migrations

All 33 local clips were re-analyzed: 32 had no Automatic facts and one had v2 facts. Current v3 evidence was published through narrowly allowlisted Automatic claims and the current fenced lifecycle. There were no failures or unclaimed clips; all leases were released. Original source geometry matched every result, maximum zoom was 1.1, and the resulting 396 scenes include 46 two-up scenes, 185 tracked scenes, and 211 full-source Fit scenes.

Editor inputs, Screen/Split evidence, and unrelated Ingest/Workflow/Social queues were unchanged. The full worker loops were never started. Database, Redis, and R2 identities were verified as local before any mutation; the deployed environment was untouched.

The local database has all 95 migrations applied. The recovery's Workflow, authenticated-request-policy, and editor-persistence disposable schemas were removed by their runners. A separate Social Publication test schema remains; this recovery did not own it and leaves it intact. Four new migrations now accompany this work:

1. `20261004000000_actor_scope_project_ownership` — includes deletion of Autopilot rules without a Workspace.
2. `20261004010000_ingest_lifecycle_owner`.
3. `20261004020000_layout_evidence_source_geometry`.
4. `20261004030000_automatic_layout_v3` — invalidates obsolete derived Automatic facts before v3 readers run.

Apply all four to the intended deployed database before pushing code to `dev`. No commit, push, or deployment was performed.

## Verification

| Check | Result |
| --- | --- |
| Standards review | 0 remaining findings after the correction loop. |
| Spec review | 0 remaining findings after the correction loop. |
| Repository lint | Pass; same 6 warnings and 1 info. |
| Repository typecheck | 13 of 13 tasks pass. |
| Uncached fast tests | 2,740 pass, 0 fail; 249 PostgreSQL cases reported as skipped by this command. |
| Worker bundle | All 1,338 modules resolve. |
| Authenticated Request Policy PostgreSQL gate | 3 pass, 0 fail. |
| Clip Editor Persistence PostgreSQL gate | 27 pass, 0 fail. Initial concurrent migration attempt hit the Prisma advisory-lock timeout; sequential retry passed. |
| Workflow PostgreSQL gate | 98 pass; one stale v2 fixture failed in the original run. The corrected fixture passes its isolated PostgreSQL recheck (1 pass, 0 fail), covering all 99 cases across the full and corrective runs. |
| Real FFmpeg | Moving single crop, two-up crop across an insertion, and four-target 128-scene command budgets pass. |
| Chrome | Homepage and caption controls render; reduced-motion focus/blur repaint verified; fresh Studio single/two-up playback reaches natural end with no media errors; running unknown API returns 404. |

The Workflow failure was in the test labeled “automatic-layout evidence replaces a stale engine then stays create-only”: its supposedly current payload still used v2 after the reader moved to v3. The fixture now uses the canonical version and engine constants; its stale seed and all persistence assertions remain intact. The original full command exited with that failure; the targeted corrective command passed. No unresolved test failure remains.

The other database domains were verified in the prior architecture-fix loops; this recovery rechecks the changed auth, Clip persistence, and workflow boundaries. Original and corrective review pins are preserved with the recovery artifacts.

## Preservation and deletion evidence

The outside-checkout backup is `/Users/murtaza/Documents/dev/narriflow-recovery-20261004-075859`, indexed by its `RECOVERY.md`. It contains the original and final worktree archives with checksums, a Git object copy, recovered exact sources and source maps, restricted before/after local Clip rows, operational logs, review pins, and browser evidence. Five `refs/recovery/20261003-1808/*` tree references keep the recovered Git objects reachable. An ignored root `.env.local` was moved into its restricted backup directory; the repository continues to use app-local environment files.

The recorded fixing chat's first shell read at October 4 00:37:17 already saw a clean tracked tree at `cafaddf`. Available recorded tool calls do not identify the deletion source, so no other session was attributed or stopped on speculation. HEAD remains `cafaddf8a5189cec22d3a34145221c4e6d1654ec`; the integrated changes remain uncommitted.
