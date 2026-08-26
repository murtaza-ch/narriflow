# Motion and media animation

**Status:** implementation-ready

**Vizard references:** `Meet the new Editor & Transitions`, 4 December 2025; `Animations & Mobile Access`, 12 January 2026.

## Outcome

Editors can add a small, predictable set of transitions and media animations. Studio preview remains a promise of the rendered result.

## Motion vocabulary

Keep the current whole-clip transitions:

- Cut
- Fade
- Fade to Black
- Dip White

Add:

- Cross Dissolve
- Wipe Left, Right, Up, and Down
- Slide Left, Right, Up, and Down
- Zoom In and Zoom Out

Add media motion for Scene Block images, videos, text cards, and manual B-roll:

- None
- Fade In or Out
- Scale In or Out
- Pan Left, Right, Up, or Down
- Ken Burns In or Out

Do not expose arbitrary keyframes, custom curves, rotation animation, path animation, or simultaneous animation stacks.

## User experience

- Rename the current Transitions inspector group to Motion while retaining a direct path to existing transition choices.
- Use secondary tabs for Clip transition and Selected media.
- Controls show a small live preview, duration, direction where relevant, and an `Apply to selected clips` campaign action when the edit supports bulk use.
- The current clip may still use Studio's existing apply-to-all behavior. Selection-scoped operations live in the project Clips tab.
- If the operating system requests reduced motion, Studio displays the first or final state and a concise label. Export still uses the chosen motion unless the user removes it.
- Unsupported combinations explain which effective fallback will render.

## Document and plan contract

Extend the Clip Editor Document with versioned media-motion values attached to the media placement or Scene Block they animate. Keep the current top-level transition field compatible and extend its validator with the new types.

The Clip Composition Plan resolves:

- active range
- entrance and exit duration
- direction
- start and end transform or crop
- opacity schedule
- clipping bounds
- target-specific integer geometry
- fallback notice

The web and FFmpeg adapters translate the plan. They do not calculate separate curves or precedence.

## Timing and precedence

- Clamp transition and animation duration to the active media interval. The default is 0.4 seconds for transitions and 0.5 seconds for entrances or exits.
- A media placement may have one entrance and one exit from the supported family.
- B-roll replacement still wins over source composition in its active range. Its animation applies to the B-roll layer, not the hidden source.
- Scene transition and media entrance cannot both control the same property over the same boundary. The planner applies the scene transition first and suppresses the conflicting entrance with a typed notice.
- Caption animation remains independent and keeps the current caption engine.
- Motion does not change edited duration.

## Render and performance rules

- Use pure normalized interpolation helpers shared by preview and render fixtures.
- FFmpeg compilation uses bounded filter branches and keeps existing shared encode paths where topology permits.
- Ken Burns uses target-specific crop interpolation derived from canonical integer geometry.
- Cap animated media count and simultaneous animated layers per document. Exceeding the limit blocks the new edit before save.
- Measure representative four-target renders before enabling multi-output motion by default.

## Failure behavior

- An unknown motion version blocks adoption or export with a stable error.
- A known but unavailable optional asset follows the asset's existing fallback and omits its animation.
- A target that cannot satisfy the requested crop receives the documented fit fallback and composition notice.
- Reduced-motion preview never changes saved state.

## Entitlements and analytics

- Free users may preview motion presets. Creator and above may persist and export them.
- Pro and Business may apply eligible motion to selected clips.
- Record motion family, duration bucket, target count, apply scope, fallback code, and render outcome. Do not record text or asset URLs.

## Migration and rollout

1. Add validator support and plan fixtures while keeping existing transition output unchanged.
2. Move current transitions through the Clip Composition Plan.
3. Add Cross Dissolve, then directional wipe and slide.
4. Add media fade and scale, then pan and Ken Burns.
5. Enable selection-scoped apply after single-clip behavior is stable.

## Acceptance criteria

- Existing Cut, Fade, Fade to Black, and Dip White preview and render remain compatible.
- Each new motion has one shared fixture consumed by browser and FFmpeg adapter tests.
- Exact start, exact end, short media, target changes, B-roll precedence, Scene Block boundaries, deleted source ranges, and reduced-motion preview have tests.
- Unsupported combinations produce a visible, typed fallback rather than silently changing output.
- Performance tests enforce branch, layer, document-size, and memory budgets.

## Out of scope

- A keyframe editor, third-party motion templates, arbitrary easing editors, animated captions beyond the existing caption engine, or motion-graphics generation.

