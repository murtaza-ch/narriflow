# Plan 043: Add a source-linked professional editor handoff package

> **Validation-gated product plan**: Interview at least five active podcast/video
> editors and validate relinking with their real Premiere Pro and DaVinci
> Resolve workflows before promising XML support. Ship a trustworthy manifest
> and source-time jump first; do not claim bidirectional round-trip editing.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- packages/db/prisma/schema.prisma packages/services/src/clip.service.ts packages/services/src/project.service.ts packages/services/src/transcript.service.ts apps/worker/src/tasks/render-clips.ts 'apps/web/app/(app)/projects'`

## Status

- **Priority**: P2 differentiator/parity
- **Effort**: M
- **Risk**: MED
- **Confidence**: MED-HIGH
- **Depends on**: plans/025-usable-clip-yield.md and stable source timebase;
  Plan 027 before asynchronous package generation
- **Category**: feature, workflow, export, professional UX
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

Narriflow can export final video and transcript `txt/srt/vtt`, but it has no
source-linked edit manifest, EDL/FCPXML, or Premiere/Resolve handoff surface.
OpusClip now includes Premiere Pro and DaVinci Resolve XML export on paid plans,
which validates professional handoff as a paid workflow expectation.

For podcast/content teams, forcing every correction into Narriflow's Studio is
less valuable than making Narriflow the best discovery/review layer that hands
exact source context to an editor. This direction complements usable-yield work:
the product can measure whether a candidate was accepted, repaired, or sent to
an NLE without pretending the final creative process always stays in-browser.

Current source: <https://www.opus.pro/pricing>

## Product outcome

From any candidate or accepted clip, an editor can jump to exact source context
and download one deterministic package containing media/proxy references,
source timebase, cut boundaries, transcript/captions, titles/notes, brand/render
intent, and checksums. A later validated FCPXML export relinks consistently in
supported NLE/version matrices.

Non-goals for V1:

- No bidirectional timeline sync or ingest of arbitrary NLE projects.
- No claim that every transition/B-roll/caption animation maps losslessly.
- No redistribution of unlicensed source/stock/music assets.
- No zip containing secrets, signed URLs with excessive lifetime, or another
  tenant's media.

## Phase 0: Workflow discovery and contract approval

Interview podcast editors/producers across at least:

- source media stored locally versus cloud/recording platform;
- variable versus constant frame rate;
- separate audio tracks versus flattened media;
- Premiere Pro and DaVinci Resolve versions/platforms;
- rendered-short handoff versus source-timeline handoff;
- captions, B-roll, branding, music and approval notes.

Observe actual imports/relinks. Define which artifacts are essential and which
Narriflow edits should become NLE markers/notes rather than falsely reconstructed
effects. Approve supported frame-rate/timebase/version matrix and success metric
(for example, package-to-correctly-relinked timeline in under two minutes).

## Phase 1: Exact source linkage in Narriflow

- Store/expose authoritative source start/end in milliseconds plus rational
  media timebase, duration, frame-rate mode, audio sample rate, and source asset
  identity/checksum/provenance.
- Every candidate card gets “Play in source” with configurable context before/
  after and transcript-first expansion. The player must seek against the clean
  authoritative source, not an approximate rendered clip.
- Make boundary edits and optional non-contiguous narrative stitching explicit
  ordered source ranges. Never flatten stitching into one misleading range.
- Record review/handoff events for Plan 025 without counting a handoff itself as
  a publish or successful outcome.

## Phase 2: Versioned handoff manifest

Define a documented JSON schema and human-readable CSV/README containing:

- manifest/schema/export version and creation time;
- project/clip IDs that are safe for the owner, source file display name,
  checksum and exact media metadata;
- ordered source ranges, handles/context, selected aspect ratio/crop/reframe
  metadata, title/hook/payoff and editorial/reviewer notes;
- transcript utterances/words with absolute source times and speaker labels;
- SRT/VTT plus caption/brand intent and effective language-profile version;
- referenced B-roll/music/logo assets with license/provenance and whether each
  can legally be bundled;
- stable checksums for every included file and warnings for unsupported effects.

Generate short-lived signed downloads only after owner authorization. Prefer a
clean proxy/source reference plus small metadata/caption files; do not copy the
full source unnecessarily. Package generation is idempotent and records its
input revision so a stale package is obvious after edits.

## Phase 3: Validate FCPXML export

Start with one documented interchange format only after manifest fixtures are
stable. FCPXML is a candidate because it can cover multiple NLEs, but choose
based on interviews/real imports.

- Convert rational source time/timebase exactly; no floating-point frame drift.
- Map ordered ranges, handles, source asset, audio, markers, captions and notes
  only where the target format/version supports them.
- Represent unsupported Narriflow effects as warnings/markers or include a
  reference render; never silently omit without disclosure.
- Validate relink/import in the approved Premiere and Resolve version matrix on
  macOS/Windows paths and with representative CFR/VFR/audio fixtures.
- Keep JSON manifest the canonical Narriflow export; XML is a derived adapter.

## Phase 4: Optional review-return loop

Only after users adopt the export, consider importing a constrained review
response (final cut range or status/comment), not an arbitrary NLE project.
Require explicit file/schema validation, tenant authorization, conflict UI, and
append-only review events. Do not overwrite Studio edits automatically.

## UX and failure states

- One clear `Open in source` action on candidate review.
- `Download editor package` shows included assets, estimated size, source
  revision, supported NLEs/versions, license exclusions, and expiry.
- Progress has queued/preparing/ready/failed/expired states with retry rules
  owned by Plan 027.
- A stale package says which edit/profile/source revision changed and offers an
  explicit regenerate action.
- Relink troubleshooting uses safe filenames/checksums/timebase diagnostics, not
  internal storage keys or permanent URLs.

## Test plan

- Unit: manifest schema/version, rational time conversion, multi-range order,
  checksums, license inclusion policy, filename/path normalization.
- Media fixtures: 23.976/24/25/29.97/30/59.94 CFR, representative VFR, mono/
  stereo/multichannel, long duration, non-zero start time, Unicode filenames.
- Integration: edit during package generation, idempotent retry, expired signed
  link, deleted source, cross-tenant authorization, partial asset exclusion.
- Import matrix: validated Premiere/Resolve versions on macOS/Windows; source
  relinks, boundaries/frame counts/captions/audio match golden references.
- Browser: source jump/context expansion, package preview/progress/failure/stale
  state, keyboard/accessibility-name coverage.

## Success criteria

- At least five target editors can relink/import the package in the approved
  matrix without manually reconstructing boundaries.
- Median time from candidate to correctly linked NLE timeline meets the approved
  threshold and is lower than copying timestamps/files manually.
- Frame/audio boundaries match the source within the approved tolerance.
- Unsupported effects and excluded licensed assets are always visible.
- Handoff adoption and subsequent accept/publish outcome are measured separately.

## Done criteria

- [ ] Every candidate can jump to exact source context.
- [ ] Canonical versioned manifest includes timebase, ranges, transcript,
  captions, revisions, checksums, language/brand provenance, and warnings.
- [ ] Package authorization/expiry/tenant/license behavior is tested.
- [ ] One NLE interchange adapter passes the approved real import/relink matrix.
- [ ] No bidirectional/round-trip or effect-parity claim exceeds tested support.

## STOP conditions

- Fewer than five target editors validate the need/workflow.
- Source timebase/identity cannot be made authoritative.
- Export would bundle unlicensed media or long-lived public URLs.
- XML import cannot relink consistently across the approved minimum NLE matrix.
- The implementation hides unsupported effects or frame drift.
- Scope expands into arbitrary NLE project import or full cloud editing.
