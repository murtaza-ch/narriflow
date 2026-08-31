# Vizard-inspired expansion completion evidence

Evidence captured on 31 August 2026 against fixed base revision
`8e2e7056d88502a360522f4748556595b10209a3` through the final integrated
branch revision.

**Release decision: not ready for cutover.** Ticket 18 remains in progress. A
connected local Business flow, passing repository gates, and probed four-ratio
media do not prove the two-profile agency journey, generated video, deployed
rollouts, provider delivery, full plan/status compatibility, live REST/MCP
clients, or release metrics.

## Acceptance matrix

“Partial” is not acceptance. Only a Proven row may be checked in the ticket.

| Ticket 18 requirement | State | Evidence | What remains |
| --- | --- | --- | --- |
| One Business journey from two Brand Profiles through editing, Review changes/resubmission/approval, copy, thumbnail, and scheduling | Partial | A connected Business QA path used a real OpenAI still, censor/motion/Scene edits, one immutable four-ratio revision-8 export, Round 3 changes, Round 4 resubmission/approval, real assisted copy, durable thumbnail/frame preparation, exact approved-export scheduling, reload, and cancellation | Run the missing two-governed-profile and selection-scoped brand/scene portion, then observe final supported-platform provider delivery rather than cancelling the QA post |
| Censor, motion, generated image, and generated video match Studio preview and exported media | Blocked | Censor, motion, Scene, and generated-image edits were inspected in Studio; all four corrected revision-8 outputs were downloaded and ffprobed as H.264/AAC at the requested dimensions and consistent 25.22-second duration | Generated video has no approved adapter or production evidence; run the full preview/export comparison again with generated video after its provider gate opens |
| Existing projects, Brand Templates, share links, direct Instagram, Calendar, exports, API, and MCP remain compatible | Partial | Additive migrations, the Vizard disposable-schema suite, authenticated inventory tests, and Social Publication tests passed | Run the complete compatibility matrix uncached against the final integrated worktree and exercise REST plus MCP with real least-privilege credentials |
| Free, Creator, Pro, Business, downgrade, pending-payment, and restricted states follow approved rules | Partial | Central entitlement and Workspace capability tests cover the matrix; Chrome proved a non-Business Review creation lock with existing Review history still readable | Exercise every plan/status through the final UI and service mutations, including downgrade readability and generation-usage behavior |
| Program analytics compute clips-ready to approved-and-scheduled without sensitive metadata | Proven | Transactional migration triggers emit idempotent `clips_ready`, Campaign Operation started/completed, and bounded `campaign_scheduled` events. The cohort-aware aggregate report returns completion, Review revision, override, publication-failure, and generated-provider failure/rejection guardrails without IDs or content. Its tested operator command executed successfully against the local cohort | Record the fixed real baseline and post-release windows before cutover; this operational evidence is a separate verification gate |
| Every rollout control has a tested rollback that stops writes and keeps reads | Partial | Local policy, service, worker, and disposable-schema tests prove fail-closed ordering. Real Chrome write-off drills additionally preserved generated jobs/assets/B-roll/Scenes, Review rounds/comments/decisions/audit/guest access, confirmed copy, thumbnail history, and the cancelled Social Post while stopping their corresponding new writes. The expanded disposable migration/ownership gate is 25/25 with 340 assertions | Record every per-control rollback/readability drill against the deployed revision. Local proof establishes the control contract; it is not evidence that operators executed the cutover matrix |
| Operations, Review Rounds, generated jobs, bundles, assets, and notifications have reconciliation runbooks and bounded cleanup | Proven | The [cutover runbook](../runbooks/vizard-expansion-cutover.md) documents content-safe diagnosis, idempotent recovery, retention, and bounded cleanup. Presigned Visual Asset keys are admitted beyond URL expiry plus skew and adopted transactionally before any cleanup claim. Thumbnail extraction renews its joint job/exact-key lease through FFmpeg, probing, upload, and adoption. Export Bundle renews both exact-key holds through archive construction and before upload, copy, and transactional adoption. Claim loss aborts active I/O; only the bounded Media Cleanup worker deletes objects. Focused worker/service tests and disposable-schema gates prove the races and receipts | Keep normal queue/cleanup monitoring in the deployed cutover; no implementation ownership gap remains |
| `CONTEXT.md`, pricing, internal runbooks, and public REST/MCP docs match shipped behavior | Proven | Glossary names Export Bundle, Review Notification, and Review Approval Override; pricing advertises generated still images and no longer claims generated video; REST/MCP inventories, exact-key cleanup ownership, lease renewal, rollback, and cutover procedures match the shipped contracts. The final fixed-reference Standards and Spec reviews found no remaining mismatch | Revalidate deployment-specific origins, credentials, and operator links during cutover; no shipped-documentation mismatch remains |

## Review and approval browser evidence

Two real local Chrome runs cover complementary boundaries. The earlier focused
security/accessibility run used a non-Business Workspace plus a service-seeded
round. The later connected run temporarily exercised the same signed-in
Workspace at Business entitlement. Synthetic recipients used reserved
`.invalid` addresses; no live recipient was notified.

- Pre-auth guest entry revealed no project, clip, reviewer, decision, or media
  metadata. A wrong passcode returned the same generic access failure.
- Correct guest access showed four immutable variants, enforced the round's
  download policy, accepted a 14-second timecoded comment and reply, and
  supported change request, item approval, then campaign approval.
- Space and `K` toggled playback; Left/Right sought the active item. Burned
  captions were explained rather than presented as a separate toggle.
- A second round was created from the first with new immutable revision-9
  exports. The first round became superseded and its prior guest session was
  rejected. The old export remained intact.
- The exact-export approval gate accepted the approved revision and rejected an
  inactive source round plus the unapproved resubmission. A reasoned owner
  override replayed as one audit record; API-key override was forbidden.
- Internal reply, resolve, reopen, notification retry, audit history, and revoke
  were exercised. The guest saw the internal reply. After revoke, the guest
  session failed generically and the internal history remained readable.
- At 390 × 844, the guest room had no horizontal overflow. The invalid-access
  alert received focus. Visible private-entry text/button contrast had no
  measured failures; the minimum measured ratio was 4.567:1.
- After Prisma regeneration and a fresh web restart, the internal Review tab,
  Business-plan creation lock, revoked state, and audit history all persisted.

The connected Business run then sent Round 3 with revision 6, received a guest
change request, and sent Round 4 with every corrected immutable revision-8
variant. Round 4 superseded Round 3 and received item plus campaign approval.
Candidates displayed the completed variant duration (`0:25`) rather than the
base clip's `0:19`. Notification delivery failed because the local sender
domain is deliberately unverified; its durable retryable failure remained
visible. With Review creation disabled, internal history and the already
authenticated approved guest room stayed readable while new-round creation
showed an explicit rollout pause.

The earlier non-Business run remains evidence for plan denial, generic guest
boundaries, revocation, accessibility, and mobile layout. The connected run is
still not the required full two-Brand-Profile Business agency journey.

## Reproducible verification recorded so far

| Gate | Result |
| --- | --- |
| Review validators, services, rollout, public HTTP, audit, browser intents, and panels | 69 passed, 0 failed, 265 assertions across 10 files |
| Authenticated inventory plus Social scheduling/publication attempt | 39 passed, 0 failed |
| Generated-media lifecycle and Studio contract | 162 passed, 0 failed, 443 assertions across 21 generated-media and OpenAI-focused files covering service, atomic Prisma quota/idempotency admission, claim fairness, prompt protection, config, runtime/maintenance, OpenAI image adaptation, guarded ingestion, exact-result insertion, Studio projection, Brand Profile membership, and deletion protection |
| `bun run test:vizard-expansion:db` | 25 passed, 0 failed, 340 assertions across the ordered Vizard contract (18/184), Export Bundle cleanup (1/9), stable-ownership migration (2/18), stable-ownership runtime (2/111), and project lifecycle/evidence repair (2/18), after applying the full disposable migration chain through the latest additive repair |
| `bun run test:brand-profiles:db` | 13 passed, 0 failed, 60 assertions, including upload-grant cleanup timing, atomic Visual Asset adoption/replay, and the active-cleanup race |
| Exact-key cleanup ownership and heartbeat contracts | 77 passed, 4 R2 integration-contract skips, 0 failed across Thumbnail Extraction, Export Bundle, Media Cleanup, and R2 boundaries |
| `bun run typecheck` | Passed across all 12 packages |
| `bun run lint` | Passed across 916 files |
| Pricing regression | 9 passed, 0 failed |
| Program analytics guardrail validator and operator | 20 passed, 0 failed; validators/services typechecks and targeted Biome passed; the content-safe CLI executed against a fixed local UTC window |
| Mandatory disposable PostgreSQL gates | Workflow 60/60, Upload Session 2/2, Workspace Billing 9/9, Social Publication 13/13, Clip Editor Persistence plus duplicate-media compensation 22/22, Authenticated Request Policy 3/3, Brand Profiles 13/13, and the Vizard gate above all passed from clean isolated schemas |
| `bun run test` after final integration | Passed uncached across all seven active package test tasks; the web suite passed 675 tests (5 DB-only skips, 2,830 assertions) and the worker suite passed 609 tests (2,208 assertions) including real FFmpeg fixtures |
| `bun run audit:production` | Passed at the high-severity threshold |
| `bun run build` after final integration | Passed uncached across all 12 packages; Next produced the production route manifest for 50 static/dynamic routes |
| Live REST/MCP client E2E | Not run |
| Representative real-media outputs | Partial: all four corrected revision-8 objects were downloaded from storage and ffprobed. They are H.264/AAC at 1080×1920, 1080×1080, 1920×1080, and 1080×1350; each is 25.222199 seconds with exact DB byte-size agreement. Generated-video output remains unavailable. |
| Baseline and post-release metrics | Not available |
| Final fixed-reference `/code-review` | Parallel Standards and Spec reviews completed against base `8e2e705`; every finding was fixed and both final re-reviews are clean |

Focused commands:

```sh
bun test packages/validators/src/pricing.test.ts
bun test packages/validators/src/review.test.ts \
  packages/services/src/review.service.test.ts \
  packages/services/src/review-approval.service.test.ts \
  packages/services/src/review-notification.service.test.ts
bun test 'apps/web/app/api/v1/[[...route]]/business-api-http.test.ts'
bun test packages/services/src/business-automation.test.ts \
  packages/services/src/business-automation-access.test.ts
bun test packages/mcp-core/src/index.test.ts
bun run test:vizard-expansion:db
bun run typecheck
bun run lint
bun run test
bun run build
```

## Migration and data evidence

- The ordered additive program migrations through
  `20260831230000_project_owned_evidence_and_editor_v2_repair` deployed
  successfully, and Prisma migration status reported the shared Neon schema up
  to date. The previously applied `20260830040000_editor_document_v2` migration
  retains a known historical checksum drift. Do not rewrite applied history;
  the additive `20260831230000` migration repairs the affected invariants
  forward.
- The Review QA fixture received a scoped editor-document v2 reset only. Source
  transcripts, clips, existing exports, and immutable media were preserved.
- The earlier revision-9 QA Clip Export remains immutable alongside revision 8.
  The connected approval and publishing path used the corrected four-variant
  revision-8 export. Later B-roll replacement testing advanced the mutable Clip
  document to revision 10 without changing the frozen revision-8 export.
  Review Rounds, comments, decisions, notifications, audit events, and one
  approval override remain as explicit QA evidence.

This is pre-production evidence. It is not permission to repair future
migration history, overwrite immutable exports, or delete release rows.

## Security and privacy evidence

- Review access derives opaque links, stores only token hashes, encrypts
  recipient/guest email, rate-limits access and mutations, and returns a generic
  pre-auth failure. Guest media resolution is restricted to selected immutable
  variants and the frozen download policy.
- Publishing evaluates approval against the exact Clip Export. Only owner/admin
  user actors may create a bounded reasoned override; workers and API keys
  cannot override.
- Business REST keys are Workspace-bound and least-privilege scoped. Sanitized
  responses omit Review secrets, signed URLs, private storage keys, prompts,
  provider controls, and provider payloads. Mutation logging tests prove
  customer text and credentials are absent.
- Analytics validators reject transcript, prompt, comment, reviewer identity,
  token, passcode, signed-URL fields, arbitrary nested keys, and URL values.

OpenAI image and assisted-copy credentials were exercised locally. Generated-
video provider credentials, social OAuth refresh and provider delivery, live
least-privilege REST/MCP clients, and public deployment-origin checks remain
release gates.

## Blocking evidence still required

1. Tickets 10–12 are done. Tickets 09, 13–15, and 17 are implementation-
   complete with deployed staged-rollout evidence pending. Ticket 09 has real
   local OpenAI, Chrome insertion/replacement/deletion, runtime-log, immutable-
   export, and write-off readback evidence. Ticket 16's provider entry gate is
   closed, and ticket 18 remains in progress until its release gates close.
2. Select and register an approved generated-video provider only after the
   generated-image production entry gate is complete. Inspect normalized video,
   preview, four-target export, optional audio, cancellation, deletion, usage,
   and resource budgets.
3. Record a fixed analytics baseline and post-release window from real release
   data; do not substitute the green synthetic interval fixture.
4. Record every staged rollback/readability drill against the deployed
   revision; the local control and bounded-cleanup contracts are green, but
   synthetic evidence is not an operator cutover record.
5. Run the missing two-profile and selection-scoped Brand/Scene portion of the
   Business agency journey, the full plan/status compatibility matrix, live
   least-privilege REST/MCP clients, generated-video real media, and final
   provider delivery against the released revision.
