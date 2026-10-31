# Execution restore

Ticket 20 remains incomplete. Production factory composition and deployed maintenance/restore
acceptance must pass before using this procedure against shared development.
The operator CLI is implemented and tested; no restore command reopens admission.

Only a continuously **quiesced, fenced snapshot** is supported. Arbitrary PITR
and snapshots followed by additional execution history are refused. An epoch
alone cannot show that an older snapshot contains every charged start or provider
intent. This procedure captures those facts before replacing the database.

1. Deploy the configured API in `fenced` mode. Verify its exact version through
   `GET ${API_ORIGIN}/api/health`: `{ok:true, service:"narriflow-api", version,
   admissionState:"fenced"}` with `Cache-Control: no-store`. Stop legacy workers,
   scheduled maintenance and cleanup consumers; defer native and local dispatch.
   Record the stop observations and deployment version. `closed` is insufficient:
   callbacks must also be fenced during capture and restore.
2. Inspect the live database, then run `fence --expected-epoch N` against that same
   direct connection. A standalone transaction closes admission and advances once
   to the source epoch, without creating execution permission. Repeating the same
   command is allowed only while that new epoch is closed and has no dispatches.
3. Drain already-issued database mutations, R2 DELETE and multipart completion
   HTTP. Keep all consumers stopped. Epoch fencing cannot retract a DELETE already
   accepted by R2; do not restore object references until those calls have drained.
   Old physical executors may finish, but their captured authority must no longer
   commit. Preserve provider identifiers, unknown acceptance and reconciliation
   state; a remote completion is not permission for another POST.
4. Capture the database using the operator's snapshot tooling while the fence
   remains in place. Retain the actual snapshot file and a private stop/drain audit
   bundle. Write the quiescence JSON described below using actual observation times
   and the SHA256 of that bundle. The database fence must fall between `stoppedAt`
   and `writesDrainedAt`; capture and verification must follow the drain.
5. Run `attest` **before overwriting the live database**. It hashes the actual
   snapshot and audit-bundle bytes, verifies the fresh fenced Worker, compares the
   repository migration checksums with completed database migrations, and checks
   the closed epoch/fence time and absence of source-epoch or later dispatches.
   Its exclusively created, mode-0600 proof file binds these facts. The stop/drain
   bundle is operator evidence; the CLI does not claim to stop every consumer.
6. Maintain that quiescence continuously, restore the exact attested snapshot,
   and point `DIRECT_URL` at the restored schema. Use `inspect`, then `begin` with
   the proof and actual snapshot file. Both epoch arguments must equal the proof's
   source epoch. If any live epoch exceeded it, stop: the command returns
   `restore_snapshot_history_unknown`. Supporting such a tail needs separate
   live-facts recovery tooling; there is no trust flag or implicit higher bump.
7. Begin checks the restored closed epoch, exact fence time, schema and migration
   chain under the epoch lock. It commits the next closed epoch plus one proof-bound
   `rs2` restore obligation in a standalone transaction. Registration follows commit.
   Retry the same proof after response loss; never invent another source pair.
   `inspect` discovers the exact initial dispatch if begin's response was uncertain.
8. Follow exact page receipts using `inspect --dispatch-id` while the Worker remains
   fenced. Stop at an exact page reporting `metadataReady: true` (`redispatch`).
   This committed boundary seals deferred object plans before any product
   registration. Successful object transforms remain metadata work; every PUT
   fences its planned key and refreshes a bounded physical-write drain. Domain recovery must
   preserve charged counts, deadlines, usage settlements, provider IDs and audit
   history. Successful selection results require validation and re-encoding under
   the new binding; old results never authorize a repeated provider request.
9. At that boundary, deploy the Worker in `closed` mode, keeping database admission
   closed and Cron/legacy consumers stopped. This allows current callbacks and
   normal registration without admitting new intake. Resume only the exact
   metadata-ready page. The CLI requires `fenced` health for earlier metadata
   pages and `closed` health for redispatch; `open` health is refused. No command
   changes either mode or reopens intake.
10. After a repaired deployment, explicit `resume --dispatch-id` may restart a known
   errored or terminated instance. The CLI proves the current registered source
   pair, describes the deterministic instance, rechecks the phase-appropriate Worker mode and
   database authority, then records the after-description. An already-completed
   instance requires its exact committed page receipt. An unconfirmed restart
   returns a typed failure instead of creating another restore or epoch. A new
   fenced deployment version is allowed for this already-admitted repair.
11. Verify every redispatch cursor/receipt, the complete recovery map and platform
    gates before resuming Cron and separately reopening intake. Keep uncertain provider outcomes parked with
    their recorded checkpoint. Do not reset budgets or deadlines to pass a gate.

Use a private operator env file with explicit `DIRECT_URL` and `API_ORIGIN`.
Pooled PostgreSQL URLs and noncanonical HTTPS origins are refused. The selected
schema must contain its own epoch and migration tables; missing tables cannot
fall through to `public`. The CLI defaults to `apps/api/wrangler.jsonc`; `--config`
and `--env` select another explicit configuration. Its `MAINTENANCE` binding must
belong to account `5359f28d385b8632c3abee12d1f5b011`. Wrangler uses its existing login
or an operator-provided `CLOUDFLARE_API_TOKEN`, without a credential-file reader.

```sh
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore inspect
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore fence --expected-epoch 6
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore attest --snapshot /private/snapshot.dump --quiescence /private/quiescence.json --quiescence-evidence /private/drain-evidence.tar --proof-out /private/snapshot-proof.json
# Restore the attested bytes while every consumer remains fenced/stopped.
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore begin --expected-epoch 7 --fence-above-epoch 7 --proof /private/snapshot-proof.json --snapshot /private/snapshot.dump
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore inspect --dispatch-id <UUID>
bun --env-file=/private/operator/restore.env run --cwd packages/services execution:restore resume --dispatch-id <UUID>
```

The numbers are examples, not a resource selection. Quiescence JSON uses actual
UTC timestamps with exactly three fractional digits and this strict shape:

```json
{
  "stoppedAt": "2026-10-31T10:00:00.000Z",
  "writesDrainedAt": "2026-10-31T10:02:00.000Z",
  "capturedAt": "2026-10-31T10:03:00.000Z",
  "verifiedAt": "2026-10-31T10:04:00.000Z",
  "evidenceSha256": "<64 lowercase hex characters from the actual audit bundle>",
  "consumers": {
    "httpIngress": "fenced", "cron": "stopped", "cleanup": "stopped",
    "nativeDispatch": "deferred", "localDispatch": "deferred", "legacyWorkers": "stopped"
  }
}
```

This template is not proof that a stop or drain occurred. The snapshot file,
proof and audit bundle must stay private; they are operator artifacts, not a new
application keystore. A fresh begin requires the same captured fenced Worker
version. The CLI never prints snapshot contents or database credentials.

`registration_pending` or `begin_unconfirmed` requires inspection and retry of
that same admitted proof. Internal page receipts retain seven days after commit.
A missing first receipt is eligible until seven days after the later of dispatch
creation and its frozen due time. After retention, an operator chooses a fresh
bounded pass or explicit heal; automatic recomputation of an expired page is refused.

The pinned Wrangler 4.156.0 supports explicit trigger instance IDs and JSON
trigger/describe/restart output. Metadata is passed as raw argv. The installed
source and [Cloudflare Workflow command reference](https://developers.cloudflare.com/workers/wrangler/commands/workflows/)
were checked; no restore command has been run against shared resources as part
of the local acceptance tests.

The post-cutoff cleanup-plan page uses the exact metadata barrier insertion time
as its fixed horizon. Planning and barrier insertion serialize on a short advisory
lock; no new deferred plan can start after sealing. Dispatch audit timestamps use
the actual database insertion clock, not transaction start time. This makes the
interval include every admitted restore PUT plan without backdating rows.

Privacy deletion proofs describe distinct exact keys acknowledged by DELETE and
bytes known from committed metadata. They do not claim an R2 object inventory.
Unknown paid/provider outcomes remain parked; counters, provider identifiers and
settled usage are never reset to make recovery or purge pass.
