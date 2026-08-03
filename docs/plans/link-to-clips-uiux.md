# Link → Clips UI/UX Restructure (Vizard-mirror) — v3

**Status:** Revised through two adversarial review rounds (Opus deep-review + Codex `gpt-5.6-sol`, both code-verified, both re-run on the revision). Opus: approve conditional on the Phase 0 amendments now folded in. Codex: blocking items were all Phase 0 contract gaps, addressed below. Plan only — no implementation yet.
**Scope:** UI/UX for the full link→clips journey: import entry → configure → processing → clips results, mirroring Vizard's flow in Blueline. A small, explicit backend contract (Phase 0) exists because both reviewers found the pure-UI framing of v1 unsound.
**Evidence:** Live Vizard walkthrough (2026-07-28, free workspace, 20:30 YouTube video imported end-to-end) + codebase map + two independent code-verified reviews.

**v2 → v3 changes (confirmation-round findings):** Phase 0 rewritten as a rigorous contract — ordering invariant stated verbatim; transactional run-claim shared by both transition paths; P2002 loser returns the winning run; runs bound to an immutable `contentPackId` (workers stop reading "latest pack" mid-run); `triggerGeneration`'s own pack-creation path refactored to reuse the committed pack; one-draft-per-project unique constraint with latest-pack-overall read semantics; durable client commit token with DB uniqueness (URL match is only a soft confirm); Step-1 writes are one transaction; client-probed durations are advisory-only and never persisted; mid-flight quota state derived at render, not a sticky flag; named schema work (`clipLengthPreset`, default ratio, draft flag, `contentPackId`, commit token). Step 2 gets an explicit SSE subscription contract. Phase 2a notes the caption-only render queueing swallow that must be fixed for reliable completion. Phase 2b ledger upgraded to claim/lease + provider idempotency key, with `IngestJob`-keyed failure emails. Phase 3 makes tabs URL-driven in core and computes rank server-side.

**v1 → v2 changes (review-driven):** added Phase 0 sequencing contract (C1/C2); brand template stays at Commit (C3); honest cost copy — trim does *not* reduce billing (C4, Codex#2); hard pre-flight + over-cap state for ingest-first (C5); Step-1 draft persistence for refresh safety (M1/M2); Step-2 ingest-failure surface (M3); stage-words-only ingest progress, "estimated" STT % (M4, Codex#4); worker payload counts deferred (M5); keep SSE throttle, shared provider (M6); clip-length single-select (M7, Codex#7); mode-aware completion matrix incl. caption-only (M8, Codex#5); publish deep-link scoped with URL tabs or deferred (M9, Codex#8); state matrix (M10); email split into its own sub-phase with durable ledger (M11, Codex#6); Phase 1 is link-only (Codex#9); compact rows + density option (Codex#10); no solid button per row (Codex#11); immutable rank (Codex#13); `PlanLimitNotice` extraction noted (Codex#14); verification expanded (Codex#12); stale `_lib/status.ts` ref fixed.

---

## 1. What Vizard does (observed, end to end)

### Stage A — Entry (workspace home)
- Hero band: "Turn your long video into **Viral Clips**", one paste field + solid `GET CLIPS` button. Secondary methods (Upload local file / Import from Zoom / Record video) are small ghost chips *below* the field — the link path is the hero.
- Focusing the field shows a provider tooltip: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.
- Submitting navigates to a dedicated, chrome-free `/upload` page (no sidebar — a focused funnel).

### Stage B — Commit screen (`/upload`, step 1)
Single centered column, four rows, one CTA:
1. **Metadata card**: thumbnail + video title + `1080p` badge + duration chip (`20:30`) that opens a "Select process duration" popover — dual-handle range slider + editable start/end timecodes. Trimming reduces the credit cost (in *Vizard's* pricing model).
2. **Language** select ("Auto detect language" first).
3. **Get AI clips** toggle (on).
4. **Model** select: v1 "Faster, more clips…" (✦20) vs v2 "AI will think longer… Fewer clips, more complete." (✦25) — cost shown per option.
- CTA: **`Upload   ✦ 20`** — cost on the button, updating live with model/trim. Below: "Have subtitles? Upload TXT, SRT, or DOC".
- Clicking Upload **immediately starts the import and deducts credits** (60 → 40 observed).

### Stage C — Configure while importing (`/upload`, step 2)
The page swaps to clip settings **while the video downloads in the background**; a compact pill at top shows thumb + title + "Uploading… 0%" and quietly completes.
- **Ratio** select: 9:16 free; 1:1 and 16:9 premium-gated.
- **Clip length**: multi-select checkboxes — Any / <30s / 30s–60s / 60s–90s / 90s–3mins / >3mins.
- **Template gallery**: tabs Featured / My template / Brand template (premium); horizontally scrollable 9:16 preview cards (Default, Modern, Bouncy, Mr. Beast, Business, …) with live caption-style previews; selected card gets a check badge.
- Checkboxes: Add emojis ✓, Highlight keywords ✓, Add B-rolls (premium), Remove silences, Auto-censor.
- **Find clip moment** (optional) free-text: "For example: When Sam talks about GPT-5."
- **Schedule clips** toggle.
- CTA **`Get AI clips`** sits in a spinner state until the background import finishes, then proceeds. Zero dead waiting.

### Stage D — Processing
Dedicated full-screen state (same route), centered column:
- Compact metadata card on top.
- Headline: **"You can safely leave this page. We'll email you when clips are ready"** + "Do not notify." opt-out link.
- Substantive status line that changes with real progress: "Analyzing content and finding clips." → **"10 clips found, editing for best framing."**
- Human-named checklist with live % on the active node: Upload ✓ → Create project ✓ → Process video ✓ → Finding best parts…67% → Edit clips → Finalize.
- Right panel: 6-slide auto-advancing tutorial carousel.
- On completion, auto-redirects to `/project/:id`.

### Stage E — Clips results (`/project/:id`)
- **Top bar**: back, project title, "Edit original video", Share, overflow, Upgrade.
- **Left rail**: numbered thumbnail jump-list (1–10).
- **Bulk bar**: Select all + Publish / Download / Edit clips / Delete + Filter icon.
- **Toolbar**: "10 clips" + sort select ("Highest score").
- **Clip rows** — each: 9:16 player (quality select 720p/1080p-premium) left; `#rank` + title, **huge virality number** (9.5), actions (Publish, Download, share, duplicate, cut), **"Viral reason"** one-sentence callout, timecoded transcript excerpt right; hover 👎 / ⭐.
- **Filter panel**: Clip type, Ratio, Publish status, Label (Ready to share / Starred).
- Sticky footer: "Remove watermark" (free plan).

### Why this flow converts
1. **Time-to-value is masked**: ingest runs during configuration.
2. **Cost transparency**: price on the CTA, updating with choices.
3. **Progressive commitment**: each screen has exactly one primary action.
4. **The wait is honest and escapable**: named steps, live %, outcome counts, permission to leave, email.
5. **Results open with judgment, not inventory**: rank + score + reason → triage, not preview-everything.

---

## 2. Current Narriflow vs Vizard (gap table)

| Journey stage | Vizard | Narriflow today | Gap |
|---|---|---|---|
| Entry | Hero paste → focused funnel page | Dashboard hero paste → `/upload?url=` (sidebar retained); no metadata fetch | Medium |
| Commit | Metadata card, trim popover, cost-on-CTA, instant ingest start | One long two-column form; ingest starts only on final submit; no quota display on `/upload` | **High** |
| Configure | Runs *during* ingest; visual template gallery; length multi-select | All configuration before any work starts; caption preset invisible in clip mode; template picker is a plain select | **High** |
| Processing | Dedicated checklist, live %, outcome counts, leave-safe + email | Form with disabled "Transcribing…" button; % buried in Activity feed; no ETA; no email | **High** |
| Results | Ranked rows, big score + reason visible, sort, bulk, jump rail | 3-col grid; reasoning behind "Details"; no sort; no bulk select; publish in separate tab | **High** |

Corrected framing (v1 overstated this): the backend has the right *pieces* (`queueLinkIngest` / `prepareGenerationContext` / `triggerGenerationIfPending` are separate; workers emit progress over SSE; clips persist scores + reasoning + transcript slices), but the pieces do **not** compose into ingest-first sequencing today. `triggerGenerationIfPending` is invoked from exactly one place — ingest completion (`project.service.ts:2977`) — so a ContentPack written *after* ingest finishes is never consumed; the trigger uses a random idempotency key (`:3344`) so concurrent triggers can double-run; and `persistDetectedClips` deletes all project clips before re-inserting (`clip.service.ts:271`), making a double-run destructive. Phase 0 exists to fix exactly this, and nothing more.

---

## 3. User stories

**Import entry**
1. As a creator with a YouTube link, I paste it on the dashboard and land in a focused import flow that already fetched title, thumbnail, and duration, so I know I got the right video before spending anything.
2. As a free-plan user, I see *before committing*: how many minutes this import will count against my plan (when the duration is knowable), how many I have left, and a hard stop if the source exceeds the per-upload cap — with honest copy that the check is advisory until import completes for providers whose duration we can't probe.
3. As a user importing a long video, I can narrow the processing window with the trim slider, understanding (per the label) that trimming narrows *what we analyze*, not what's charged.
4. As a user whose import turns out to exceed my per-upload cap (non-probeable provider), I get a clear over-cap state on the project page — reason, trim/upgrade options, and "delete this project to reclaim the minutes."

**Configure while importing**
5. As a user who just committed an import, ingest starts immediately and I configure clip settings while it downloads.
6. As a user choosing caption style, I pick from a visual gallery of caption presets rendered as 9:16 preview cards — in AI-clipping mode too, not just caption-only. (My *brand template* is chosen at commit, where it actually takes effect.)
7. As a user with a specific moment in mind, I type it into a prominent optional "Find clip moment" field.
8. As a user who finishes configuring before ingest completes, the CTA shows a working state and generation starts automatically the moment ingest is done; if I finish *after* ingest completed, generation starts instantly. Refreshing or coming back later resumes exactly where I was.
9. As a user whose ingest fails while I'm configuring, I see the failure with a plain-language reason and a Retry button right there — never an infinite spinner.

**Processing**
10. As a user waiting for clips, I see a human-named checklist — Import ✓ → Transcribe (est. 43%) → Find best moments → Wrap up — with stage-appropriate status lines, so the wait feels accounted for.
11. As a busy user, the processing screen tells me I can safely leave, and (Phase 2b) I get one email with a deep link when clips are ready — or a different one if nothing clip-worthy was found or the run failed.
12. As a user whose run finds zero clips, I see a distinct "no clip-worthy moments found" state with my options (adjust settings, re-run, trim differently) — not a silent failure.

**Clips results**
13. As a user opening results, I see clips ranked #1…#N by virality, each with a big score and a one-line clamped "Why this clip", so I triage in seconds.
14. As a user evaluating a clip, I expand its timecoded transcript next to the player and jump between clips via the numbered rail.
15. As a user done triaging, I select several clips and render them in one action (existing 50-id render API); bulk download/delete come later.
16. As a user sorting differently, I re-order by score, duration, hook strength, or timeline — while each clip's `#rank` stays its immutable virality rank.
17. As a caption-only user, I see a single "Captioned video" row — no rank, no score, no "why" — with download/publish actions.

---

## 4. The plan

All UI in Blueline: porcelain/graphite neutrals, **one solid ultramarine button per view** (no exceptions in this plan — see Phase 3), `layerStyle="well"`/`MediaWell` for footage, drawn rules + 3px status stripes instead of lifted cards, `textStyle="eyebrow"` labels, mono timecodes (`fg.timecode`), `animation="meter-fill"` for progress. Bulk bars and plan banners are rule-bound bands, not `panel` floats. We mirror Vizard's *structure and sequencing*; Blueline supplies the skin. No pricing-model change (minutes stay minutes).

### Phase 0 — Sequencing contract (backend prerequisite; the approval gate)

Both reviewers found the ingest-first split unsound without this contract, and both re-reviews sharpened it. This is the load-bearing section: implement it exactly.

**0.1 The ordering invariant (state it in code comments, verbatim):**
> *Finalize commits the ContentPack **before** reading `ingestStatus`. The ingest worker commits `ingestStatus = ready` **before** reading the ContentPack.*

With both sides committing their write before reading the other's, at least one of the two transition paths always observes both facts and claims the run. The worker already satisfies its half (`completeIngestJob` commits at `project.service.ts:2938-2966`, reads the pack at `:3320`). "Atomic persist-and-trigger" in one Prisma interactive transaction is explicitly **not** the design — `triggerGeneration` opens its own transaction (`:1725-1840`) and must not be nested.

**0.2 One idempotent, transactional run-claim shared by both paths.**
- `finalizeGenerationSetup(projectId, packInput)` (new service call, used by the web CTA): commit the pack (draft → committed, see 0.3), then read `ingestStatus`; if `ready`, attempt the run-claim. Returns `{ started, ingestStatus, workflowRunId? }`.
- `completeIngestJob` attempts the same run-claim via `triggerGenerationIfPending`.
- The claim: create `WorkflowRun` with deterministic idempotency key **`auto:${projectId}:${contentPackId}`** (replacing `randomUUID()` at `:3344`), relying on the existing `@@unique([projectId, idempotencyKey])`. **The loser of a concurrent claim gets P2002 and must catch it and return the existing run as success** — web path must not 500, worker path must not swallow-and-stall. Gate test: two concurrent claims → exactly one `WorkflowRun`, both callers return the *same* `workflowRunId`, neither throws.
- **Refactor `triggerGeneration`'s internal pack creation**: today it can create another ContentPack; under this contract it must *reuse* the committed pack it was claimed with — never mint a new one.

**0.3 Runs bind to an immutable pack; drafts are constrained.**
- `WorkflowRun` gains **`contentPackId`**. Detection reads the run's bound pack — not `getLatestContentPack(projectId)` (`detect-clips.ts:1047`) — so a draft written mid-run (user reopens Step 2) can never swap an active run's settings.
- Draft rows: `ContentPack.draft` boolean + **partial unique index: at most one draft per project**. Step 1 upserts the draft; Step 2 finalize flips it to committed (idempotent — repeated Configure updates, never inserts; fixes the always-insert at `:3272`).
- Read semantics everywhere: take the latest pack overall and **stop if it is a draft** (filtering drafts out first could silently select an older committed pack and run with stale settings). Applies to `triggerGenerationIfPending` (`:3320-3327`), the project page read (`page.tsx:283`), and any other `getLatestContentPack` caller. Migration backfills all existing rows as committed.

**0.4 Commit (Step 1) idempotency and atomicity.**
- A **durable client commit token** (UUID minted when Step 1 renders) stored on `Project` with a unique constraint — concurrent double-submits collapse in the database, not in the UI. A same-URL recent import is a *soft* confirm ("You imported this 12 minutes ago — continue that import?"), never a hard block: re-importing the same video with different settings is legitimate.
- Step 1's writes — project, ingest job, draft pack — happen in **one transaction** (today `queueLinkIngest` creates project and job separately; the draft joins them).

**0.5 Quota pre-flight, honestly scoped.**
- Client-probed durations (YouTube IFrame API, `upload-shell.tsx:370-377`) are **advisory UI only**: they drive the cost line, the disabled CTA, and the trim hint. They are user-controllable input — **never persisted as `sourceDurationSeconds`, never passed as authoritative to the server, never relax the post-ingest enforcement** at `assertProjectGenerationAllowed` (`:1713-1722`), which remains the hard gate. `linkIngestSchema` gains no duration field.
- Server-side commit check stays `assertWithinQuota(userId)` but with the `blockAtLimitWithoutRequest` semantics documented in the UI copy: "usage is confirmed after import."
- Post-ingest over-cap state (project page): reason + trim/upgrade options + "delete this project to reclaim the minutes" (usage is a live aggregate; `deleteProject` exists at `:1102`).

**0.6 Mid-flight quota failure surfaced, not stickied.** `completeIngestJob` swallows `QuotaExceededError` today (`:2976-2992`). Rather than a persistent flag with undefined clearing, the processing panel **derives** the state at render: latest run-claim error code + live usage. It self-clears on upgrade, month rollover, or a successful re-run.

**0.7 Named schema work (one migration):** `ContentPack.draft` (+ partial unique), `ContentPack.clipLengthPreset`, default render ratio (`ContentPack.defaultAspectRatio`), `WorkflowRun.contentPackId`, `Project.commitToken` (unique), project notify flag (used by Phase 2b). Neither `clipLengthPreset` nor a default ratio exists in Prisma today — this is where that lands.

Everything below assumes Phase 0. No other backend work is smuggled in; where a UX idea needs more backend, it's marked **deferred** with its real scope.

### Phase 1 — Split the import into Commit → Configure (**link path only**)

File upload and RSS keep their current flows untouched this phase (Codex: ship the link state machine first, observe, then decide parity). RSS explicitly stays one-shot (episode select → single submit).

**Step 1 · Commit** (single centered column; minimal focused-layout variant of the app shell — sidebar suppressed, slim top bar with logo + usage meter; this minimal chrome ships in Phase 1, fuller funnel polish in Phase 4):
- Metadata card: thumbnail, editable title (prefilled via YouTube oEmbed; becomes project title), provider eyebrow, duration chip.
  - Non-YouTube providers: neutral "details appear after import" card; still commit-first, with the advisory-quota copy below.
- Duration chip opens the existing `ProcessingTimeline` dual-handle slider as a popover. **Copy (per review):** "Narrows what we analyze for clips. Your plan is charged for the full source length." The "Credit saver" badge is **removed** from this control (it's false today); if processed-window billing is ever adopted, that's a separate pricing proposal.
- **Brand template picker stays here** (ingest-time input: `queueLinkIngest` freezes `brandSnapshot` at `:2250-2268`). Keep the current select this phase; the visual gallery in Step 2 is for *caption presets* only.
- Language select + Mode segmented control (existing components).
- CTA: **`Import & continue`** with a cost line *under* the button, not on it (honest variant of Vizard's pattern):
  - Duration known: `Counts ~21 min against your plan · 43 of 60 min left`.
  - Duration unknown: `Usage confirmed after import · 43 of 60 min left`.
  - Over per-upload cap (known): CTA disabled + shared `PlanLimitNotice` (extract from `projects/[projectId]/page.tsx:229` into a shared component) with trim hint or Upgrade link.
  - Quota errors from the action arrive as **typed results**, not thrown errors (copy the pattern from `projects/actions.ts:160-186`), so specific copy survives production redaction.
- On click: one transaction creating project + ingest job + draft pack, keyed by the client commit token (Phase 0.4) → advance in-place to Step 2 (`?project=<id>`; loader validates ownership and state — no existing run — and rehydrates the draft, making refresh/back/return-later all resume correctly). Same-URL recent import → soft "continue that import?" confirm, never a hard block.

**Step 2 · Configure** (same route; compact import pill pinned on top):
- Pill: thumb + title + **stage words** from existing lifecycle states — Queued → Downloading → Normalizing → Ready (ingest emits milestones 5/40/75/100 only; a live download % and link-cancel are **deferred** — real worker/yt-dlp work, not UI).
- Settings bands, Vizard's order, Blueline style:
  1. **Clip length** — **single-select** chip row (Auto / <30s / 30–60s / 1–2m / 2–3m): a visual upgrade of the existing preset select, same semantics. True multi-select duration *bands* cannot be represented by the single min/preferred/max range (`content-pack.ts:117-162`) — **deferred** as a backend proposal (schema + detection prompt + post-filter + tests). Persist the chosen preset (fixes the `clipLengthPreset` round-trip loss).
  2. **Caption preset gallery** — horizontal scroll of 9:16 preview cards rendered with the shared cue model (`CAPTION_CHUNK_SIZE`, `CAPTION_POSITION_Y_DEFAULTS` — never fork). Selected card = check badge + accent border. Shown in **both** modes (caption preset genuinely flows into clip-mode renders via `clip.service.ts:258-268` — UI-only fix, confirmed by review).
  3. **Aspect ratio** — segmented 9:16 / 1:1 / 16:9 / 4:5, persisted as the default render ratio so "Render clips" pre-selects it.
  4. **Toggles row** — Auto-hook, Auto-render after detection (promoted from Advanced).
  5. **Find clip moment** — promoted `specificMoments` textarea with example placeholder.
  6. **Advanced** disclosure — platform targets, clip count, tone (unchanged).
- CTA: **`Get AI clips`** → `finalizeGenerationSetup` (Phase 0.2):
  - `{ started: true }` → route to project page (processing state).
  - `{ started: false, ingestStatus: "running" }` → "Waiting for import…" working state. **Subscription contract:** Step 2 subscribes to the project's existing SSE stream (`/api/stream/[projectId]`, via the shared provider from Phase 2a); on an ingest terminal event it re-invokes the idempotent finalize action — success routes forward, so the button always resolves. (The worker-side trigger usually wins the race; the re-invoke is the client's guarantee either way.) SSE failure fallback: the stream's existing 15s DB-poll fallback covers it.
  - `{ started: false, ingestStatus: "failed" }` → inline failure band: plain-language reason (`userErrorMessage`), **Retry import** (existing `retryFailedIngest` action), and "Save settings and finish later".
- Abandonment after Step 1: project exists with ingest running; the project page shows a "Finish setup" banner deep-linking to `/upload?project=<id>` Step 2. Minutes are spent at commit (explicit product decision); deleting the project reclaims them (usage is a live aggregate) — the over-cap and abandonment states say so.

### Phase 2a — A real processing state (UI only)

On `/projects/[projectId]`, while a generation run is in flight, the Clips tab renders a **Processing panel** instead of step cards:
- Centered column: compact metadata card; headline **"You can safely leave this page — progress continues in the background."** (The email sentence joins in Phase 2b.)
- **Checklist stepper** (vertical, hairline connectors; the header's horizontal `PipelineStepper` stays): Import → Transcribe → Find best moments → *(Render — only when auto-render is on or mode is caption-only)* → Done.
  - **Mode-aware completion matrix (per review):** clip mode without auto-render completes at "Clips found — previews are finishing" (previews come from a separate poller, `clip.service.ts:946`); clip mode with auto-render completes after the render run; caption-only completes after its mandatory 16:9 render and the panel copy says "captioned video", not "clips". **Prereq fix:** caption-only's render is queued inside a swallowed try/catch today — the queue failure must propagate (or be durably retried) or the caption-only checklist can wait forever on a render that was never enqueued.
  - Active node: accent + mono % where the backend provides one — STT % is elapsed-time based, so label it `est.` (e.g. `est. 43%`); ingest node uses stage words only. Substantive counts ("12 moments found") are **deferred**: event payloads need validator + `WorkflowEvent` column + publisher/replay + SSE changes (M5/Codex#4) — not this phase.
- **SSE**: keep the existing 5s `router.refresh()` throttle (it prevents refresh storms; events already reach client state instantly). Lift the `EventSource` consumer from `project-events.tsx` into a shared client provider so the checklist subscribes to live events directly without a second connection and without extra refreshes.
- **State matrix** (each row = required UI, all using existing components where noted):
  | State | UI |
  |---|---|
  | Ingest failed | Danger band + reason + Retry (existing `RetryIngestButton`) inside the panel |
  | Retry limit reached | Existing "Start a new import" copy, in-panel |
  | Zero clips found (`no_clips_detected` — a terminal *failure* today, `detect-clips.ts:1288`) | Distinct empty state: "No clip-worthy moments found" + adjust-settings / trim / re-run actions; never the generic failure band |
  | Quota crossed mid-flight (Phase 0.6 flag) | "Monthly limit reached during processing" + Upgrade link |
  | Partial render failures | Per-clip failure chips in results (existing), summary line in panel |
  | Source purged post-retention | Existing info band |
  | Concurrent imports | Allowed; each project has its own panel (no special UI) |
- "Do not notify" toggle renders in Phase 2a but persists the flag for 2b.

### Phase 2b — "Clips are ready" email (own sub-phase; it's a subsystem, not a template)

- **Scope (per both reviews):** worker gains the `packages/email` dependency (currently absent from `apps/worker/package.json`) + env; a durable notification ledger keyed `(projectId, sourceId, outcome)` where `sourceId` is the `WorkflowRun` id for generation outcomes and the **`IngestJob` id for import failures** (no run exists then). Send-once needs more than `sentAt`: a **claim/lease** on the ledger row (pending → claimed → sent, lease expiry for crashed senders) plus the provider **idempotency key** (Resend supports one) so a crash between send and record can't double-deliver. Per-project notify flag (Phase 0.7 migration); nullable `User.primaryEmail` → skip + log; failure email only after retry exhaustion, not transient requeues; no-op with a warn log when `RESEND_API_KEY` is unset.
- **Three templates**: clips ready (N clips, deep link), no clips found (with suggestions), import/generation failed (reason + retry link).
- Opt-out: the per-project "Do not notify" flag; account-level default can follow later.

### Phase 3 — Results as ranked rows

Restructure `ClipsPanel` from grid to **ranked rows**, with density discipline (Codex: don't regress triage at 30 clips):
- **Toolbar**: `N clips` mono stat + **sort select** (Virality / Hook strength / Duration / Timeline order) + **density toggle (Comfortable / Compact)** + filter popover (Duration, Score band, Ratio-rendered, Status, Category — mostly re-housed existing filters). `#rank` is the **immutable virality rank, computed server-side** as the clip's position in `viralityScore desc, index asc` ordering and delivered with the clip data — note `Clip.index` itself is *timeline* order (`persistDetectedClips`), so rank must never be derived client-side from array position, or any other sort renumbers it.
- **Tabs become URL-driven in this phase's core** (`?tab=`): project tabs are uncontrolled today, and row-Publish switching to the Publish tab requires controlled state anyway. Clip *preselection* (`&clip=<id>` + `initialClipId` in the scheduling panel) stays in the deferred bundle.
- **Left jump rail** (≥xl): numbered thumbs, sticky, scrollspy; hidden below xl (mobile gets the toolbar count + sort only).
- **Row anatomy** (hairline separators + 3px status stripe; compact by default):
  - Left: `MediaWell` player in selected ratio + duration chip + ratio pills.
  - Right: `#rank` eyebrow + title (→ Studio); big mono virality score with five sub-scores on expand; **"Why this clip"** callout **clamped to 2 lines** (expand on click) — visible by default; transcript slice **collapsed by default** (first line + expand), mono timecodes; unbounded reasoning/transcript never push actions off-screen.
  - Action row — **all outline/ghost** (Blueline: the view's single solid button lives in the toolbar as the selection-level primary, e.g. `Render selected`): Publish (outline; disabled with tooltip until the clip has a rendered asset — publish requires renders, `social-scheduling-panel.tsx:68`), Download/Render per current logic, Accept/Reject, overflow (Duplicate, Edit boundaries).
  - Caption-only projects: single "Captioned video" row — no rank/score/reason (detection writes a pseudo-clip with `viralityScore: 1`; ranked framing would be nonsense).
- **Bulk actions this phase: Render selected only** (existing 50-id API). **Deferred with real scope listed:** bulk accept/reject (needs bulk-status validator/service/API — today accept/reject is single-clip), bulk download/zip (new endpoint), delete clip (new endpoint), Publish clip-preselection (`&clip=<id>` + `initialClipId`). Until then, row-Publish navigates to `?tab=publish` unfiltered.
- Keep: score-band coloring, outside-range warning, render-state pills, free-plan 720p/watermark note as a rule-bound sticky footer band.

### Phase 4 — Entry polish + funnel chrome
- Dashboard hero: provider icon row under the paste field; secondary methods as ghost chips below (mirroring Vizard's hierarchy).
- `/upload` funnel chrome finished (Phase 1 ships the minimal version).
- "Source guidance" band collapses behind a disclosure on Step 1 (deliberate deviation — retention-saver Vizard lacks).
- **Decide here, informed by Phase 1 telemetry:** whether the file-upload path adopts the two-step shell (it's a distinct resumable-multipart flow whose settings attach at finalization — real work, not a re-skin) and whether RSS ever gets multi-episode commit semantics.

### Explicit non-goals
- No Studio/editor, dubbing, repurpose changes.
- No pricing-model change; no processed-window billing (separate proposal if ever).
- No schedule-clips-at-import toggle.
- No visual cloning of Vizard (gradients, emoji badges, tutorial carousel → replaced by one quiet "what happens next" explainer band).

---

## 5. File touchpoints

| Area | Files |
|---|---|
| Phase 0 contract | `packages/services/src/project.service.ts` (`finalizeGenerationSetup`, deterministic trigger key, draft handling, quota pre-flight, mid-flight quota flag), `packages/db` migration (draft flag / notify flag), `packages/validators/src/content-pack.ts` |
| Entry | `apps/web/app/(app)/dashboard/dashboard-client.tsx`, `dashboard-view.tsx` |
| Import shell | `apps/web/app/(app)/upload/page.tsx`, `upload/_components/upload-shell.tsx` (decompose into step components), `video-preview.tsx`, `clip-settings-form.tsx`, `brand-template-picker.tsx`, `_shared/processing-timeline.tsx`, `upload/actions.ts` (two typed-result actions) |
| Shared quota UI | extract `PlanLimitNotice` from `projects/[projectId]/page.tsx` into a shared component; usage read endpoint via `billing.service.ts` |
| Processing panel | `projects/[projectId]/page.tsx`, `project-events.tsx` (→ shared SSE provider), `apps/web/lib/project-state.ts` |
| Email (2b) | `packages/email` (3 templates), `apps/worker` (dep + completion hooks + ledger), migration |
| Results rows | `projects/[projectId]/clips-panel.tsx`, `clip-card.tsx` → `clip-row.tsx`, `render-clips-button.tsx` |

## 6. Verification

- `bun run typecheck`, `bun run test` (note: `apps/web` test script is a no-op — service-level tests carry the weight; add them in `packages/services`).
- **Phase 0 service tests (approval gate):**
  1. Ingest completes, *then* `finalizeGenerationSetup` → run starts (v1's broken path).
  2. `finalizeGenerationSetup` first, ingest completes after → exactly one run.
  3. Two concurrent run-claims → exactly one `WorkflowRun`; **both callers return the same `workflowRunId`; neither throws** (P2002 loser recovers).
  4. Repeated Commit (same commit token, concurrent) → one project. Repeated Configure → one committed pack, updated in place.
  5. Draft pack never auto-fires generation; latest-pack-is-draft → trigger stops (does *not* fall back to an older committed pack).
  6. A run's detection reads its bound `contentPackId`; a draft written mid-run does not change the running config.
  7. `triggerGeneration` under the claim reuses the committed pack — no second ContentPack row appears.
  8. Client-supplied duration cannot bypass the post-ingest cap (`assertProjectGenerationAllowed` blocks regardless of what the UI showed).
  9. Quota crossed mid-flight → panel state derivable (claim error code + live usage), and it clears after upgrade/rollover/re-run.
  10. Notification ledger (2b): worker retry does not double-send; crash between send and record does not double-deliver (lease + provider idempotency key).
- **UI review via `/dev-preview` harness:** Step 1 (with/without quota headroom, over-cap, unknown-duration provider), Step 2 during live ingest, Step-2 ingest-failure band, refresh at every transition, processing checklist per mode (clip / clip+auto-render / caption-only), zero-clips state, results rows at **30 clips** with long reasoning/transcripts + missing previews + mixed render states, unrendered-Publish tooltip, bulk render selection, keyboard selection, mobile widths, dark mode (`studio.*` chrome on players).
- One real end-to-end link import against the worker on a short public video.
