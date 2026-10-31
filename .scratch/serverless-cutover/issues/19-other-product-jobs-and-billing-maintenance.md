# 19 - Other product jobs and billing maintenance

**What to build:** Other product jobs and billing maintenance.

**Blocked by:** 04, 05, 06, 09, 17, 18

**Status:** in-progress

**Spec:** [Serverless cutover](../spec.md)

- **Build:** event/due-driven drivers for billing, Autopilot/RSS, Finishing, dubbing, export bundles, generated media, thumbnails, library indexing, Performance Guidance and notification intents (existing email adapter untouched).
- **Accept:** a row-by-row map shows every old loop with its trigger, retry and expiry. Billing shares the usage lock. Stale rule or grant revisions can't authorize work. No quota double-spend on replay.

## Evidence

Generated image execution is implemented and tested on `codex/serverless-runtime`; ticket19 remains open for the remaining coordinators and deployed gates. The `GeneratedMediaJob` owns native execution directly. Admission reserves usage and records its targeted driver together. Input JSON is sealed before a Modal dispatch exists. Native code owns the fixed OpenAI POST, base64 decode, full pixel validation and assigned upload. The Worker owns current authority, cancellation, unknown outcome resolution, artifact adoption and usage settlement.

The generated-only validation child and old queue processor/publisher are removed. Unknown acceptance parks without a lease and keeps its count; recovery uses only the original sealed assignment and makes no new provider POST. Asset publication and usage finalization share one transaction. See [generated image evidence](../evidence/generated-image-native-20261031.json) for exact gates and remaining platform work. Full fresh migration gates passed133/871 across19 execution files; generation usage PostgreSQL passed15/84. Host native decoding of100,000,000 bytes peaked734,347,264 bytes RSS, with the configured cap unchanged; actual Linux4GiB confirmation remains open.


The targeted Workspace Billing driver now validates an exact epoch, generation, due time and frozen billing input before acquiring one provider claim. Claim and expiry obligation commit before provider I/O, and the watchdog is confirmed before that call. Stripe delivery, Checkout observations, seat/membership changes, provider projections and retry decisions append next wakes in their mutation transactions. Projection and renewal authority use current epoch and database lease time. See [billing evidence](../evidence/billing-targeted-20261031.json) for tests and explicit remaining paths. This is a tested integration checkpoint; the ticket remains open.

Export Bundle and Dubbing now execute through the accepted Workflow Run,
with one native owner and an original45-minute absolute deadline. Preparation
records the watchdog before private input I/O. Native code receives only scoped
source and multipart grants; actual Popen acknowledgement precedes work.
Bundle ZIP publication settles campaign items and the Workflow together, and
records exact expiry/cleanup obligations.

Dubbing freezes source render, script, languages, voice, models and revisions at
admission. Translation and speech each require a sealed intent acknowledgement
and fresh started authority before one fixed OpenAI POST. Sealed results become
scoped recovery inputs. An ambiguous paid intent becomes `unknown`, keeps its
quota reservation, and refuses an automatic new paid call. Completed audio,
video, quota and Workflow state publish in one transaction. Deliberate requests
after known failure use a new Clip Dub and preserve prior accounting.

Bundle and Dub restore ports require the exact closed epoch/cutoff and revoked
historical owner. Metadata restoration changes no accepted budget, paid evidence
or quota, and appends no product dispatch. Final redispatch alone repairs the
original driver/watchdog obligations. Indexed pages process at most32 rows with
sorted parent locks. Migration019 contains their recovery indexes and the Bundle
accepted-deadline guard.

The [Bundle/Dub evidence](../evidence/dubbing-bundle-native-20261031.json) records
local PostgreSQL, actual child/control/storage fixtures and pinned Linux gates.
The Linux x86_64 source overlay passes13cases under4CPU/8GiB/network-none using
Bun1.3.6, Python3.13.5 and FFmpeg7.1.5. It reproduces and fixes a pinned-reader
cleanup error without changing budgets or goldens. Worker stage routing and
Modal `dub_mix` plus a credential-free verifier are registered in source; no
paid provider call or deployment was made by this checkpoint. Actual Modal/live
Bundle/Dub acceptance and the large-archive memory gate remain open. Root is also
correcting the shared Workflow release path to retain actual charged starts.

Targeted Finishing and email runtime checkpoint, 2026-10-31: each Finishing child
admission/result transaction rechecks current claim authority. Copy generation
and moderation also recheck authority before physical provider requests. Original
source grants and proposal revisions remain frozen. Final Finishing state and its
mail intent now commit in one transaction. Export completion wakes bounded exact
dependents; metadata-only restore revokes owners without changing paid child
identities or original clocks, and final recovery alone appends product wakes.

Project and review email delivery use exact reference drivers with watchdogs,
current recipients, encrypted byte-stable requests, original provider keys and a
23-hour deadline within the provider's24-hour idempotency retention. Automatic
retries keep one body/key; explicit current human retries can start another
bounded attempt cycle before the same original deadline. Review invite and guest
receipts retain their exact wake IDs for lost-ACK replay. Source-terminal events,
review changes and Finishing handoffs append intents with their domain changes.
Two fixed table cursors implement recovery and metadata-only restore. Existing
`packages/email` adapters/templates were not changed and no real emails were sent.

Five disposable-schema suites pass103tests/610assertions, and the existing mail
and receipt unit contracts pass51/194. Services/API typechecks and the actual
Worker bundle import audit pass. Migration024 has only run in disposable local
schemas. Obsolete notification poller deletion/remaining semantic ports, deployed
fault acceptance and the rest of ticket19 remain open. Evidence is in
`evidence/notification-execution-20261031.json` and
`evidence/finishing-obligations-20261031.json`.
