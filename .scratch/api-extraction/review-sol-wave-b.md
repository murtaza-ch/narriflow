# API extraction wave B review

Reviewed 2026-10-29. Scope: tickets 05, 07, 08, 11, 13, 15, 17 and 19, changes from `f1a6ac85` through `c659d19b`. The checkout was at `b3566f20` when verification ran; the reviewed domain and client files still matched `c659d19b`. Other agents were editing unrelated files concurrently. Originals were read with `git show 9fed947a:<path>`. REST/reviews and their client/validator files are excluded from findings.

Read the specification, including its route registration and client import amendments, and all eight tickets' Comments. No source files were changed. This report is the only file written by this review.

Result: six majors and four medium findings. No demonstrated authorization escalation or foreign-Project disclosure in the reviewed changes. Do not accept the wave until the majors are resolved.

## Findings

### B01. Major: new-Workspace checkout bypasses the receipt-backed Workspace create

Owner: **07**, using the command supplied by **05**.

Locations: `packages/services/src/billing.service.ts:784`, `packages/services/src/billing.service.ts:810`, `apps/api/src/domains/billing/routes.ts:47`, `apps/api/src/domains/billing/admission.ts:12`.

Without `workspaceId`, every call creates another pending Workspace. Supplying the same `checkoutIdempotencyKey` does not deduplicate that creation, because the subsequent native Checkout acceptance is scoped to the newly created Workspace. Dropping the first success response and resubmitting the same name/key therefore creates a second Workspace and a separate Checkout acceptance. The optional key is also minted server-side when absent, so a lost response loses that identity entirely. A changed creation body does not produce an idempotency conflict. The signed-in route has no deferred new-work limiter enforcement either.

A service-level probe with injected Workspace/Checkout methods submitted the identical request twice with the same explicit key. It created `pending-1` and `pending-2` and invoked Checkout once for each Workspace with that same key. No provider call was made.

Ticket 07 acknowledges this limitation, but preserving it is incompatible with the specification's retryable-create contract. Ticket 05 already implements `workspaceCommands.createBusinessWorkspace`, commits the Workspace and receipt together, and explicitly requests that 07 call it. Wire that command into this flow, retain a caller identity before the first attempt, fingerprint the durable creation choices, and preserve the existing native Stripe key for Checkout. Keep the admission identity-only.

### B02. Major: Brand create replays consult mutable state before the receipt

Owner: **19**.

Locations: `packages/services/src/brand-template.service.ts:262`, `packages/services/src/brand-template.service.ts:404`, `packages/services/src/brand-template.service.ts:406`, `packages/services/src/brand-profile.service.ts:484`, `packages/services/src/brand-profile.service.ts:550`, `packages/services/src/scene-template.service.ts:104`.

Template duplication reads the live source and checks the current plan before entering the receipt executor. Template creation checks font selection and plan first. Profile and Scene creation similarly check their new-work plan requirements first. These checks can hide an already committed acceptance and can replace a required changed-body 409 with a mutable-state refusal. Profile creation additionally re-reads the current profile after replay, so deletion produces a not-found and later edits change the returned result.

Disposable-DB probes confirmed both failures: duplicating a template, deleting its source, then replaying the same key returned `brand_template_not_found`; creating a profile, downgrading the personal Workspace to Free, then replaying returned `plan_feature_required`. Both accepted receipts still existed. Membership/role authorization should remain live before replay; source resolution, new-work entitlements and insert validation belong after replay lookup. Preserve an immutable safe result without storing expiring grants.

### B03. Major: the clip command's early limiter refusal can hide a concurrent receipt

Owner: **11**.

Location: `packages/services/src/clips-commands.ts:77`.

The command reads for replay, then invokes `beforeAccept` outside both the receipt lock and its recovery `try`. If another same-key request commits after that first read, an exhausted/unavailable recorded limiter still throws 429/503 without checking the receipt again. The executor's concurrent/lost-commit recovery never runs. This violates the specified locked-recheck ordering.

A deterministic injected probe made the accepted receipt visible immediately before the recorded limiter refused. The result was `rate_limited`, with an existing accepted clip and only one receipt read. Keep the pre-copy refusal optimization only if it resolves a concurrent acceptance before returning the refusal; the final acceptance still needs the locked check. Cover exhausted and unavailable outcomes, including changed-input conflict.

### B04. Major: verified billing changes leave plan-dependent aggregates fresh

Owner: **07**.

Location: `packages/api-client/src/billing/invalidation.ts:22`.

`invalidateBillingDependents` refreshes billing, Workspace and identity bootstrap only. Brand Kit, intake configuration, Project detail, Studio asset/capability reads and other plan-dependent aggregates keep their previous entitlements. For example, upgrade in the Billing screen and revisit a Brand Kit cached within its 60-second fresh window: it still presents the old upgrade gate. A downgrade similarly keeps obsolete affordances until a later refetch. Service enforcement prevents unauthorized work, but the confirmed UI state is wrong.

A QueryClient probe confirmed Project detail, Brand Kit, intake configuration and Studio assets all remained uninvalidated after the helper ran. Invalidate the affected plan-dependent resources after the observed provider-state change, preserving the Editing Session's ownership of the working document.

### B05. Major: credit-changing commands invalidate a cache the shell does not read

Owners: **11**, **15**, and **08** for deletion.

Locations: `packages/api-client/src/clips/mutations.ts:151`, `packages/api-client/src/ingest/invalidation.ts:13`, `packages/api-client/src/projects/mutations.ts:111`. Consumer evidence: `apps/web/app/(app)/_components/usage.ts:18`.

Clip rendering/regeneration, intake acceptance and Project deletion invalidate `workspace/usage`, but omit `workspace/bootstrap`. The existing shell/Billing/Usage hook reads the usage embedded in `workspace/bootstrap`. Invalidating its separately seeded constituent does not update the aggregate. Accepted reservations, changed in-flight capacity or released usage therefore leave the displayed allowance unchanged. Clip changes also omit the home/explorer aggregates that contain Project counts.

QueryClient probes confirmed that intake and clip-change helpers invalidate usage while leaving bootstrap fresh. The generation helper in ticket 08 already invalidates both and provides the correct pattern. Refresh both representations after confirmed acceptance; include affected home/explorer counts for clip creation/deletion.

### B06. Major: publishing invalidation misses Project data and account consumers

Owner: **17**.

Location: `packages/api-client/src/publishing/mutations.ts:60`.

`invalidatePublishing` targets only the publishing domain. Project detail stores its own `socialPosts`, account snapshots and Workspace timezone under `projects/detail/<id>/<tab>`; it is not a child of a publishing key. Cancel, proposal acceptance, recovery or account disconnection can succeed while that aggregate stays fresh and continues showing the previous post/account state. Account disconnection also affects recipe/automation choices, which this helper never refreshes. The Project workflow stream does not promise to carry publication changes.

A QueryClient probe confirmed Project detail remained uninvalidated. Expose command-specific invalidators with the Project/account identity when available, and cover the cross-domain relationships required by the specification. Avoid a Workspace-wide cache reset.

### B07. Medium: invitation replay reports successful issuance without a usable credential or delivery result

Owner: **05**.

Locations: `apps/api/src/domains/workspace/routes.ts:92`, `apps/api/src/domains/workspace/routes.ts:105`, `packages/services/src/workspace-commands.ts:106`.

The receipt correctly excludes the raw invitation token. However, if the process loses the commit response, or stops after the transaction and before email delivery, replay returns HTTP 200 with `inviteUrl:null` and `emailSent:null`; the successful mutation handler completes the intent. The API cannot establish that the invite was delivered, and the caller receives neither the original link nor an explicit issuance-recovery refusal. This is the declared behavior change most in need of a concrete recovery contract.

Apply the specification's one-time-credential recovery behavior: a safe `credential_already_issued` response with the invite identity and explicit Resend guidance, without recovering or storing plaintext. At minimum, the client must distinguish this outcome from completed delivery and retain an explicit recovery action. Do not silently rotate the token on replay.

### B08. Medium: Studio and publishing do not export the specified query factories

Owners: **13** and **17**.

Locations: `packages/api-client/src/studio/index.ts:1`, `packages/api-client/src/publishing/queries.ts:47`.

Studio exports only the RPC client and types. Publishing exports keys and bare fetchers, with no queryOptions factories; its fetchers do not take or forward AbortSignal. The amended package contract requires consumers to import domain queries, mutations and invalidators from the domain subpath, and every query must pass its cancellation signal. Concurrent UI work has already started recreating these factories in web-local `studio-api.ts` and `publishing-client.ts`, including a transport wrapper to bind publishing cancellation.

Move the reusable read/query adapters into their owning API-client domains and export them there. Keep Studio draft/history/save ownership in the Editing Session. The new local UI wrappers are evidence of the missing domain contract, not additional reviewed source changes.

### B09. Medium: several durable replay responses omit Idempotent-Replayed

Owners: **19** and **17**.

Locations: `apps/api/src/domains/brand/routes.ts:174`, `apps/api/src/domains/brand/routes.ts:323`, `apps/api/src/domains/brand/routes.ts:348`, `apps/api/src/domains/brand/routes.ts:228`, `apps/api/src/domains/publishing/routes.ts:495`.

Brand profile/template/duplicate/Scene handlers discard or never receive the executor's replay flag, and never set `Idempotent-Replayed:true`. The three social publication recovery handlers have the same issue; their underlying recovery service returns only `accepted.value`. A caller retry therefore cannot observe the documented replay response contract. Proposal, folder, Recipe, Workspace invite and clip handlers already demonstrate the intended header handling.

Carry replay metadata from the authoritative acceptance to the adapter, without a second response cache. Add adapter tests for the header on actual replay, not just for passing a key to a stub.

### B10. Medium: the approved account-read relaxation leaves the required suite red

Owner: **17**, with the orchestrator's capability decision retained.

Location: `apps/api/src/domains/publishing/routes.test.ts:316`.

The test still expects a viewer's `GET /social/accounts` to return 403. It returns 200 after the explicit relaxation, causing the requested 427-test command to fail. Update the assertion and title, and keep denial assertions for connecting/disconnecting accounts. The correct fix is the test, not reinstating `social.manage` on this read.

## Declared behavior changes and decisions

| Ticket | Declared change | Review decision |
| --- | --- | --- |
| 05 | Identity bootstrap accepts `?workspaceId=` as well as a header hint | Accept. The identity transport deliberately removes the scoped header; live membership still controls the effective selection. |
| 05 | Avatar size validation now uses common `invalid_input`; censor replacement uses `{words}` | Accept as the selected shared-validator/JSON contract. Existing semantic service errors remain distinct. |
| 05 | Invite replay returns null link/delivery fields | Credential exclusion is correct; recovery needs B07. |
| 07 | Shared-validator failures replace `validation_failed` / `invalid_checkout_return` with `invalid_input` | Accept under the common-validator requirement. Preserve semantic billing codes and recovery details. |
| 07 | Existing Checkout/quote identities remain body-based; no second header identity | Accept for existing native billing operations. New Workspace creation is a separate uncovered write, B01. |
| 07 | Lost initial New-Workspace response can create another Workspace | Reject, B01. The old limitation is not a compatibility requirement and 05 supplied its replacement. |
| 08 | Folder move uses PATCH; whole-Project brand apply uses POST; selected-clip campaigns remain separate | Accept. These match the chosen spec endpoints. |
| 08 | Full transcript only on the transcript tab, otherwise status; API failures replace action redirects | Accept. No full transcript was introduced into bootstrap/shell. |
| 08 | Profile picker reads 100 rather than the old default 24; source grant remains content.view and may degrade to null | Accept. Current catalog maximum is 10 profiles; the source-read capability matches the old Clips tab. |
| 11 | Remove `/file` alias in favor of existing `/download` grant | Accept for the coordinated cutover once 12 converts its callers and the disposition ledger records the removal. Both use the same grant service. |
| 11 | Remove immutable browser caching from preview peaks | Accept. The path does not identify a preview revision; default no-store prevents stale peaks after regeneration. |
| 11 | create-from-selection keeps its existing non-retryable contract; duplicate/from-range gain receipts | Accept against this ticket's explicitly named duplicate/range acceptance criterion, with automatic retries disabled. |
| 13 | Shared PATCH validation uses `invalid_input`; layout polls wrap nullable payloads | Accept with the paired UI conversion. The existing intent precedence, revisions and service checks remain. |
| 13 | Censor analytics additionally checks clip-to-Project ownership | Accept. It closes an identifier association gap without widening access. |
| 13 | Comment claims preview peaks retain immutable caching | Superseded by 11's deliberate no-store change. Update stale ticket prose during close-out. |
| 15 | Commit tokens required on link/Drive/RSS; native Upload Session keys retained | Accept. No duplicate response-cache identity was added. |
| 15 | Upload grants/status POSTs use read baseline plus their preserved 120/min operation limit | Accept. Otherwise the shared 60/min control bucket defeats their intended throughput. Open/finalize/discard retain their control bucket. |
| 15 | Resume returns typed outcomes/concealed 404 or explicit Workspace mismatch; retry refusals become typed HTTP failures | Accept. This follows the extraction's concealment and client-navigation contract. |
| 17 | OAuth start becomes POST JSON; callback origin API, human return origin web; provider failure becomes JSON | Accept. Stored state, verifier, expiry and membership checks remain in the existing service. |
| 17 | Receipt-backed publication recovery now requires a caller key | Accept. Native publication uncertainty/receipts remain authoritative. Missing replay headers are B09. |
| 17 | GET /social/accounts relaxed from social.manage to content.view | Accept. The original settings page at `9fed947a` admits content.view and calls the identical `listAccounts`; that service also requires content.view and projects snapshots without encrypted/access/refresh tokens. Account mutations remain social.manage. Fix B10. |
| 19 | Malformed ordinary IDs use common invalid_input; audio retains invalid_audio_asset_id | Accept. Validation happens after admission; inaccessible Projects remain concealed. |
| 19 | Usage/replacement reads retain brand.manage/plan conditions; all-profile reads replace default-page truncation | Accept. Plan checks use the catalog helpers. |
| 19 | Asset finalize keeps native fingerprint/storage-key idempotency; generated jobs and Scene apply keep their native keys | Accept. Do not add another receipt layer. |
| 19 | Profile receipts store only ID and read the response fresh | Excluding signed URLs is correct; deletion/edit-dependent replay is not immutable, B02. |
| 05/19 | Requests to export all domains from the package root | Reject as obsolete. The appended client import convention explicitly requires domain subpaths and forbids root export-star collisions. |

## Verification

- Requested command: `bun test apps/api/src/domains/{session,workspace,billing,projects,library,clips,studio,ingest,recipes,publishing,brand} packages/api-client/src`: **426 pass, 1 fail**, 427 tests across 34 files. Failure is B10. No source was changed to make it pass.
- `bun run --cwd apps/api test:inventory`: **pass**, 250 routes, 32 protocol routes, zero problems. Ran before other agents began adding more routes; not a final integrated count.
- Service receipt/business-checkout suites: **49 pass, 1 fail**. The failure is the excluded reviews command name `review.round.create` violating the existing registry-name test. It is not attributed to these eight tickets.
- Every DB command and the extra DB probes ran through `.scratch/api-extraction/db-gate.sh`, using the local throwaway PostgreSQL instance and disposable schemas. No shared Neon data or live providers were used.
- Passed DB gates: `test:workspace-billing:db` 16; `test:social-publication:db` 125; `test:brand-profiles:db` 37; `test:upload-session:db` 15; `test:library-search:db` 23; `test:workflow:db` 175; `test:processing-usage:db` 31. `test:clip-editor-persistence:db` passed both its editor-persistence and duplicate-media suites.
- Also ran the receipt tests omitted by the standard runners, in an inline disposable-schema harness through the same gate: `brand-receipts.db.test.ts` **11 pass**, `clips-commands.db.test.ts` **3 pass**. No temporary runner file was created. Ticket 31 still needs to register these suites in the normal gates.
- `test:vizard-expansion:db`: generation usage **17 pass**, review access **4 pass**, Workspace membership **8 pass**; the final combined group **69 pass, 2 fail**. The two failures are the excluded review-round cases named in the implementer comments: guest-session/opposite-decisions and concurrent-review-revisions. The gate is **not green** overall.
- Additional probes: identical-request Business Workspace duplication in B01; two live disposable-DB replay failures in B02; one deterministic clip-limiter race in B03; QueryClient invalidation probes for B04-B06. Probe data/schemas were removed in finally blocks.
- API/client typechecks did not pass globally. API errors were in in-progress integrations and excluded REST/reviews; client errors were in in-progress integrations and excluded REST. No type errors were reported in the reviewed domains. These results do not waive the final integrated typecheck.
- Raw-body Stripe and TikTok tests passed, including reserialization rejection for TikTok. OAuth callback logic still uses persisted state/PKCE/expiry/current membership, callback URLs use API origin and browser destinations use web origin. Studio editor tier remains 120/min per actor+Workspace+clip plus 300/min actor-global; the document writes are exempt from the ordinary mutation bucket. The requested adapter suites cover the editor burst/size checks and Project concealment.
- Browser/provider cutover, native container smoke and the complete final repository gates remain ticket 32 work. This review did not deploy, edit other agents' files, or certify those scenarios.
