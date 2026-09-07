# Studio Editing Sessions own the client editing protocol

A clip has one tab-local Studio Editing Session whose deep module owns the working Clip Editor Document, history, Device Draft durability, Studio Write Ownership, cloud convergence, preview eligibility, and source-anchored playback behind a snapshot/intent/operation interface. React is a presentation adapter, while server-side Clip Editor Document persistence and export creation remain separate domains; this concentrates sequencing in one test seam without expanding this decision into collaborative editing or the later persistence architecture recommendation.

## Considered options

We rejected keeping the protocol in React effects because it leaves correctness in call-site ordering; a single Promise-returning command interface because immediate edits and asynchronous barriers have different contracts; shared multi-tab sessions and device-wins convergence because they require collaborative or operation-log semantics; and absorbing export creation or server persistence because those are separate architecture candidates.

## Consequences

The session accepts synchronous intents and typed asynchronous operations, resets history when a newer cloud document becomes its baseline, uses conservative whole-document conflict choices, and depends on browser and in-memory adapters for durability, coordination, time, media, and cloud access. Migration transfers one protocol at a time through a temporary React compatibility adapter so no behavior has two active owners.
