# Serverless cutover record

Status as of 2026-11-03: implementation and isolated verification remain in progress. Development code is published ahead of infrastructure acceptance at the owner's request. The isolated candidate's HTTP and database intake are closed at execution epoch 10 after the failed speech gate on `ff7fc072`. The original shared development database remains unmigrated; final API routing, resource naming, Railway/Upstash retirement and cutover acceptance remain pending. GitHub CI is disabled at the owner's request; the full automated verification hook runs locally before pushes.

The owner authorized account setup, deployments, testing, merge to `dev` and push after verification. On 2026-11-01 the owner explicitly selected **Keep Neon Free**; no Launch upgrade or new payment authorization was submitted. Verify the deployment within Free limits. The release must include the complete replacement and deletion set in one switch. [The spec](../../.scratch/serverless-cutover/spec.md) owns the acceptance gates; [the resource runbook](environments.md) owns resource selection and local setup.

## Recorded isolated evidence

| Check | Evidence / scope |
| --- | --- |
| Linux media | Exact36 canonical cases; pinned image143 Python tests. `render-thread-policy-20261031.json` records provenance and thread policy |
| Source authority | `be3e5ebf`: actual Core source lifecycle25PG/145 assertions, usage31PG/276, intake events5PG/13. Retry outcome wakes retain their original generation/input; the next retry has its own exact obligation |
| Dub isolation | `167e9e4a`: eight real Core PostgreSQL tests preserve another same-Project accepted Dub across failure/release/expiry, including paid unknown outcomes |
| Obsolete Workflow supervisor | `workflow-supervisor-retirement-20261031.json` maps old assertions to current Core, provider, progress and native suites |
| Grant notices | `grant-notifications-20261031.json`; exact grant revision, stable provider key/body, three charged starts and23-hour deadline; no real email sent |
| Maintenance | `deployed-maintenance-20261031.json`: actual candidate Workflows, bounded hourly/daily chains and confirmed wakes |
| Fixture retirement | `isolated-fixture-retirement-20261031.json`: six synthetic Projects only; all30 owned cleanup intents complete and exact R2 HEADs404 |
| Large transfer diagnostic | `r2-native-10gib-20261031.json`: real R2, bounded native memory, four-hour controlled gate. Its transfer durations exceed the production45-minute bound and do not pass that release gate |
| Passed combined transfer on an earlier source | `atomic-transfer-third-attempt-passed-20261101.json`: source `b7fdecf3` uploaded and conditionally pinned10GiB in2232.554seconds within the unchanged2700-second budget; all four artifacts were retired. This does not qualify a later candidate |
| Latest immutable media components | `ff7fc072`:181 lean and196 render tests, unchanged36-case golden comparison, four seek cases, token-owner checks and the2CPU/4GiB preparation supplement passed. This is component evidence, not live pipeline or cutover acceptance |

## Latest speech and browser findings

The unchanged146.147-second speech fixture produced53 provider candidates on `ff7fc072`. Timing validation kept51 candidates and the overlap rule kept eight clips. An offline exact search over that frozen candidate set also found a maximum of eight; it does not establish a bound for every possible moment in the source. The four-minute twelve-clip gate failed. The render parent eventually settled partial, with two completed clips and six failed clips. Its original journal, deadlines, charges and failed attempts remain retained.

The owner chose to keep only the current fixture. No replacement fixture, padding, weaker quality rule or acceptance waiver was introduced. Local PostgreSQL regressions reproduced and corrected sibling Render Group serialization and a Project/Clip lock cycle. A separate browser regression reproduced the paused Worker's and app middleware's503 preflight response, which hid the typed maintenance refusal behind an offline error. The corrected Worker and app composition passed55 focused tests. Fresh deployed verification remains required before acceptance.

Evidence files live in `.scratch/serverless-cutover/evidence/`. Private raw logs, backup and credential files stay outside Git. No synthetic or credential-free native check is evidence of a live provider/domain end-to-end path.

## Remaining release gates

Complete every spec gate against the deletion-inclusive release SHA. In particular, finish the remaining PostgreSQL fixture ports; actual45-minute10GiB/conditional pin on Modal; laptop YouTube; deployed signed control, auth, raw webhooks, MCP and multipart; real Scribe/selection/render/export/dub flows; aggregate12-clip source reads; declared latency and quota cohorts; proved quiesced restore; exact-candidate idle/cold checks. Do not substitute a partial-window diagnostic for aggregate source-read acceptance or claim p95 from fewer than100 samples per tail cohort.

## Execution order

1. Freeze and verify the complete candidate. Record SHA, migration hash, native fingerprints, immutable image/source archive, Worker/Workflow version and DO migration tag. Run all repository and disposable database gates again on that SHA.
2. Verify the account, resource bindings, secret stores and API hostname/certificate. Disable old automatic Railway and Vercel deployment side effects before pushing `dev`.
3. Close intake and irreversible publishing. Stop old local/Railway consumers and API mutations, drain or fence active executions, reconcile uncertain provider effects and revoke old consumer credentials.
4. Capture a proved quiesced snapshot after storage mutations drain. Record the source epoch/fence, exact hashes and stop/drain proof. Maintain quiescence. Review the reset list and both migration URLs, then migrate the shared database once with the new epoch.
5. Deploy final Modal and Worker/Workflow/DO resources with admission closed. Verify uncached Hyperdrive, private R2/CORS/lifecycle and local device selection.
6. Switch API routing, rebuild Vercel with the matching API/WebSocket origin and update provider callbacks, OAuth redirects, Clerk and MCP audiences.
7. Run closed-admission smokes and verify single settlement, credits, outbox drain, export/Studio evidence reuse, progress revocation/reconnect and sandbox publication recovery.
8. Complete the live one-hour idle check, including the connected idle laptop, Neon suspension between declared maintenance wakes and zero Modal containers. Measure the cold first request.
9. Delete old Railway services/triggers/variables and Upstash after the new smokes pass. Reopen admission once and record acceptance. The owner requested the code merge and push before final infrastructure acceptance; that code publication does not waive any live acceptance gate or authorize running the old consumers again.

On failure, keep intake closed and fence candidate executions. Fix forward or use only [the proved execution restore procedure](execution-restore.md). An arbitrary backup or PITR cannot authorize replay over later execution history. Never run two scheduler environments against one database.
