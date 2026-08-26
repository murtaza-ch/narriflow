# Vizard-inspired Narriflow expansion map

**Status:** ready-for-agent

**Tracker:** local Markdown

**Label:** wayfinder:map

## Destination

Produce one implementation-ready program and eight feature specifications for a Vizard-inspired expansion of Narriflow. The route must preserve existing data, behavior, URLs, share links, public APIs, Blueline design, Studio Editing Session ownership, and Clip Composition Plan ownership.

The product outcome is a shorter interval between clips becoming ready and an approved campaign being scheduled. The target user is a small agency or creator team that manages several brands.

## Notes

- Vizard is a workflow reference. It is not a visual design target or an architectural template.
- Use `CONTEXT.md`, the `domain-modeling` skill, and the repository's existing local planning format in every implementation task.
- Shared validators belong in `packages/validators`. Business rules belong in `packages/services`. Services must be re-exported from `packages/services/src/index.ts`.
- Extend `hasFeature` for plan gates. Do not add direct pricing-tier comparisons at call sites.
- The current Clip Composition Plan and Studio Editing Session plans are prerequisites. New timed edits must pass through those owners.
- Existing changes in the worktree belong to the user. Implementation tasks must inspect and preserve them.
- Every issue in `issues/` is an implementation handoff. It must be completed in a fresh task with focused tests, `bun run typecheck`, and `bun run test`.

## Product baseline

Narriflow already has context-aware clip selection with scoring and reasoning, prompt-based re-clipping, editable subtitle lines, processing ranges, folders, team workspaces, Brand Templates, uploaded and curated audio, Studio apply-to-all controls, B-roll cues, multi-aspect exports, direct Instagram Reels publishing, a social calendar, and immutable Clip Exports with revocable share links.

This program does not rebuild those capabilities. It deepens the existing workflow in four places:

1. Brand Kit becomes the home for reusable identity, voice, assets, and scenes.
2. The project Clips tab becomes the campaign operations hub.
3. Studio remains the editor for one clip and gains constrained scenes, censoring, motion, and generated media.
4. A new Review tab sits between creation and publishing without changing any existing `?tab=` value.

See [Vizard reference and overlap audit](vizard-reference.md) for the dated comparison.

## Decisions so far

- [Brand profiles and asset library](features/brand-profiles-and-assets.md) defines multiple brand profiles while keeping Brand Templates compatible.
- [Reusable and insertable scene blocks](features/scene-blocks.md) limits scene editing to bounded blocks rather than a general video editor.
- [Campaign bulk operations](features/campaign-bulk-operations.md) extends the Clips selection bar and preserves Studio apply-to-all.
- [Client review and approval rooms](features/review-and-approval.md) uses immutable export revisions and secure guest links.
- [Publishing expansion and assisted copy](features/publishing-expansion.md) adds Facebook, provider-aware thumbnails, and reviewed social copy without rebuilding Instagram.
- [Suggestion-first auto-censor](features/auto-censor.md) requires editors to review detected terms before one undoable apply.
- [Motion and media animation](features/motion-and-animation.md) adds a bounded motion vocabulary through the Clip Composition Plan.
- [Generated B-roll and visual assets](features/generated-media.md) ships still images before short videos through one provider-neutral job contract.

## Shared user experience

### App navigation

Keep Home, Projects, Exports, Calendar, Autopilot, Brand Kit, and Integrations. Brand Kit opens a list of Brand Profiles instead of a flat template gallery. Existing Brand Template URLs keep working and resolve inside the profile that owns the template.

### Project workspace

Keep Clips, Transcript, Repurpose, Dubbing, Publish, Analytics, and Activity. Add Review as a new URL-driven tab. The Clips selection bar offers one primary campaign action and places secondary actions in a Blueline drawer or menu.

The expected agency path is:

1. Choose a Brand Profile when the project starts or from the Clips tab.
2. Edit individual clips in Studio.
3. Apply selected campaign operations from the Clips tab.
4. Create a Review Round from selected completed exports.
5. Resolve requested changes in Studio and submit a new round.
6. Schedule approved deliverables from Publish or Calendar.

### Studio

Keep the three-pane editor and contextual Inspector. Do not add a second editor shell. Group new tools with the existing model:

- Transcript actions own censor detection and review.
- Media owns B-roll, scene blocks, uploads, and generated assets.
- Motion owns clip transitions and layer entrance or exit animation.
- Brand resolves assets, fonts, styles, and reusable scene templates.

One Clip Editor Document and one Studio Editing Session remain authoritative for edits, history, autosave, recovery, and playback.

## Shared domain and architecture

### Domain ownership

- Project remains the container for a source and its campaign deliverables. Do not create a second Campaign aggregate.
- Brand Profile owns reusable identity and writing guidance. Brand Template remains a compatible style preset that a Brand Profile may contain.
- Visual Asset owns uploaded or generated image and video media. Existing Audio Asset remains separate and appears through an aggregate Brand Kit view.
- Scene Block is an edited-time insertion in one Clip Editor Document. Scene Template is its reusable Brand Profile definition.
- Review Round is an immutable submission of selected Clip Export revisions. Review Comments and Review Decisions belong to that round.
- Campaign Operation records one selection-scoped request and per-item outcomes. It is not a worker lease.
- Generated Media Job records one provider request and usage settlement. A successful result becomes a Visual Asset.

### Data model rules

- Add schema changes through additive migrations first. New relations remain nullable until backfill and mixed-version reads are deployed.
- Attach existing custom Brand Templates to one compatibility Brand Profile per owning workspace or personal owner. Built-in templates remain global.
- Keep existing template IDs, default references, project `brandSnapshot` values, export rows, share tokens, social rows, and old routes.
- Extend the versioned Clip Editor Document with empty-by-default `sceneBlocks`, `censorSegments`, and media-motion values. Readers upgrade known older documents and reject unknown newer versions.
- Review items point to immutable Clip Exports and selected variants. They never point at mutable Studio state.
- Store R2 object keys in durable records and produce signed URLs only at access boundaries.
- Soft-deleted reusable assets disappear from pickers. Existing frozen exports and review items retain their delivery objects.

### Service and job rules

- Create focused services for Brand Profiles, Visual Assets, Campaign Operations, Review Rounds, and Generated Media Jobs.
- Reuse Workflow Run for `export_bundle` execution. Do not force synchronous database-only operations into Workflow Run.
- Selection-scoped database operations return per-item outcomes. They use one idempotency key per submitted operation and retry only failed or stale items.
- Generated media uses a provider adapter. The first image adapter uses the configured OpenAI key and model. Video support implements the same contract after image generation has proven stable.
- Provider errors map to stable user-facing codes. Logs must not contain review tokens, passcodes, prompts with customer material, signed URLs, or generated provider payloads.

## Permissions and entitlements

Add `review.manage` for owners, admins, and editors. Add `review.override` for owners and admins. Viewers may inspect internal review status but cannot create rounds, comment as the workspace, or override approval.

Extend `PlanFeature` with named capabilities. The first packaging decision is:

| Capability | Free | Creator | Pro | Business |
| --- | --- | --- | --- | --- |
| Preview premium censor and motion controls | Yes | Yes | Yes | Yes |
| Persist Brand Profiles, fonts, scenes, censor edits, motion, and assisted copy | No | Yes | Yes | Yes |
| Generate still images with separate usage metering | Trial only | Yes | Yes | Yes |
| Run selection-scoped delivery, export bundles, and generated video | No | No | Yes | Yes |
| Share governed Brand Profiles across a team | No | No | No | Yes |
| Create client Review Rounds and enforce approval | No | No | No | Yes |

Server checks are authoritative. A downgrade does not make old projects unreadable or old exports unavailable. It blocks new premium mutations and new provider usage.

## Analytics and program measure

Extend the typed analytics events with:

- `clips_ready`
- `campaign_operation_started`
- `campaign_operation_completed`
- `review_sent`
- `review_opened`
- `review_changes_requested`
- `campaign_approved`
- `campaign_scheduled`
- `generated_asset_completed`
- `generated_asset_inserted`

The program measure is the elapsed time from `clips_ready` to the first `campaign_scheduled` event whose selected deliverables satisfy the configured approval rule. Guardrails are completion rate, revision count, publish failure rate, provider failure rate, and the number of approval overrides.

Analytics metadata may contain stable IDs, counts, platform, outcome, duration bucket, and feature version. It must not contain transcript text, comments, prompts, reviewer email, tokens, passcodes, or signed URLs.

## Implementation ticket graph

The list below is topological. A later ticket may start only after every linked blocker closes. Refer to tickets by these names rather than by list position.

1. [Establish Brand Profile and Visual Asset ownership](issues/establish-brand-profile-and-visual-asset-ownership.md)
2. [Extend entitlements, permissions, and program analytics](issues/extend-entitlements-permissions-and-program-analytics.md)
3. Complete the existing [Move timed visual layers into the shared plan](../clip-composition-plan/issues/07-move-timed-visual-layers-into-plan.md) and [Plan the edited-time audio schedule end to end](../clip-composition-plan/issues/08-plan-edited-time-audio-schedule.md) prerequisites.
4. [Migrate Brand Kit with Brand Template compatibility](issues/migrate-brand-kit-with-template-compatibility.md)
5. [Establish Campaign Operation and export-bundle lifecycles](issues/establish-campaign-operation-and-export-bundle-lifecycles.md)
6. [Version the Clip Editor Document for new timed edits](issues/version-the-editor-document-for-new-timed-edits.md)
7. [Establish Review Round revisions and secure guest access](issues/establish-review-round-revisions-and-guest-access.md)
8. [Add Facebook and a provider capability contract](issues/add-facebook-and-provider-capability-contract.md)
9. [Add reusable and insertable Scene Blocks](issues/add-reusable-and-insertable-scene-blocks.md)
10. [Generate and insert still images](issues/generate-and-insert-still-images.md)
11. [Add suggestion-first Auto Censor](issues/add-suggestion-first-auto-censor.md)
12. [Build selection-scoped campaign actions](issues/build-selection-scoped-campaign-actions.md)
13. [Expand transitions and media motion](issues/expand-transitions-and-media-motion.md)
14. [Deliver the Review tab, guest room, and notifications](issues/deliver-review-room-and-notifications.md)
15. [Enforce Review approval in publishing](issues/enforce-review-approval-in-publishing.md)
16. [Add assisted copy, thumbnails, and bulk scheduling](issues/add-assisted-copy-thumbnails-and-bulk-scheduling.md)
17. [Generate and insert short video](issues/generate-and-insert-short-video.md)
18. [Expose stable workflows through versioned API and MCP operations](issues/expose-stable-workflows-through-api-and-mcp.md)
19. [Prove the approved campaign flow and cut over](issues/prove-the-approved-campaign-flow-and-cut-over.md)

## Release sequence

### Foundation

Complete [Establish Brand Profile and Visual Asset ownership](issues/establish-brand-profile-and-visual-asset-ownership.md), [Extend entitlements, permissions, and program analytics](issues/extend-entitlements-permissions-and-program-analytics.md), [Establish Campaign Operation and export-bundle lifecycles](issues/establish-campaign-operation-and-export-bundle-lifecycles.md), and [Version the editor document for new timed edits](issues/version-the-editor-document-for-new-timed-edits.md).

### Client delivery

Complete Brand Kit migration, scene templates and insertion, selection-scoped campaign actions, review data and guest access, review UI, approval enforcement, Facebook delivery, and assisted copy.

### Creative safety and motion

Complete auto-censor and the expanded motion vocabulary after the shared edited-time interfaces are stable.

### Generated media

Complete generated still images first. Enable short generated video only after image jobs, usage settlement, moderation, insertion, and deletion have production evidence.

### Automation and cutover

Add versioned public API and MCP operations after each web lifecycle is stable. Finish with cross-feature browser proof, rollback checks, and documentation updates.

## Migration and rollback contract

- Deploy database additions before code that writes them.
- Deploy tolerant readers before backfills.
- Backfill Brand Profile ownership in bounded batches with resumable cursors.
- Keep old Brand Template routes and service methods as compatibility adapters.
- Shadow editor-document planning and generated asset resolution before switching render behavior.
- Gate each capability with a server control that can stop new writes without making existing rows unreadable.
- Rollback never deletes new columns or objects. It disables new creation and returns reads to compatible projections.

## Not yet specified

No product decision remains open for the first implementation sequence. Provider model names, credit pack prices, and numerical generation allowances stay in deploy-time configuration because provider cost changes independently of the domain contract.

## Out of scope

- Native mobile applications.
- Google Drive export.
- A freeform multi-track or collaborative real-time editor.
- Replacing the Blueline visual system with Vizard's interface.
- Rebuilding direct Instagram connection, folders, workspaces, calendar, Brand Templates, audio uploads, subtitle editing, processing ranges, prompt re-clipping, Studio apply-to-all, B-roll cues, or multi-aspect exports.
- Public API or MCP operations before the corresponding web lifecycle is stable.
