# Large-transfer latency audit

Static inspection only. No deployed call, provider action or production transfer edit was made for this audit. Root reported 347 of 640 parts authorized after about 14 minutes. That projects roughly 26 minutes for upload at the observed rate, before additional pin work. This is a projection, not a measured completion time or proof of the bottleneck.

## What the current path does

- Python keeps four 16 MiB parts in flight. Every part computes its SHA-256 and MD5, then awaits one `authorize_part` call before PUT. The session has short state locks but no global lock around the HTTP exchange. See `multipart.py:225` and `control.py:341`.
- `ScopedMultipartControl.authorize_part` sends one checksum tuple although the existing `upload-parts` schema permits 16. A 10 GiB upload therefore needs 640 grant RPCs plus 640 R2 PUTs.
- A new grant request reads its inbox receipt, commits `begin`, then performs `uploadParts.withAuthority`, `authorize` and `finish.withAuthority`. That is four database transactions per RPC, with three ownership checks re-locking the same domain/ExecutionAttempt rows and two artifact-lock passes. The part-plan JSON also grows and is rewritten. Four native workers can contend on these rows. See `execution-transfer.ts:66`, `:145`, `:251`, and `executor-control.ts:256`.
- Pinning adds one `source-range` authorization and conditional R2 GET per part before the part authorization/PUT. Its schema accepts one part number, not an array. A full pin adds 640 range RPCs, 640 GETs, 640 part RPCs and 640 PUTs.
- Both control and R2 transports create and close an HTTPS connection per call. The measured outer durations will include DNS/TLS. The ordered digest queue can also leave completed sibling slots waiting behind one slower earlier part. Neither contribution is quantified yet.

## Smallest batching candidate, only after timing evidence

Coalesce up to the four already-ready `authorize_part` requests into one existing `upload-parts` command. A bounded flush delay must release an incomplete batch; waiting for 16 deadlocks the four-buffer pipeline. Do not pre-read 16 bodies or extend a lease/deadline. Validate the exact returned part-number set and keep checksum conflicts, owner fencing, retry/cancellation and fresh grant checks unchanged.

At ideal batches of four, upload grant RPCs fall from 640 to 160. Pin control RPCs fall from 1,280 to 800 because its 640 source-range RPCs remain. Across both phases this halves control RPC count; it does not halve storage traffic or guarantee a 45-minute combined result. Source-range batching would change the protocol and is outside this proposal. Do not cache authority or remove checks to obtain these savings.

## Prepared measurement

Only the private gate wrapper now aggregates `work_package`, fixture generation, source prefix, upload initialization, part/range authorization, GET, PUT, complete and abort durations. Each category stores counts, failures, sum/mean/max seconds, maximum concurrent calls and 15 fixed histogram buckets. No sample list, grant, key, URL, checksum or body is retained. This adds no media buffer, protocol action, retry or deadline.

Stage sums overlap under concurrency and must not be added as wall time. Authorization durations include control-client retries. They do not identify individual SQL statements or distinguish DNS/TLS, and renewal is outside this measurement. Compare authorization and storage time/concurrency before selecting a production fix. The running deployed gate still uses its original code; this checkpoint does not alter its result.

Five local Python tests pass, including failure accounting, fixed-size aggregation and four concurrent calls. These are instrumentation tests, not a cloud throughput proof. Root owns deployment and invocation.
