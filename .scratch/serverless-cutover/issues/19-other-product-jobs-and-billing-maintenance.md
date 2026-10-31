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

Export Bundle native preparation now uses the existing Archiver writer with one
verified input stream at a time, following the
[upstream streaming interface](https://github.com/archiverjs/node-archiver).
Each input preserves its frozen manifest name and exact length, and checks an
authoritative digest when present. The source aggregate cap remains4GiB; ZIP
metadata has a bounded64MiB allowance. Inputs need not coexist with the finished
ZIP on scratch. A real supervised Bun child starts only after the process-start
acknowledgement, reads scoped If-Match source ranges, creates the ZIP, and uploads
through the assigned multipart output. A lost commit acknowledgement retains the
completed upload.

Nine stream/archive/capsule cases pass34 assertions, including ZIP extraction,
digest refusal and existing archive behavior. Two actual host Python/Bun wrapper
cases pass through controlled storage/control ports. Migration013 binds the
accepted manifest, capsule tuple and deadline, with a fenced restore exception;
one disposable PostgreSQL constraint case passes5 assertions. API composition,
authoritative bundle/campaign finalization, actual Linux/Modal and large archive
gates remain required. Dubbing still needs its accepted-row/provider checkpoint
replacement. No bundle or dub function is registered by this checkpoint.

The Export Bundle coordinator now prepares a metadata-only native execution from
the exact accepted Workflow Run. It commits the absolute watchdog before private
input I/O, seals one capsule, and reuses one Generic Attempt per generation. ZIP
commit settles the bundle, campaign items and Workflow Run in one transaction.
Retries preserve the capsule and accepted deadline; lease release, failure and
expiry project the same business state. Current actor access and frozen variant
identity are rechecked before execution and publication.

Bundle publication also records its exact expiry obligation. Expiry validates the
observed timestamp, clears the public ZIP reference and admits the known-key
cleanup together. Cleanup replays retain the original measured artifact facts;
active references and outstanding grants remain held. The accepted expiry is
immutable and has a bounded safety-page index.

The new bundle PostgreSQL cases pass10/86, including concurrent preparation,
failed input PUT with an unowned watchdog, cleanup/adoption exclusion, real control
and transfer assignment, atomic publication, lost acknowledgment replay, stale
deadline refusal and charged retry accounting. Bundle, Workflow, Ingest and Clip
Preparation regressions pass65/529 across four fresh-schema suites. The existing
fenced bundle command regression passes, the nine native/archive cases pass34
assertions, and both actual host Python/Bun wrappers pass. Services and media
typechecks pass. These are local controlled-port gates; API/Modal registration,
actual Linux/Modal and large archive memory gates remain open. Dubbing replacement
is still in progress. The database runner now rejects nonexistent named suites
before migration so a mistyped gate cannot silently run fewer files.

Dubbing admission now creates a new accepted Clip Dub and reservation for each
deliberately repeated known failure. Prior failed accounting is retained. A raw
partial unique index permits failed history while keeping one current queued,
processing, completed or unknown tuple. The accepted Workflow Run is linked by
an exact project-scoped foreign key and remains the sole execution owner. Source
render identity, script, language, voice, models and revisions freeze in the same
admission transaction; the existing transcript policy has one shared pure owner.
Unknown paid outcomes remain counted and reject a new request for the tuple.

Generation usage, bundle and Workflow PostgreSQL regressions pass39/276 across
three fresh-schema suites, including new frozen request/history and mixed older
failed/current unknown cases. Existing worker policy/error copy cases pass26/106.
Services typecheck passes. Migration014 has only run in disposable schemas.
The native paid-intent/result, scoped recovery, mix/publication and deployed
dubbing gates remain required; this admission checkpoint does not register a
dubbing function.
