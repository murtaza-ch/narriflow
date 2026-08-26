# Deepen the Clip Composition Plan

**Status:** in-progress

## Problem statement

Creators use Studio to decide how a clip will look and sound, then trust Narriflow to export that composition. Center, Fit, Automatic Speaker Composition, explicit Split, Screen/PiP, and B-roll now resolve through one Clip Composition Plan in Studio and the worker. Their geometry, evidence eligibility, fallbacks, and B-roll conflicts no longer have separate preview and export implementations.

The remaining work is narrower. Captions, text, logos, transitions, output treatment, audio scheduling, and audio-only rendering still need complete plan ownership and shared adapter fixtures. Analysis extraction and multi-target encoding also need measured resource budgets. Tickets 07 through 10 cover those gaps, and ticket 11 closes the remaining adapter contract after they land.

This project has no production users or mixed-version deployment requirement. The base-video legacy selectors and renderers were removed after browser, FFmpeg, database, and failure-path verification. Analysis capability switches remain because they provide typed plan fallbacks when a detector is disabled. They never select another renderer.

## Solution

Introduce one deep, platform-neutral Clip Composition Plan module. Its single planning interface receives the frozen Clip Editor Document, validated source facts, durable composition evidence, resolved asset availability, feature capabilities, and all requested output targets. It returns an immutable, versioned plan that describes the edited timeline, exact target canvases, ordered visual layers, source crops, audio schedule, overlay order, typed composition notices, and the evidence still needed to replace a provisional fallback.

The planner performs no I/O and emits no CSS or FFmpeg strings. Studio becomes a web preview adapter over the plan, while Clip Render Attempt supplies frozen inputs and resolved evidence to an FFmpeg adapter. A missing or failed analysis produces a truthful provisional or degraded plan rather than scattered caller-specific guesses. Valid evidence is keyed and reused across modes and targets, so one source-window analysis is not repeated for every aspect ratio or compatible layout.

The planner is now the only base-video composition path. Studio translates active plan scenes into browser media geometry, and Clip Render Attempt resolves evidence and assets before compiling the same plan to FFmpeg. Missing analysis or optional media produces a typed provisional or degraded plan. No compatibility renderer exists.

## User stories

1. As a creator, I want Studio to use the same composition decisions as export, so that the preview is a reliable promise.
2. As a creator, I want the selected aspect ratio to use the exact crop and layer geometry that its export will use, so that changing formats is predictable.
3. As a creator, I want Auto framing to follow the same analyzed scenes in preview and export, so that speaker changes do not surprise me after rendering.
4. As a creator, I want Split framing to show the detected per-scene speakers in Studio, so that I am not editing against fixed placeholder crops.
5. As a creator, I want Split framing to fall back only for the targets or scenes that cannot show distinct speakers, so that one incompatible format does not degrade every output.
6. As a creator, I want Screen framing to use the same top-screen and bottom-speaker geometry in preview and export, so that slides and facecam content stay visible.
7. As a creator, I want a confirmed picture-in-picture crop fitted by one rule, so that Studio and export cannot disagree about the facecam rectangle.
8. As a creator, I want Fit framing and its background to win by the same precedence rule everywhere, so that stale framing fields cannot produce two interpretations.
9. As a creator, I want Center framing to skip analysis and use the same static crop everywhere, so that a simple choice stays fast and deterministic.
10. As a creator, I want B-roll precedence to be visible in Studio before export, so that split or screen fallbacks are not hidden.
11. As a creator, I want B-roll to occupy the same edited-time windows in preview and export, so that cutaways start and stop at the playhead positions I chose.
12. As a creator, I want manual speaker-layer changes applied to the same scene and target in both adapters, so that move, resize, crop, rotation, and reset are dependable.
13. As a creator, I want a small detector-boundary change to retain a valid manual override when current matching policy permits it, so that harmless re-analysis does not discard work.
14. As a creator, I want background images to fall back to the chosen color by the same rule, so that an unavailable image never produces a blank frame.
15. As a creator, I want unavailable optional media to degrade independently, so that one logo, music, sound effect, background, or B-roll failure does not discard the rest of the composition.
16. As a creator, I want Studio to say when framing analysis is still pending, so that an approximation is not presented as exact.
17. As a creator, I want Studio to identify the effective fallback when my requested layout cannot apply, so that I understand what export will do.
18. As a creator, I want composition notices scoped to the affected aspect ratio or scene, so that one warning does not make every output look broken.
19. As a creator, I want optional fallbacks to remain exportable, so that a nonessential asset problem does not block delivery.
20. As a creator, I want deterministic composition errors to stop before encoding and explain the failure, so that I do not wait for a doomed FFmpeg command.
21. As a creator, I want audio-only clips to preview the audiogram composition or clearly state unsupported visual choices, so that backgrounds are not silently ignored.
22. As a creator, I want source audio volume and mute to match between Studio and export, so that dialogue loudness is predictable.
23. As a creator, I want music offset, looping, fades, and ducking to use one edited-time schedule, so that export sounds like playback.
24. As a creator, I want sound effects to start and end on the same edited-time positions in preview and export, so that timing remains intact after cuts.
25. As a creator, I want captions, text, B-roll, logos, transitions, and watermark treatment ordered consistently, so that layers do not unexpectedly cover one another.
26. As a creator, I want edits inside deleted source ranges removed from the composition timeline, so that deleted footage and its timed layers never reappear.
27. As a creator, I want the last scene to remain active at the exact clip end, so that playback and the final exported frame agree.
28. As a creator, I want a pending analysis result adopted without reloading Studio, so that the preview improves smoothly when evidence arrives.
29. As a creator, I want harmless caption or audio edits to retain still-valid framing analysis, so that Studio does not return to a placeholder unnecessarily.
30. As a creator, I want source-window, deleted-range, or relevant layout changes to invalidate stale composition evidence immediately, so that old crops are never reused for new footage.
31. As a creator, I want switching layouts or aspect ratios to preserve playback position and buffered media, so that composition editing remains responsive.
32. As a creator, I want the second synchronized video element mounted only for scenes that need two simultaneous source views, so that simple clips do not pay the browser cost.
33. As an operator, I want one keyed analysis request per source window and evidence type, so that compatible targets and layouts do not repeat expensive detection.
34. As an operator, I want detectors over the same source window to share one extracted analysis segment, so that source decoding and temporary storage are not duplicated.
35. As an operator, I want valid durable analysis preferred over fresh detection, so that repeat exports avoid unnecessary CPU work.
36. As an operator, I want each target's decode and encode cost measured, so that any future multi-target grouping is enabled only when it saves work inside the worker's memory budget.
37. As an operator, I want complex multi-output grouping bounded by measured pixel, branch, and scene budgets, so that an optimization cannot exhaust worker memory.
38. As an operator, I want composition size bounded independently of transcript or source length, so that pathological inputs cannot build unbounded plans or filter graphs.
39. As an operator, I want plan, evidence, adapter, fallback, and resource diagnostics to carry stable identifiers, so that drift and regressions are measurable.
40. As an operator, I want no signed URLs, document contents, or raw command lines in composition diagnostics, so that observability does not leak user data or secrets.
41. As a maintainer, I want one planning interface to be the primary behavior-test seam, so that composition policy tests survive adapter refactors.
42. As a maintainer, I want the web and FFmpeg adapters to translate a completed plan without deciding precedence or fallback policy, so that a new layout is implemented once.
43. As a maintainer, I want copied geometry constants and copied parity fixtures removed, so that a policy change cannot land in only one adapter.
44. As a maintainer, I want unknown plan or evidence versions rejected before side effects, so that mixed deployments fail safely.
45. As a maintainer, I want plan decisions checked through shared fixtures and real media, so that adapter drift is caught without a second production policy path.
46. As a maintainer, I want detector failures isolated behind capability switches, so that a broken analyzer degrades to an explicit plan without changing renderers.
47. As a maintainer, I want current Clip Render Attempt and Studio Editing Session ownership preserved, so that composition deepening does not create competing lifecycle owners.
48. As a maintainer, I want one bounded plan to cover up to four requested output targets, so that adding formats does not multiply planning interfaces.

## Implementation decisions

- Add Clip Composition Plan to the domain glossary. It means the immutable, platform-neutral description of what one Clip Editor Document shows and plays over edited time for a fixed set of output targets and known composition evidence.
- Record an ADR stating that the Clip Composition Plan module owns deterministic composition precedence, geometry, timing, evidence requirements, and fallback classification. Studio Editing Session still owns client editing and preview eligibility. Clip Render Attempt still owns frozen state, analysis and asset I/O, command execution, delivery, settlement, and cleanup.
- Place the module in a shared, browser-safe workspace package with no React, Node, database, storage, Python, or FFmpeg dependency. It may depend on shared domain validators and pure time-map helpers.
- Expose one planning operation. Its result is either a ready plan or a provisional plan with typed evidence requests. Expected missing analysis, disabled capabilities, unavailable optional assets, and ineligible geometry are data, not thrown exceptions.
- The planner accepts all requested targets in one call. Each target carries aspect ratio, canonical output width and height, and the output treatment facts that can affect visible composition. The shared timeline and asset references are computed once.
- Inputs include the frozen Clip Editor Document, source media kind and probe facts, validated automatic speaker-layout evidence, validated screen picture-in-picture evidence, resolved optional-asset availability, capability controls, and target formats. Callers never pass CSS styles, local paths, filter labels, command fragments, DOM nodes, or process handles.
- Evidence requests carry a stable key derived from only the relevant source window, deleted ranges, source identity, evidence kind, and engine version. Aspect ratio, caption style, music, and unrelated edits do not create duplicate face or scene analysis.
- The planner never runs analysis. Studio may show the provisional plan and poll through its existing preview eligibility flow. Clip Render Attempt fulfills generic evidence requests through its existing internal analysis adapters, then replans. A failed request is supplied back as typed unavailability so the planner can select the documented fallback.
- Compatible analysis requests over the same source window share one extracted segment. Multi-face evidence may supply the single-face fallback when current behavior permits it. The implementation must not perform a second detector pass merely to translate the same successful evidence into another supported view.
- Automatic and explicit Split use separate source-bound evidence envelopes. Exact `shot-layout-v1` evidence drives Automatic composition. Exact `explicit-split-v1` evidence drives Split and is never inferred from an Automatic envelope.
- Exact `screen-layout-v2` evidence records the PiP decision and face-band facts needed for deterministic reuse. The worker does not rerun detection or overwrite durable evidence when analysis is disabled or unavailable.
- Do not persist a full Clip Composition Plan. The Clip Editor Document and versioned analysis envelopes remain the durable inputs. Render plans remain part of Frozen Rendering State, while Studio derives its plan from the current working document and eligible evidence.
- The plan is immutable, JSON-safe, and versioned. It has a deterministic plan fingerprint computed from canonical, bounded inputs rather than serializing the entire editor document during playback.
- The plan contains a contiguous, ordered scene timeline in edited seconds. Scenes begin at zero, cover the complete edited duration within the existing tolerance, and remain active at the exact final time. No adapter may remap source and edited time independently.
- Every target plan declares an exact integer canvas and ordered layers with stable IDs, active ranges, logical source references, destination frames, source crop rectangles, fit mode, rotation, opacity, and z-order. Normalized geometry is derived from the same canonical integer geometry so CSS and FFmpeg share rounding and clamping decisions.
- Geometry functions clamp crops and frames to valid bounds, reject non-finite values, preserve square pixels, and make codec divisibility constraints explicit. The 4:5 stacked layout must keep both tiles encodable without letting browser and FFmpeg adapters choose different half-height rounding.
- Framing precedence remains compatible. An active background means Fit. Otherwise the requested Auto, Center, Split, or Screen mode applies. Background, Split, and Screen never compose accidentally because a stale field was read directly.
- Center uses one static crop and requests no face analysis. Fit uses contain geometry over a color or image background and ignores reframe evidence. These modes are the first compatibility tracers because they are deterministic and inexpensive.
- Auto uses eligible speaker scenes per target. Targets that cannot show distinct two-up crops use the existing no-split scene sequence rather than degrading unrelated targets. Manual speaker overrides apply after automatic scene selection and remain target-specific.
- Split uses scene-aware two-up geometry when evidence contains a usable two-speaker scene. Detection unavailable, fewer than two stable faces, no two-up scenes, incompatible target geometry, disabled capability, and B-roll conflict remain typed fallback reasons. A fallback resolves to the same single-speaker behavior as today and never creates duplicate empty tiles.
- Screen uses the full source in the top tile and a confirmed picture-in-picture crop, face-tracked band, or static center crop in the bottom tile. The planner owns the 8 percent picture-in-picture margin, the 40 percent minimum crop-width gate, target tile geometry, trackability, and the fallback order.
- B-roll precedence remains compatible with the approved behavior. Automatic speaker scenes may compose below cutaways. Explicit Split or Screen with active B-roll uses the whole-clip single-speaker fallback until a separately approved composition rule changes that behavior. Studio previews and explains the same effective result.
- Optional background image, logo, B-roll, music, and sound-effect failures preserve current best-effort behavior. The planner receives resolved availability and returns a plan that omits or degrades only the failed asset. Required source failure remains a render failure owned by Clip Render Attempt.
- The plan carries a composition notice list. Each notice has a stable code, exact or provisional fidelity, affected target and scene scope, effective fallback, and whether user action is possible. It never contains provider messages or raw exceptions.
- Studio shows no notice for exact plans. Pending evidence uses a neutral analyzing state. Approximate or degraded plans use concise, accessible text that names the effective layout. Optional degradation does not block editing or export. A deterministic invalid plan blocks export before command execution and maps to a stable user-facing failure.
- When a valid plan arrives during an open session, Studio adopts it without a reload only if its input fingerprint still matches the working and cloud documents. Adoption must preserve playback position, rate, play state, selected aspect ratio, and the main media element.
- The web preview adapter renders the active plan scene and forwards layer edits as existing Studio intents. It does not call geometry, precedence, or fallback helpers outside the planner. It mounts a synchronized secondary media element only while the active plan requires two views of the same source.
- The FFmpeg adapter compiles the whole ready plan. It owns filter labels, escaping, input ordering, command syntax, and output mapping, but it cannot change scene choice, layer order, crop rectangles, timing, or fallback reasons.
- Caption cue construction, text validation, logo setting resolution, deleted-range mapping, music fade policy, speech-window construction, ducking curves, and speaker-override matching keep their current shared semantics. The planner composes their results and becomes the place that orders them; it does not fork new versions.
- Audio planning uses edited time. It declares source gain and mute, music offset and looping, clamped fades, capped ducking windows, and sound-effect placements. The browser and FFmpeg adapters translate this schedule rather than maintaining separate timing branches.
- Visual order remains compatible with existing output. Background and base video composition occur first, B-roll replaces the intended windows, text and captions use their established ordering, logo and output treatment remain in their established positions, and transitions apply at the same stage. Any intended order change requires a separate product decision and fixture update.
- Audio-only input yields the existing audiogram topology. Unsupported background behavior becomes an explicit composition notice and Studio must preview the audiogram or state the limitation. This spec does not silently reinterpret an audio-only clip as a normal video canvas.
- Plan size is bounded by existing domain limits: no more than four output targets, the validated scene cap, validated text and sound-effect counts, and capped ducking windows. The planner produces ranges and layers, never per-frame entries.
- Each target currently compiles to an independent FFmpeg decode and encode. Ticket 10 may group structurally equivalent targets only after measured pixel, branch, scene, command-size, and memory budgets prove the grouping is cheaper and safe. This work does not raise render concurrency or scene caps.
- Performance evidence records analysis executions, extracted segments, source decodes, plan duration, scene and layer counts, command count, encode duration, and peak worker RSS for representative plans. A claimed optimization must show the saved work and remain inside the current memory envelope.
- Structured diagnostics include plan version and fingerprint, evidence version and source, requested and effective mode, target, notice codes, adapter, scene count, command grouping, elapsed time, and resource measurements. They follow the repository logging convention and omit secrets, URLs, document contents, and raw commands.
- Base-video composition contracted directly to the plan-only path because the project has no production users or mixed-version fleet. The removed renderer selectors and compatibility evidence readers must not return.
- Automatic, Split, and Screen capability values are validated once at startup. Unset or `1` enables analysis, `0` disables it, and any other value fails validation. Studio mirrors each worker capability so preview and export report the same fallback.
- Tickets 07 through 10 extend the plan into timed visual layers, audio, audio-only behavior, and measured resource reuse. They must preserve Studio Editing Session and Clip Render Attempt ownership while using the existing plan-only base composition.

## Testing decisions

- The Clip Composition Plan planning interface is the primary behavior-test seam. Tests provide validated domain inputs and evidence, then assert the returned scenes, layers, geometry, audio schedule, notices, evidence requests, and fingerprints. They do not assert private helper calls, CSS declarations, FFmpeg strings, React state, or worker branch order.
- Table-driven interface tests cover all aspect ratios and resolutions; video and audio-only sources; Auto, Center, Fit, Split, and Screen; automatic and manual speaker scenes; picture-in-picture; B-roll; deleted ranges; background, logo, captions, text, music, sound effects, transitions, watermark treatment; every current fallback; missing, stale, disabled, failed, and valid evidence; and mixed target eligibility.
- Property tests prove that scenes are ordered, contiguous, bounded, and complete; crops and frames are finite and inside their source or canvas; target geometry satisfies divisibility rules; plan fingerprints are deterministic; irrelevant input changes do not request new analysis; and all validated inputs produce a bounded result.
- Evidence-request tests use recording fakes to prove one keyed request per evidence type and input fingerprint, one extracted segment for compatible requests, reuse across targets, reuse of valid durable analysis, reuse of multi-face evidence for allowed single-face fallbacks, and no analysis for Center, Fit, audio-only, disabled, or B-roll-short-circuited paths.
- The web preview adapter has focused contract tests that feed a ready or provisional plan and assert observable stage geometry, visible layers, secondary-media mounting, accessible fidelity notices, and playback preservation. These tests do not recompute expected crops with a web-only helper.
- The FFmpeg adapter has focused contract tests that feed the same plan fixtures and assert normalized command requests, target mapping, scene and layer order, optional-input omission, and stable failure classification. Pure escaping and command-builder tests remain only where they define adapter behavior.
- Shared cross-adapter fixtures replace copied picture-in-picture and crop fixtures. One fixture source generates the planner expectation; both adapters consume it. Existing duplicate web and worker policy tests are deleted only after the plan tests and adapter contracts cover the same external behavior.
- Real-FFmpeg tests render representative keyframes and audio windows for each topology and compare media probes plus approved frame and audio tolerances with checked-in fixtures. Geometry and perceptual equivalence are required where command construction changes without an approved visual change.
- Existing Clip Render Attempt interface tests prove that ready plans execute, provisional evidence is resolved or explicitly degraded, ownership loss cancels analysis and commands, invalid plans fail before encoding, optional composition notices do not become variant failures, and settlement behavior is unchanged.
- Existing Studio Editing Session interface tests prove that evidence eligibility follows the working document, stale plan results are ignored, valid results arrive without reload, playback and media ownership remain authoritative, and composition planning never becomes a second editor-state owner.
- Performance tests use representative plain, edited, automatic, split, screen, B-roll, and four-target fixtures. They assert analysis and extraction call counts, enforce command-grouping budgets, and record peak RSS before any broader grouping is enabled.
- Shared plan and adapter fixtures compare requested and effective mode, scene boundaries, layer topology, target geometry, fallback reason, audio schedule, and adapter topology. A mismatch blocks the corresponding change.
- Final verification for every implementation ticket runs uncached focused tests, affected database tests when evidence persistence changes, repository typecheck, lint, and production build. Composition changes also require a real-browser checklist and representative real-media output inspection.

## Out of scope

- New layout types, three-person or four-person grids, gameplay layouts, freeform canvas presets, or a new layout-selection user interface.
- New face, active-speaker, scene, or picture-in-picture models. Existing analysis may be reused or versioned, but model research is separate.
- Changing Clip Render Attempt ownership, Workflow Run lifecycle, Render Work Set membership, retries, settlement, notifications, delivery, or cleanup.
- Changing Studio Editing Session document ownership, Device Draft durability, cloud convergence, browser write ownership, or playback authority.
- Persisting a full render manifest or Clip Composition Plan in the database.
- Changing codecs, encoder presets, bitrates, output resolutions, watermark entitlement, hardware acceleration, render concurrency, or retry budgets.
- Raising automatic-layout scene caps, split segment caps, upload concurrency, or browser media concurrency.
- Changing caption cue semantics, transcript correction rules, deleted-range semantics, logo settings, music ducking policy, or existing optional-asset entitlement rules.
- A new collaborative editor, operation-log document, or multi-device composition protocol.
- Automatically blocking export for optional degradations. Required-source and invalid-plan failures remain blocking.
- Product changes to the current B-roll conflict policy, audio-only visual design, or manual override matching threshold beyond making current behavior explicit and consistent.

## Further notes

- Current competitors reinforce the UX direction without dictating Narriflow's implementation. OpusClip documents applicability-based layouts, per-segment layout changes, alternate layouts when screen content is not detected, and manual reframe. Descript treats scenes as timed visual compositions and exposes size, position, crop, duration, and current-scene versus all-scenes edits. Captions distinguishes Auto, Fill, and Fit as user-visible composition choices. These patterns support truthful applicability, scene-scoped editing, and direct manipulation rather than a silent export-only policy.
- Primary product references: [OpusClip layout and reframing](https://help.opus.pro/docs/article/layout-and-reframing), [Descript layer properties](https://help.descript.com/hc/en-us/articles/27197208246797-Adjust-layer-properties), and [Captions scale and content fit](https://help.captions.ai/docs/zh/settings/scale-and-format).
- FFmpeg's official filter documentation confirms the adapter shape already used here: split inputs, crop or scale each branch, then overlay or stack them. The planner should describe that composition without embedding filtergraph syntax. See [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html).
- The completed Studio Editing Session and Clip Render Attempt work are prerequisites, not targets for redesign. Their ADRs already reserve composition parity as this separate module.
- The measured 60-second, 24-scene split fixture peaked near 683 MB versus roughly 267 MB for a non-split render. This is why the spec keeps scene caps and makes multi-target grouping budgeted rather than assuming one larger filter graph is always cheaper.
- Work should proceed through dependency-ordered local tickets after the proposed breakdown is approved. Each ticket runs in a fresh task through the repository implementation, test-driven development, and code-review flow.
