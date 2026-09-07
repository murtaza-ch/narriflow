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

**Scene Block**:
A bounded visual insertion that occupies edited time in one Clip Editor Document and may contain video, an image, a color card, or a text card.
_Avoid_: Timeline clip, composition scene, intro file

**Censor Segment**:
A timed Clip Editor Document instruction that masks caption text, replaces source audio with a beep, or silences source audio without changing the transcript.
_Avoid_: Transcript correction, muted word, profanity flag

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
A persistent execution record for bringing source media into a project before post-ingest processing begins.
_Avoid_: Workflow run, upload task

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

**Frozen Publication State**:
The immutable editor revision, exact Clip Export and variant, social account, platform, caption, settings, capability version, and schedule that every attempt for one Social Post must use.
_Avoid_: Current clip, latest render, execution payload

**Social Publication Attempt**:
One durable, idempotent attempt to deliver a Social Post, with ordered checkpoints, bounded provider calls, retry lineage, and a terminal accepted, failed, or unknown outcome.
_Avoid_: Social Post, worker run, blind retry

**Publication Claim**:
One exclusive, time-bounded and heartbeat-renewed ownership lease for a Social Publication Attempt. Its immutable claim ID fences every checkpoint and settlement; before submission it also owns the social-account concurrency slot.
_Avoid_: Publishing status, worker ID, account lock

**Provider Receipt**:
The unique durable evidence that a provider or webhook receiver accepted one Social Publication Attempt. Receipt creation, Social Post settlement, and analytics intent creation commit atomically.
_Avoid_: HTTP 2xx, external URL, provider response

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

**Campaign Operation**:
One idempotent request to apply a selection-scoped action to project clips, with an outcome recorded for each selected item.
_Avoid_: Workflow Run, bulk job, campaign

**Review Round**:
An immutable client submission containing selected Clip Export revisions, guest access policy, comments, and approval decisions.
_Avoid_: Share link, project snapshot, approval request

**Generated Media Job**:
One metered provider request that may produce a Visual Asset after moderation and usage settlement.
_Avoid_: Workflow Run, image task, generation credit
