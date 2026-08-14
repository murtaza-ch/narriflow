# Narriflow Domain Language

Narriflow turns source media into publishable short-form content through distinct intake and post-ingest processing lifecycles. This glossary fixes the language used for those domain concepts.

## Editing

**Studio Editing Session**:
One tab-local editing relationship with a clip, including its working document, history, durability, write ownership, preview eligibility, and playback position.
_Avoid_: Studio shell, editor state, editing tab

**Clip Editor Document**:
The complete revisioned edit state for one clip that can be saved to Narriflow and used to produce exports.
_Avoid_: Form state, Studio payload, edits blob

**Device Draft**:
The latest Clip Editor Document durably retained in the current browser but not necessarily confirmed by Narriflow.
_Avoid_: Cache, local copy, backup

**Studio Write Ownership**:
The exclusive right of one Studio Editing Session in a browser profile to change and synchronize a clip. Cloud revision checks remain the final protection when exclusivity is degraded.
_Avoid_: Workflow Attempt, worker lease, tab lock

## Processing

**Workflow Run**:
A persistent execution record for one idempotent post-ingest processing stage of a project, such as transcription, moment detection, clip rendering, or dubbing.
_Avoid_: Job, task, ingest job

**Workflow Attempt**:
One exclusive, time-bounded claim to execute a Workflow Run, identified by an immutable attempt ID. Only the current Workflow Attempt may update or settle its Workflow Run.
_Avoid_: Retry, worker, lease

**Partial Workflow Outcome**:
A terminal Workflow Run outcome in which an aggregate stage produced at least one successful child artifact and at least one failed child artifact.
_Avoid_: Completed with errors, partial failure

**Waiting Workflow Run**:
A Workflow Run whose current attempt has submitted work to an external provider and released its worker while awaiting a correlated result.
_Avoid_: Running lease, stalled run

**Workflow Failure**:
A stable reason that a Workflow Attempt could not produce its intended outcome, including whether another attempt may succeed without user intervention.
_Avoid_: Exception string, error-code registry

**Ingest Job**:
A persistent execution record for bringing source media into a project before post-ingest processing begins.
_Avoid_: Workflow run, upload task
