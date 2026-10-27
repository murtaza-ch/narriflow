# Processing Usage owns minute admission and settlement

Workspaces buy a monthly allowance of source processing minutes per UTC calendar month and a per-video length limit. Usage used to be derived on every read by summing live Projects, so deleting or purging a Project returned its minutes, and admission checked nothing that concurrent requests couldn't race past. Usage is now recorded.

One workspace-owned Processing Usage module owns admission, reservation sizing, settlement, release, operator refunds, the usage read model, and Processing Capacity. Link intake, RSS import, Autopilot, Upload Sessions, the Ingest Job lifecycle, web, MCP, and the future REST API call it; none of them computes usage.

- **Reserve at acceptance.** Every intake that will consume minutes creates exactly one Processing Usage Reservation, keyed by its Project ID, in the transaction that accepts it: the Project for link and RSS intake, the Upload Session row at open. A declared duration is reserved as-is; an unknown one reserves the smaller of the remaining allowance and the per-video cap. The period is the UTC month of admission and never moves.
- **Serialize on the Workspace.** Admission, resize, settlement, retry, refund, and the sweep take a transaction-scoped `pg_advisory_xact_lock` on a Workspace usage key, which works through the Neon pooler. Lock order is fixed: Workspace usage lock, then any Project generation lock, then row locks. Release only frees minutes, so it is a compare-and-set without the lock.
- **Settle before speech-to-text.** Settlement uses the duration probed from the stored source, never provider metadata, and runs inside whichever transaction first admits the Project's `stt` Workflow Run. A refusal releases the reservation and fails the Ingest Job and Project with a typed code in that same transaction. Later admissions find the row settled and charge nothing, and Workflow Run admission refuses any `stt` run whose usage isn't settled.
- **Settled usage is permanent.** The ledger stores the Project ID without a foreign key. Deletion, retention purge, member removal, failure, regeneration, export, and dubbing never change a settled row. Only an operator refund, recorded with actor and reason, does.
- **Capacity is derived, not stored.** Processing Capacity counts unsettled reservations plus Projects with an active Workflow Run or accepted export renders that have no run yet, computed under the same lock. Only intake admission is refused at the tier limit; capacity frees when processing reaches a terminal state, independently of minute settlement.

## Considered options

We rejected deriving usage from Projects because deletion refunded it; a stored per-Workspace counter because it drifts from intake outcomes and still needs per-intake facts for release and refund; Serializable transactions with retries, as the generated-media ledger uses, because multi-table admission retried under contention surfaces as flaky intake; settling from provider or browser metadata because declared durations are untrusted; and a separate settlement gate because the existing-generation shortcut bypassed it.

## Consequences

The usage read model reports settled, reserved, and remaining minutes, capacity in use, and the per-video cap, and every surface renders it. Upload sources are pinned before probing so the settled duration describes the processed bytes (see the 2026-10-07 amendment to [ADR 0005](0005-upload-session-intake.md)). A worker sweep releases reservations stranded by crashes but never touches completed intakes waiting for their generation handoff. A manual retry re-admits a released reservation into the current period with fresh checks. The calendar UTC month remains the contract; a billing-anchor period would be a separate decision.

## Amendment 2026-10-26: credits

The allowance is now sold as credits. The domain stays Processing Usage, and its ledger, lock namespace, and seconds columns are unchanged; credits are a unit on top of them.

- **Whole-credit debits.** One credit is one started minute of a source, counted per video: `max(1, ceil(seconds / 60))`. Reserve, resize, and settle store debits as whole credits in seconds, so `reservedSeconds` and `settledSeconds` are always non-negative multiples of 60, enforced by database checks. The per-video length cap compares the source's real seconds before rounding. The whole source is charged even when only a window is processed. Monthly allowances come from the plan catalog in `packages/validators/src/pricing.ts`.
- **Measured duration.** Ingest stores `ceil(probedSeconds)` in the integer `Project.sourceDurationSeconds` column and keeps the exact duration in `sourceProbe` for media timing. This preserves the debit and the catalog's integer-second length caps: 60.01 seconds costs 2 credits, and a source even a fraction of a second over its cap is refused.
- **Catalog capacity.** Processing Capacity comes only from `planLimits(tier).processingCapacity`: 2/5/10/20 for Free/Creator/Pro/Business. Admission and the usage summary use that same limit. Environment variables cannot override it; worker concurrency controls govern execution separately.
- **Read model.** The summary reports `usedCredits`, `reservedCredits`, `limitCredits`, and `remainingCredits`, which sum to the limit until a downgrade puts the Workspace over it (remaining then clamps to zero), plus `periodStart` and `renewsAt`, the next 00:00 UTC on the first. Credits don't roll over. The exhausted refusal is `credits_exhausted`, with credit-named details and `renewsAt`.
- **No implicit admission.** Settlement no longer admits an intake that has no live reservation. A missing row is a defect and throws; a released one is refused with `credits_reservation_released` and recovers through the manual retry, which re-admits through reserve with fresh checks.
- **Inactive Workspaces are refused at reserve.** Reserve checks the Workspace status under the usage lock, so a new intake can't be admitted for a restricted or unpaid Workspace. Settlement still refuses one too.
- **Billing shares the lock.** `lockWorkspaceUsage` is exported, and Workspace Billing takes it before committing an access-projection change, so an admission cannot interleave with a restriction. Lock order is unchanged: usage lock, Project generation lock, row locks.

Retrying or regenerating the same Project is free; a new import of the same source is a new Project and is charged again.
