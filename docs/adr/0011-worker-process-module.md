# Worker Process Module owns subprocess and scratch lifetimes

One Worker Process Module owns every production subprocess and scratch-directory lifetime in the worker. Callers choose the executable, arguments, accepted exit codes, operation deadline, output capture, and cancellation signal. The module owns process groups, the global five-second TERM-to-KILL grace, descendant reaping, resource sampling, bounded redacted diagnostics, and typed Workflow Failure classification. Workflow Attempt cancellation keeps its exact abort reason after the process group has been reaped.

The same module owns one normalized ffprobe read. It reports duration, audio and visual presence, playable-video dimensions, frame rate, and decodable visual presence; embedded cover art is visual media but is not playable video. Render, preview generation, transcription fallback, dubbing, ingest, auto-layout, and export bundles receive this module through construction or an options argument, with the production module as their default. Task-specific process wrappers and ffprobe parsers are not permitted.

Scratch directories are created, scoped, and removed by the module. Cleanup failures emit structured diagnostics but never replace either a successful callback result or the callback's causal failure. File reads, writes, clocks, storage operations, and provider policy remain with their existing owners.

## Considered options

We rejected keeping render-specific adapters because the same lifecycle rules had already drifted across worker tasks; exporting low-level spawn and temporary-directory helpers because that would leave escalation and cleanup policy with callers; and masking a durable result with cleanup failure because cleanup is diagnostic after the scoped work has settled.

## Consequences

New worker subprocesses and scratch directories must use this module. Task-specific deadlines remain visible at call sites, while kill escalation and diagnostic bounds remain global. Optional-media callers may still degrade according to their product contract, but they do so from the module's current typed failures and normalized inspection result rather than an older parser or execution path.
