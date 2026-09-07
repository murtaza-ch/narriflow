# Narriflow dashboard design study

September 7, 2026. A separate, development-only browser prototype for choosing the dashboard direction. The subsequent real-app migration is documented in [migration.md](migration.md), with a [production Chakra UI kit](http://localhost:3000/prototype/ui-kit).

- [Dashboard](http://localhost:3000/prototype/dashboard)
- [UI kit](http://localhost:3000/prototype/dashboard?view=kit)
- [Project review](http://localhost:3000/prototype/dashboard?view=project)

Run from `apps/web` with `bun run dev`. The existing app environment is required by the root layout. `/prototype/dashboard` returns 404 in production. The implementation is in `apps/web/app/prototype/dashboard` and does not change the real dashboard, shared theme, database, API, or worker.

## Agreed scope

One Krea-inspired dark direction, implemented as a coded browser demo. The first prototype covers Home → import/configure → processing → project review → preview → export/publish. The existing Narriflow navigation and project sections remain discoverable. Secondary workspace features and the full Studio are represented by entry points, not rebuilt here.

All clip text, scores, output counts, accounts, and publication results in the prototype are fixtures. The YouTube thumbnail identifies the research source; the prototype's quotations are fictional examples, not its transcript. The local caption-loop video demonstrates playback. Rendering is simulated; downloads contain sample text or SRT. Links and chosen files are not uploaded. Data lasts only in React memory and resets on reload. External thumbnails require network access.

## Design decisions

- Neutral black sidebar, #101010 canvas, #1B1B1B surfaces, slightly lighter raised controls. Media supplies most of the color.
- Softly rounded cards and dialogs, thin low-contrast borders, white primary actions, muted blue selection and focus treatments.
- Expanded workspace navigation and a compact icon rail. Tooltips preserve labels when collapsed.
- A single source composer leads the dashboard. Creation tools and recent projects follow; no redundant metrics above the work.
- Project review uses a clip index and readable result cards: preview, title, score, expandable reason, transcript excerpt, then actions.
- Publishing uses a side drawer so the selected clip remains in context. Native modal dialogs provide focus containment and Escape dismissal.
- The UI kit uses the actual Button, IconButton, Toggle, Segments, Pill, Empty, and project-card implementations rendered in the demo.
- Desktop, compact navigation, and mobile layout rules are included. Reduced-motion preferences disable transitions and animations.

## Live reference inspection

Research used the signed-in Chrome session, screenshots, and accessibility trees. The following records observed surfaces, not a claim that every paid workflow or possible state was executed.

### Krea visual system

| Page / surface | Inspected components and states | Applied lesson |
| --- | --- | --- |
| `/app` | Hero media, tool cards, model/gallery collections, navigation hierarchy | Put media above decoration; keep the primary creation action obvious |
| Sidebar | Expanded/collapsed rail, group expansion, More tools, resize control, account entry | Persistent navigation with a compact alternative |
| `/assets` | Empty library, search, filters/counts, collapsible filter sidebar, create-folder modal | Quiet empty states; compact dialogs with clear field focus |
| `/moodboards` | Library/empty state, preset cards, create entry | Give empty libraries a useful starting point |
| `/train` | Model library, example cards, training entry | Separate personal content from examples |
| `/nodes` | Projects, Apps, Examples, Templates navigation and empty/hero surface | Keep advanced tools available without expanding every choice |
| `/image`, `/nano-banana` | Rounded composer, chips, disabled actions, onboarding overlay and skip confirmation | Defaults first; contextual controls near the input |
| `/video` | Model-based composer and media controls | Reuse the same interaction structure across tools |
| `/enhancer` | Upload/asset entry, resolution choices, accordion settings and strength/detail sliders | Reveal detailed adjustments when needed |
| `/seedance-studio` | Compact rail, visual quick actions and lower composer | Let the active workspace use the canvas |
| `/edit` | Upload/asset empty state | Strong source-admission affordance |
| `/realtime` | Split canvas/example, floating toolbar and composer | Keep tool controls adjacent to the work |
| `/lipsync` | Face + speech source cards; speech modal with textarea, voice list, active blue row, tags, Cancel/Preview/Done states | Dark modal layers and strong selected-row feedback |
| `/motion-transfer` | Paired upload cards, orientation/model controls, disabled Generate, instructional video | Make dependencies between required inputs visible |
| `/3d` | Image-to-3D entry, asset picker entry, text/image mode chips, Mesh only, disabled source action | Same neutral shell; blue for source admission and selection |

Krea generated-output states, paid generations, training execution, every model-specific setting, every gallery item, and external marketing/account workflows were not executed. Earlier slow-loading screens showed skeleton sessions before resolving. Visual colors above are our chosen tokens, not extracted Krea source CSS.

### Vizard fresh source journey

Source: [Here's Apple's iPhone event... early.](https://www.youtube.com/watch?v=4nC_YTAVmls).

The original link and canonical link initially returned “This video is not available.” The user subsequently opened a successful source-admission screen in the same Chrome session, which superseded that blocker. Continued from that exact screen.

1. **Source admission:** thumbnail/title, 480p source, 09:56 duration. Duration opens a process-range popover with start/end inputs and a slider. Language selection, Get AI clips toggle, model selector, subtitle-file attachment entry.
2. **Model choice:** v1 described as faster/more clips (9 credits for this source); v2 described as deeper/fewer complete clips (11 credits). Continued with default v1. The account went from 60 to 51 credits after admission.
3. **Styling while upload runs:** upload progress, ratio choices 9:16/1:1/16:9, multi-select clip lengths (Any, <30s, 30–60s, 60–90s, 90s–3min, >3min), Featured/My template/Brand template, eight visible featured styles. Add emojis, Highlight keywords, Add B-rolls, Remove silences, Auto-censor, optional Find clip moment.
4. **Optional scheduling:** enabling Schedule clips reveals an automatic schedule summary (“starts tomorrow, 3 clips/day”), Settings, and a combined CTA. Disabled it again before generation; no automatic publishing requested or performed.
5. **Processing:** stage list Upload → Create project → Process video → Edit clips → Finalize. The current message was “Finding best parts…68%.” Copy explicitly allows leaving and offers email notification controls.
6. **Result:** [fresh project](https://vizard.ai/project/34184593), 10 clips with titles, transcript passages, scores/reasons, durations, 720p preview controls, left index, selection toolbar, and per-clip actions. An earlier existing demo project was also used while admission was blocked.

### Vizard project interactions

| Interaction | Observed behavior |
| --- | --- |
| Clip index | Numbered thumbnails and truncated titles navigate the result list |
| Sort | Highest score and timeline ordering available |
| Selection | Select all changes to a selected count; enables bulk actions and Bulk schedule |
| Batch edit | “Change clip styles” panel says only selected changes will apply; ratio, template, emojis, highlight words, silences, B-roll, auto censor; Cancel/Update count |
| Score / reason | Score is prominent; explanatory reason sits alongside transcript and actions |
| Download | Invoked on a ready clip; no separate format dialog appeared in the inspected state |
| Resolution dropdown | 720p, 1080p, 2K, 4K, AI Enhance switch, Export button |
| AI Enhance | Resolution selection and credit-bearing Enhance video CTA (31 shown); generation was not started |
| Publish | Right-side social drawer; existing account had no linked destinations, so connection prompt shown |
| Share / rename | Project sharing popover with access wording and invitation input; rename dialog inspected, no invitations sent |
| Favorites / feedback | Star and dislike controls adjacent to previews |
| Clip actions | Share, editor, trim, title/overflow controls visible. Not every icon exposed an activatable accessibility target |
| Editor handoff | Opened the fresh top clip in [editor](https://vizard.ai/editor?id=198160132&type=clip) |

### Vizard editor surfaces

Observed transcript and Edit subtitles modes; word-level transcript, search, timeline with waveform, subtitle/headline tracks, zoom, transport controls, Save. The canvas has a floating Ratio/Background/Layout toolbar. Layout opens illustrated composition choices and Apply to all.

Inspected right-side panels: AI tools (remove silence, censor, B-roll, emphasis, emojis), subtitle presets/settings (font, size, stroke, highlight), upload (My assets/Brand assets), music/sound effects (search/categories/list), B-roll (generate/upload/search), transitions (None, fades, dissolve, blur and stylized choices, Apply to all), text presets, Brand kit categories, and Generate (motion graphics/video/image; upgrade state). No timeline edits were saved.

Social OAuth, real publishing, invitations, paid upgrades, AI-enhancement execution, and destructive project/clip deletion were not executed. Connected-account scheduling in the prototype is a proposed design, not a verified copy of Vizard's connected-account form. A full Studio prototype and batch-style application are deferred from this first dashboard study.

## Review checklist

Use the bottom toolbar to switch Populated, Empty, Loading, and Import failed. Try the import dialog, caption options and More control. In a project, star/filter a clip, select clips, inspect score reasoning, rename/duplicate/delete sample clips, open quick preview, switch ratio/caption styling, export sample subtitles, and schedule a demo post. Use the UI-kit Components and Patterns tabs to inspect variants independently.

Automated verification and browser checks are recorded in `verification.md`.

## Reference refinement: September 7

Reviewed the user-selected Krea Seedance Studio camera dialog and Color panel. The import dialog now uses a near-black #0D0D0F surface, faint border, heavily dimmed and blurred backdrop, compact heading, and three neutral source tiles with descriptions below. The selected tile has a restrained outline. Input and confirmation controls sit below the choices. All dialogs share the darker surface; the publishing drawer retains its task-specific placement. Caption specimens keep style differences but no decorative radial gradients.

Replaced promotional dashboard and UI-kit copy with direct task labels, removed colored tool badges from the creation row, and simplified the automation entry. Updated library color specimens. These changes remain confined to the local prototype.
