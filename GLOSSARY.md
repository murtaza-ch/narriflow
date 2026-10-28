# Narriflow Domain Language

Narriflow turns source media into publishable short-form content through distinct intake and post-ingest processing lifecycles. This glossary fixes the language used for those domain concepts.

## Product language

Navigation and page titles name destinations. Use a page eyebrow only for changing context such as a Workspace, revision, or timezone. Keep a description only when it adds a fact, instruction, or consequence that the title and page body do not already state. User-facing errors explain what happened and how to recover without naming internal modules. Toast titles omit terminal punctuation; toast descriptions use it.

## Request admission

**Authenticated Request Policy**:
The browser-session application module that resolves signed-in App User identity and, when the declared admission requires it, one active Workspace Actor Scope. It enforces one explicitly declared capability, optionally admits an active Project and a common rate limit, sequences validation, and gives every adapter one typed request result and support identifier. Identity-only bootstrap flows never borrow authority or restrictions from an unrelated active Workspace.
_Avoid_: Auth middleware, current-user helper, generic Project middleware

**Actor Scope**:
The immutable request fact set whose actor user ID always names the signed-in person and whose Workspace ID, Workspace owner user ID, role, status, tier, and personal-Workspace state are separately named.
_Avoid_: Workspace user, effective user, owner-as-user

## Editing

**Studio Editing Session**:
One tab-local editing relationship with a clip, including its working document, history, durability, write ownership, preview eligibility, and playback position.
_Avoid_: Studio shell, editor state, editing tab

**Clip Editor Document**:
The complete revisioned edit state for one clip that can be saved to Narriflow and used to produce exports.
_Avoid_: Form state, Studio payload, edits blob

**Clip Editor Document Persistence**:
The server-side module that owns canonical post-creation Clip Editor Document storage, revision fencing, dependent database invalidation, and durable obsolete-media cleanup intent.
_Avoid_: Clip Service save helper, Studio cloud state, cleanup callback

**Clip Composition Plan**:
The immutable, versioned result of resolving one Clip Editor Document, source facts, bounded evidence, asset availability, capabilities, and up to four output targets into exact timed canvases, layers, crops, destinations, text fitting, notices, and evidence requests. Studio preview and FFmpeg translate this plan; they do not choose composition policy.
The plan does not carry render-time media facts that only one adapter can observe, such as source frame rate or a logo image's intrinsic size. Where placement depends on such a fact, the plan states a symbolic anchor both adapters late-bind, and says so at the field. A symbolic anchor is not a leak.
_Avoid_: FFmpeg filter graph, preview layout, auto-layout analysis

**Layout Evidence**:
Source-bound Automatic, Screen, or Split observations for one canonical Clip window and edited timeline. The worker owner validates durable evidence, lazily obtains one complete analysis segment, normalizes detector facts, constructs current envelopes, and publishes through revision and execution-owner fences. Preview analysis and export share original source dimensions and zoom limits; proxy dimensions never choose composition policy. Typed unavailable, failed, and disabled states remain planner inputs.
_Avoid_: Layout plan, detector payload, renderer fallback

**Layout Evidence Lifecycle**:
The service module that owns preview publication and the durable Automatic analysis queue, including renewed claim leases, editor-revision and proxy fencing, completion, retry deferral, and immediate shutdown release. Claim loss aborts the analysis through its execution signal. Workflow Attempt publication uses its own execution fence.
_Avoid_: Clip Service preview helper, analysis worker mutex

**Scene Block**:
A bounded visual insertion that occupies edited time in one Clip Editor Document and may contain video, an image, a color card, or a text card.
_Avoid_: Timeline clip, composition scene, intro file

**Censor Segment**:
A timed Clip Editor Document instruction that masks caption text, replaces source audio with a beep, or silences source audio without changing the transcript.
_Avoid_: Transcript correction, muted word, profanity flag

**Censored Words**:
The list Auto-censor scans for: one per Workspace (the built-in defaults until edited, then exactly the stored list), plus a Project's own words and the Brand Profile's blocked terms. A trailing `*` matches whole words that start with the stem. Auto-censoring a match writes a caption Censor Segment and, with a sound, an audio Censor Segment on the same word span.
_Avoid_: Profanity filter, blocklist

**Device Draft**:
The latest Clip Editor Document durably retained in the current browser but not necessarily confirmed by Narriflow.
_Avoid_: Cache, local copy, backup

**Studio Write Ownership**:
The exclusive right of one Studio Editing Session in a browser profile to change and synchronize a clip. Cloud revision checks remain the final protection when exclusivity is degraded.
_Avoid_: Workflow Attempt, worker lease, tab lock

## Processing

**Upload Session**:
A workspace-owned, durable intake record that binds one immutable browser upload intent to its declared source, frozen brand and generation settings, server-chosen transfer plan, private storage identity, exact-object verification, and exactly-once handoff to a Project and Upload Finalize Ingest Job.
_Avoid_: Upload job, multipart upload, empty Project, browser upload ID

**Workflow Run**:
A persistent execution record for one idempotent post-ingest processing stage of a project, such as transcription, moment detection, clip rendering, or dubbing.
_Avoid_: Job, task, ingest job

**Workflow Attempt**:
One exclusive, time-bounded claim to execute a Workflow Run, identified by an immutable attempt ID. Only the current Workflow Attempt may update or settle its Workflow Run.
_Avoid_: Retry, worker, lease

**Clip Render Attempt**:
One execution of a clip-rendering Workflow Attempt that owns a fixed set of requested render variants through resolution, encoding, delivery, and settlement.
_Avoid_: Render job, FFmpeg run, child attempt

**Clip Render Variant**:
One requested rendered artifact for a clip, aspect ratio, and frozen output configuration. Its outcome is tracked independently while ownership remains with its Clip Render Attempt.
_Avoid_: Output file, encode task, child job

**Render Work Set**:
The fixed membership of Clip Render Variants assigned to one clip-rendering Workflow Run. Variants created after membership is fixed belong to a later Workflow Run.
_Avoid_: Pending renders, render queue, clip group

**Frozen Rendering State**:
The canonical project, clip, entitlement, and output state a Clip Render Attempt uses for all decisions in one execution. Expiring access locations may be refreshed without changing that state.
_Avoid_: Render manifest, live project state, FFmpeg options

**Partial Workflow Outcome**:
A terminal Workflow Run outcome in which an aggregate stage produced at least one successful child artifact and at least one failed child artifact.
_Avoid_: Completed with errors, partial failure

**Waiting Workflow Run**:
A Workflow Run whose current attempt has submitted work to an external provider and released its worker while awaiting a correlated result.
_Avoid_: Running lease, stalled run

**Workflow Failure**:
A stable reason that a Workflow Attempt could not produce its intended outcome, including whether another attempt may succeed without user intervention.
_Avoid_: Exception string, error-code registry

**Ingest Job**:
A persistent execution record for bringing source media into a project before post-ingest processing begins. Its lifecycle module owns claims, progress, settlement, automatic retries, manual retry admission and the generation handoff. Job, Project and Workflow Event changes commit together. Automatic retries reuse a job with bounded attempts and backoff; a manual retry creates one new job under a separate project budget. A Google Drive Picker job also holds a sealed source credential, the picker's short-lived access token for that one file. Every terminal transition clears it, so such a job is never retried manually: the person chooses the file again.
_Avoid_: Workflow run, upload task

**Ingest Claim**:
One exclusive, time-bounded and heartbeat-renewed right to execute an Ingest Job, identified by an immutable claim ID. Only the current unexpired Ingest Claim may report progress or settle its job. Claim loss is a control signal. Graceful worker shutdown releases a claim without consuming the automatic retry budget.
_Avoid_: Workflow Attempt, worker ID, ingest status

**Ingest Generation Handoff**:
The durable obligation left by a completed Ingest Job to admit post-ingest generation using the committed Content Pack. Admission, transcript setup and handoff acknowledgment commit together, and the acknowledgment records the exact speech-to-text run the intake handed off to. Draft setup waits; transient admission failures defer; permanent admission failures settle the Ingest Job and Project with an actionable reason and durable notification intent.
_Avoid_: Generation callback, best-effort trigger, ready with no clips

**Credit**:
The unit of a Workspace's monthly Processing Usage allowance: one started minute of source video, counted per video, so a 1-second video uses 1 credit and a 61-second video uses 2. The whole source is charged whatever window is processed. Each plan includes a number of credits per UTC calendar month; they renew at 00:00 UTC on the first and don't roll over. Retrying or regenerating the same Project is free; a new import is charged.
_Avoid_: Processing minutes, minute quota, token, generation credit

**Processing Usage Reservation**:
One Workspace-owned claim on a UTC month's credits for one intake, keyed by its Project ID. It stores whole credits as seconds (multiples of 60). It is reserved at admission, resized as duration facts arrive, settled from the probed duration before speech-to-text, and released if processing never starts. Settled usage is final for its month and survives Project deletion, retention purge, and member removal; only an audited operator refund changes it.
_Avoid_: Quota row, usage counter, minutes balance, credit balance

**Processing Capacity**:
The number of a Workspace's videos in flight, derived under the Workspace usage lock from unsettled reservations plus Projects with an active Workflow Run or accepted export renders. Only intake admission is refused when it reaches the tier limit.
_Avoid_: Concurrency counter

**Operation Status**:
The transport-neutral, lineage-derived state of one accepted mutation: an intake, a generation, or an export. It reports `working`, `completed`, `partial`, `failed`, or `cancelled`, with progress, per-clip or per-format outcomes, the Project, Clip, and export IDs produced, notices about how the work was done (such as `framing_degraded`), and a typed failure code. An intake follows its Upload Session or Ingest Job into the stored generation run it handed off to; it never infers work from the Project's latest run. MCP tools, Tasks, the REST API, and Completion Callbacks read it; it carries no media URLs.
_Avoid_: Task state, project status, job status

**Captioned Video**:
A finished short, such as an AI-generated one, that Narriflow captions, frames, and exports without detecting clips. It is a caption-only generation whose settings (framing Fit or Center, caption source, export formats) are frozen in the Content Pack at acceptance. The Project gets one Whole-source Clip, and the generation's Operation Status ends with that clip's export. The export is admitted in the transaction that completes detection, so it exists exactly when the run is completed. The generation names that export and reports the first final outcome the export reached: retrying a failed export updates the export's own operation, but the generation stays as it was first announced, and deleting the export afterwards does not change it.
_Avoid_: Finish job, caption-only upload

**Whole-source Clip**:
The one clip of a caption-only generation: its processing window, or the entire source. `Clip.wholeSource` gives it the 1 to 180 second duration bounds in `clipDurationBounds`, where a detected clip stays at 10 to 120 seconds. The bounds apply wherever a clip window is checked: persistence encode and decode, the boundaries request, the ingest handoff, detection, and the Studio's trim handles.
_Avoid_: Full-length clip, source clip

**Operation Receipt**:
The durable acceptance record of one idempotent mutation. It is keyed by Workspace, acting user, canonical command, and the client's idempotency key, and it stores the input fingerprint and the accepted result. Rotating an API key or switching between MCP and REST replays the same receipt. Upload Sessions keep their own key instead; integrations derive it per user from the caller's key.
_Avoid_: MCP operation, request log

**Completion Callback**:
A signed, at-least-once notification delivered to a caller-supplied URL when one accepted operation reaches a terminal Operation Status. It carries IDs only, follows the Standard Webhooks format, and is signed with the Workspace's callback signing secret. Each acceptance registers at most one.
_Avoid_: Webhook, event stream

**Transcript Passage**:
A 30 to 60 second span of a finished Transcript, cut on utterance boundaries, with its embedding and full-text form. A worker loop builds Passages from each completed Transcript and replaces only the ones whose content hash changed; a failed embedding backs that Transcript off and never touches generation. Library search ranks Passages by meaning and by exact words after limiting them to the actor's Workspace and viewable Projects, in the same query.
_Avoid_: Chunk, snippet, search index entry

**Workspace Event**:
An append-only, versioned record in a Workspace's event feed that reports one transition that finished: an Autopilot import, an Operation Status reaching a final state, a Finishing ending, a Social Post being proposed to a Publishing Queue, a Social Post reaching an outcome, or a Standing Grant pausing or expiring. It carries IDs only, is written in the transaction that makes the transition, and is deduplicated by that transition. Its `seq` comes from a per-Workspace counter row bumped by the writing transaction, so pollers that read in `seq` order never see a gap fill in behind their cursor. Events expire after 30 days and survive Project deletion. Delivery is at least once.
_Avoid_: Workflow Event, webhook, product analytics event

**Webhook Subscription**:
A Workspace's HTTPS endpoint that receives chosen types of Workspace Event as signed, at-least-once POSTs in `seq` order. It keeps its own cursor, `lastDeliveredSeq`, which moves only after the endpoint answers 2xx, and it signs with the Workspace's callback signing secret like a Completion Callback. It is disabled with a reason after 20 consecutive failures, a 410, or when its cursor falls behind the 30-day retention; re-enabling resumes from the cursor.
_Avoid_: Callback, REST Hook, event stream

**Recipe**:
A named, revisioned set of Workspace settings: a Brand Profile (or none), the source language, the Content Pack settings, and optional Finishing. Autopilot rules require one and carry none of those settings themselves; REST and MCP intake and generation may name one with `recipeId` instead of sending the settings inline, never both. The Recipe is read when a request is accepted, after any replay lookup, and the accepted result records its ID and revision, so editing a Recipe changes the next import and never work already accepted, and an honest retry after an edit replays instead of conflicting. Browser intake fills its setup form from a Recipe and submits the form's explicit settings. Edits bump `revision` with optimistic concurrency; a Recipe an Autopilot rule uses cannot be deleted. Writes stay in the browser; REST and MCP only read Recipes.
_Avoid_: Preset, template, profile (a Brand Profile is only the branding part)

**Finishing**:
What happens after one generation completes, asked for by a Recipe (so by an Autopilot rule that uses it) or inline on a REST or MCP request: export the generation's best clips, write assisted copy for chosen platforms, then leave the Project ready to review, propose each picked clip to chosen accounts' Publishing Queues, or (for an Autopilot rule with a Standing Grant) send the finished exports to the grant's reviewers as a Review Round. The settings are one schema, frozen with the generation when it is admitted as one Generation Finishing row keyed by the generation's speech-to-text run. The generation's settlement makes the row due in its own transaction; a worker loop claims due rows with a lease, checks the plan (Pro and above) and that the acting user still has access, and ends the row `ready`, `partial` or `skipped` with a reason. Exports and copy use keys derived from the row, so a re-claim never repeats them.
_Avoid_: Auto-export, post-processing, publishing (Finishing proposes posts and never posts)

**Media Cleanup**:
The durable execution module that owns exact-key removal of unreferenced private media after an approved producer commits its database state. It owns idempotent obligation admission, provisional copy-compensation holds, fenced claims, renewal, storage outcome classification, bounded retry, settlement, and identifier-safe diagnostics. Clip Editor Document Persistence, detected Clip replacement, and Clip duplication still own the decision and transaction that create or adopt cleanup intent.
_Avoid_: Editor Media Cleanup, best-effort delete, cleanup callback

## Brand and delivery

**Workspace Billing Account**:
The durable provider identity, verified subscription snapshot, reconciliation health, retry ownership, and repair state for one Workspace. The Workspace remains the access projection; Stripe deliveries only wake current-state reconciliation.
_Avoid_: Stripe customer, billing event, subscription row

**Social Post**:
The workspace-owned product projection of one frozen publication intent, including its scheduled slot, current publication state, final link, and user-safe failure or attention outcome.
_Avoid_: Publish job, provider upload, retry row

**Publication Intent**:
The confirmed account-specific content and delivery request for one Social Post. Retrying that request preserves the same Social Post; a corrected or additional submission is a new Publication Intent.
_Avoid_: Publishing Draft, provider operation

**Frozen Publication State**:
The immutable editor revision, exact Clip Export and variant, social account, platform, caption, settings, capability version, and schedule that every attempt for one Social Post must use.
_Avoid_: Current clip, latest render, execution payload

**Posting Schedule**:
A Social Account's weekly slots, each a weekday and a local time in the Workspace time zone. A slot keeps its local time across daylight saving changes: 09:00 stays 09:00. An account without slots has no queue to accept into.
_Avoid_: Posting window (a range a bulk batch is spread across), Calendar

**Proposal**:
A Social Post in the `draft` status that names a clip, a finished Clip Export variant, a Social Account and a draft caption, and records whether a person, an integration or Finishing proposed it. It has no scheduled time, takes no slot and is never claimed for publication. A person rejects it, which cancels it, or accepts it, which converts the same Social Post in place into a scheduled one in the account's next free slot and records who accepted it. Its ID never changes.
_Avoid_: Publishing Draft (browser-local), Publication Intent (a Proposal has not been confirmed), approval

**Publishing Queue**:
A Social Account's Posting Schedule together with the Proposals waiting for it. Accepting takes the next free slot: the first slot after now that no other active Social Post for that account occupies at exactly that time, chosen under a row lock on the Social Account in the transaction that writes the post. Only a person in Narriflow accepts, or a Standing Grant a person gave; REST, MCP and Finishing can only propose.
_Avoid_: Scheduler, autopublish

**Standing Grant**:
A Workspace Owner's or Admin's standing authority for one Autopilot rule's output to go out without a click: its Proposals accepted into one Social Account's Publishing Queue (`publish`), or its finished exports sent as a Review Round to named reviewers (`review_send`). It has a daily and a weekly cap counted over the last 24 hours and 7 days, an expiry at most 90 days ahead, a status (`active`, `paused`, `expired`, `revoked`) and a revision that rises on each renewal. What goes out under it records the grant and revision as its evidence. It never weakens a Brand Profile's approval rule, never covers a TikTok account, and pauses itself when a post it accepted fails or needs attention. Only Owners and Admins create, renew, pause or revoke one.
_Avoid_: Auto-approve, autopilot permission, override (an override is a person's audited decision on one export)

**Social Publication Attempt**:
One durable, idempotent attempt to deliver a Social Post, with ordered checkpoints, bounded provider calls, retry lineage, and a terminal accepted, failed, or unknown outcome.
_Avoid_: Social Post, worker run, blind retry

**Publication Claim**:
One exclusive, time-bounded and heartbeat-renewed ownership lease for a Social Publication Attempt. Its immutable claim ID fences every checkpoint and settlement; before submission it also owns the social-account concurrency slot.
_Avoid_: Publishing status, worker ID, account lock

**Provider Receipt**:
The unique durable evidence that a provider or webhook receiver accepted one Social Publication Attempt. Receipt creation, Social Post settlement, and analytics intent creation commit atomically.
_Avoid_: HTTP 2xx, external URL, provider response

**Tracked Video**:
One directly published video whose public counts Narriflow reads back from its platform, identified by a post ID the platform itself verified (never a webhook receiver's own claim), and only while it is public. It belongs to the Workspace, not the Project, so deleting a Project or purging it by retention detaches the Social Post but keeps the captures and Clip Facts. A TikTok inbox delivery becomes a Tracked Video only once a public post is verified.
_Avoid_: Metric row, analytics post, synced post

**Performance Capture**:
One scheduled read of a Tracked Video's views, likes, comments, shares, saves, and watch time, at about 1 hour, 24 hours, 3 days, 7 days, and 28 days after publication, then no more. A worker claims it under a fenced lease and settles it once as captured or skipped. A revoked or expired grant, a removed account, or a deleted video skips it with a reason and never fails the Social Post. A count the platform does not report stays empty rather than zero, and each capture keeps the API version that produced it.
_Avoid_: Metric snapshot, sync run, analytics event

**Clip Facts**:
The virality score, category, hook strength, duration, aspect ratio, platform, and posted hour in the Workspace time zone, frozen once, in the pass that first tracks a video (within a minute of publication), and never rewritten. "What worked" groups by them after the Project is gone.
_Avoid_: Live clip scores, clip metadata

**Performance Guidance**:
What tends to work for one Workspace's audience, computed about nightly from the clips it posted from Narriflow to TikTok and YouTube Shorts in the last 180 days (Tracked Videos' Clip Facts and 7-day counts). Each video's views are divided by its own platform's median first, so platforms are never pooled, and a clip posted to several platforms counts once toward every threshold. For each category and length band it keeps a lift (the median of those ratios, pulled toward 1 as n / (n + 20) for n clips) and a sample size; only groups of at least 10 clips count, once the Workspace has at least 30. Hook strength is not a grouping, because it is already part of the score being nudged. Moment detection gets one prompt line naming the two strongest groups and the weakest; Finishing multiplies each clip's score by a factor from 0.8 to 1.25 (the mean lift of the groups the clip falls in), lets a clip overtake another only when their plain scores are within 15 points, and records the factor on the pick. It never changes the scoring scale. The Workspace setting "Use my performance data to pick clips" is null for the default (on once the data qualifies), or an explicit yes or no.
_Avoid_: Model tuning, learning, personalization

**Publication Manual Decision**:
An audited editor or operator choice to recheck the existing provider operation, confirm publication with labeled evidence, or authorize a linked new attempt despite duplicate risk. It records the actor and bounded reason without rewriting the uncertain attempt.
_Avoid_: Retry flag, status edit, fabricated Provider Receipt

**Brand Profile**:
A workspace or personal collection of reusable identity, media, writing guidance, and style presets for one brand. A Brand Template is a style preset inside this broader identity.
_Avoid_: Brand Template, client folder, workspace brand

**Visual Asset**:
A workspace or personal image or video that may be uploaded or generated, reused in Brand Profiles, and inserted into Clip Editor Documents.
_Avoid_: B-roll URL, upload file, generated output

**Scene Template**:
A reusable Brand Profile definition that creates a Scene Block, usually an intro, outro, or branded card.
_Avoid_: Brand Template, saved clip, preset video

**Brand Font**:
A licensed, uploaded font style owned by a personal or shared Workspace, reusable in Brand Profiles, caption styles, and clip text. Removing it from the Brand Kit retires it from new selections while existing clips retain their chosen style.
_Avoid_: System font, caption preset, font family

**Campaign Operation**:
One idempotent request to apply a selection-scoped action to project clips, with an outcome recorded for each selected item.
_Avoid_: Workflow Run, bulk job, campaign

**Review Round**:
An immutable client submission containing selected Clip Export revisions, guest access policy, comments, and approval decisions.
_Avoid_: Share link, project snapshot, approval request

**Download Grant**:
One short-lived private URL issued on explicit request for one finished export file, together with subtitle text derived from the export's frozen snapshot. Each request issues fresh grants; listings and status results never contain them, and audit logs record the grant without its URL.
_Avoid_: Download link (that names the signed-in export page), share link

**Editor Timeline**:
A clip's current edit written for Premiere Pro (xmeml), Final Cut Pro and DaVinci Resolve (FCPXML), or any editor (EDL): the Project's original source, cut at the ranges the render keeps, with the clip's captions as SRT. Cuts and captions come from the same render timing and cut plan as an export, so they keep the same footage and words. Scenes, overlays, and burned-in captions are not timeline layers. The source is too large to zip, so it comes as a Download Grant under the file name the timeline refers to. Frame rate, dimensions, audio, and any embedded start timecode come from the source probe measured at ingest; a Project ingested before that exists, an audio-only source, and a source whose frame rate is not a standard editor rate have no Editor Timeline. Each cut sits at its edited time rounded once, so frame rounding never accumulates against the captions.
_Avoid_: Project file, render, export (an Editor Timeline renders nothing)

**Generated Media Job**:
One metered provider request that may produce a Visual Asset after moderation and usage settlement.
_Avoid_: Workflow Run, image task, generation credit

**Publishing Draft**:
An unfinished browser-local publishing composition scoped to one signed-in actor, Workspace, Project, Clip, and destination account. It preserves editable copy, settings, cover identity, and scheduling choices; it is separate from Studio’s Device Draft and from a durable submitted Social Post.
_Avoid_: Device Draft, Social Post, provider inbox draft

**Publishing Composition Session**:
The actor's ongoing publishing work within one Workspace and Project, including Publishing Drafts, unresolved submissions, and accepted destinations. An unresolved submission retains its identity until its outcome is known.
_Avoid_: Studio Editing Session, Social Publication Attempt

**TikTok Inbox Delivery**:
Delivery of a frozen clip video to a connected creator’s TikTok inbox, where the creator completes publication. Delivery settles the Social Publication Attempt as Sent to TikTok without a published event. Later verified evidence may report zero, one, or multiple public posts from that upload.
_Avoid_: Published, automatic publication, failed delivery while awaiting the creator
