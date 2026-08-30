# Media Cleanup owns deferred exact-key deletion

One Media Cleanup module owns durable removal of unreferenced private media after an approved producer commits its database state. A generic obligation records stable origin and cleanup class, optional Project and Clip identifiers, one exact private object key, scheduling and attempt state, an expiring claim, bounded failure state, and completion. Project and Clip identifiers are facts rather than cascading relations, so cleanup work survives deletion of its source rows.

The module admits obligations idempotently by origin, class, and object key. It owns claim, renewal, missing-object success, storage outcome classification, bounded backoff, release, rescheduling, completion, claim fencing, and identifier-safe diagnostics. The worker polls only this module. Producers still own the decision and database transaction that create cleanup intent. Clip Editor Document Persistence creates obligations atomically with accepted mutations. Detected Clip replacement inventories renders, preview proxies, derived peaks, and dub media and admits their obligations in the same transaction that removes the old Clips.

Clip duplication admits provisional obligations before starting any remote copy. Those obligations remain under a heartbeat-renewed producer claim while copies are in flight. Immediately before adoption the producer renews once more; the duplicate transaction removes every successful copy's obligation only under that still-unexpired claim and rolls back if the fenced count differs. Failed, ambiguous, or unadopted destinations are released for Media Cleanup. A producer crash or claim takeover therefore leaves each destination either referenced by the committed duplicate or recoverable by Media Cleanup, never both.

## Considered options

We rejected one cleanup executor per producer because claim and retry policy would drift; cascading obligations from Clip because committed cleanup must survive row deletion; deleting storage inside database transactions because object storage cannot commit atomically with Postgres; best-effort callbacks because a crash loses the last object reference; and running editor and generic workers together because Narriflow has no production data that needs a compatibility period.

## Consequences

Missing objects complete successfully. Temporary, persistent, configuration, cancelled, and claim-loss outcomes remain explicit and fenced. Diagnostics include origin, class, Project, Clip, attempt, phase, outcome, failure code, and elapsed time. They never include object keys, signed URLs, provider identifiers, provider bodies, or document content. New producers must use the same admission interface and add their stable origin or cleanup class to this module before creating obligations.
