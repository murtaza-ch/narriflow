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
