# Chakra dashboard migration

September 7, 2026. The real app now uses the design study's dark direction.

## Review locally

- [Dashboard](http://localhost:3000/home)
- [Production Chakra UI kit](http://localhost:3000/prototype/ui-kit)
- [Original design prototype](http://localhost:3000/prototype/dashboard)

The two prototype routes are development-only. The Chakra kit renders the production theme and shared controls. Its sample actions do not call APIs.

## Configuration

Chakra React is pinned to 3.34.0. The matching CLI is a development dependency in `packages/ui`. Run `bun --filter @narriflow/ui typegen` after changing the theme; root postinstall also runs it.

The official MCP server was absent. Added `chakra-ui` to the local Codex MCP configuration using `npx -y @chakra-ui/react-mcp`. A direct stdio initialize, tools/list, and list_components call succeeded. Tools include component props/examples, theme inspection, and customization. This already-running conversation does not reload its exposed tool inventory; a new session can discover the configured server.

Installed the official `chakra-ui-builder`, `chakra-ui-migrate`, and `chakra-ui-refactor` skills into `.agents/skills`; their source revisions are recorded in `skills-lock.json`.

References: [Chakra MCP](https://chakra-ui.com/docs/get-started/ai/mcp-server), [Chakra skills](https://chakra-ui.com/docs/get-started/ai/skills), [theming](https://chakra-ui.com/docs/theming/overview), [semantic tokens](https://chakra-ui.com/docs/theming/semantic-tokens), [slot recipes](https://chakra-ui.com/docs/theming/slot-recipes).

## Shared component decisions

| Use | Component and theme responsibility |
| --- | --- |
| Primary, secondary, destructive actions | Shared Chakra Button and IconButton; neutral default palette, pill shape, explicit danger palette |
| Text entry and validation | Input, Textarea, Field; shared surfaces, borders, placeholder and focus styling |
| Single choice | Select for options; SegmentGroup for a short visible set |
| Multiple choice | Checkbox with a square control; shared checked/disabled states |
| Numeric values | NumberInput with native Chakra steppers and sizes |
| Library and tool cards | Card recipe; quiet border, rounded corners, neutral surface |
| Modal tasks | Dialog recipe; near-black panel, blurred black backdrop, compact header, viewport inset and internal scrolling |
| Context-preserving side panels | Drawer recipe, including mobile navigation |
| Context actions and details | Menu and Popover recipes |
| Project sections | Tabs; overflow remains local on narrow screens |
| Optional details | Collapsible for source processing, brand settings, and folder assignment |
| Empty libraries | Chakra EmptyState through the shared wrapper |
| Data | Table recipes and the existing StatBand composition |

`packages/ui/src/theme.ts` is the source of truth. Spacing uses Chakra's existing scale. Semantic radii define the shape system. Light mode remains available, with dark as the default and a separate persisted preference. Media, brand colors, and caption artwork retain their own colors.

## Real app changes

- Persistent 232px sidebar with a 68px collapsed state. The project page keeps navigation available.
- Dashboard source composer, real creation entry points, recent project cards.
- Three import source choices using the existing file/link/RSS handlers. Podcast and caption-only entry points select their intended mode.
- Project cards and clip review cards, a titled clip index, responsive stacked previews, and quieter project chrome.
- Processing details stay expanded for new, active, failed, or partial work.
- Exports, calendar, autopilot, brand library and forms, integrations, settings, help, and project panels inherit the shared theme. Decorative grid backgrounds were removed from app surfaces.
- Studio uses the updated neutral tokens; native media, timeline, editing, and export behavior remain intact.
- Repeated dialog/menu/popover styling was removed so the shared recipes control their appearance.

## Browser inspection

Inspected the authenticated local app in Chrome using its real workspace and existing video projects. Desktop checks included 1440px and the browser's wider native viewport; narrow-screen checks used 390px.

| Area | Observed states |
| --- | --- |
| Home / projects | Real project thumbnails, empty/available creation controls, folder disclosure, navigation |
| Import | Desktop/mobile chooser, file input, link/RSS selection, focused composer |
| Project | Clips, transcript, repurpose, dubbing, review, publish, analytics, activity |
| Clip interactions | Action menu, rename dialog, trim/extend dialog, preview playback controls, format options |
| Exports | Populated list and filtering controls |
| Calendar | Empty month, scheduling entry, missing connected-account requirement |
| Autopilot | Empty rules and new-rule dialog |
| Brand | Profile library, create form, saved identity/styles, style editor |
| Integrations / settings | Integration cards; profile, workspace, members, billing, usage, social accounts, developer access, notifications |
| Help | Guides and release-note empty state |
| Studio | Loaded video preview and timeline, caption presets, layout panel, export popover, shortcut dialog, existing small-screen guidance |
| Mobile | Home, project cards, navigation drawer, import, brand creation, rename dialog, Studio guidance |

Visual fixes from this pass: semantic radii overriding base radii; squeezed mobile clip metadata; source choices pushing the mobile composer down; dialogs touching viewport edges; over-wide libraries; noisy folder selectors; old decorative publishing/brand headings; undefined `bg.canvas` references.

## Verification limits

This is UI migration verification, not a new end-to-end media or payment acceptance run. No external social posts, paid generation, destructive project actions, billing changes, or new account connections were submitted. Existing processing/render/publication suites were exercised through the fast test command; disposable-schema PostgreSQL gates were not required by these UI-only changes. Notifications are informational in the existing app. Studio still requires a larger display.

## Completed checks

- `bun run lint`: passed, 867 files checked.
- `bun run typecheck`: passed, all 12 package tasks.
- `bun run test`: passed, all 7 package tasks. Web: 601 passed, 5 skipped; UI: 9 passed. Database-dependent suites report skips in the fast run.
- `bun run build` in `apps/web`: optimized production build passed.
- Chakra typegen and `git diff --check`: passed.
- Component kit: light/dark themes, invalid and disabled fields, menu, tabs, and mobile dialog inspected.
- Search: actual project/clip results inspected; corrected header/input width and dialog name.
- Import: invalid URL retains its guidance and disables Continue.
- Sidebar: expanded and collapsed layouts inspected. Browser viewport override cleared after verification.
- A style hydration warning during theme hot reload disappeared after restarting the dev server and reloading. The clean component-kit load had no issues badge.

## Design parity follow-up — September 7, 2026

The reference uses more than dark colors: a spacious source composer, compact creation tools, media-led libraries, neutral rounded panels, readable clip titles, and restrained selection color. This follow-up carries those choices into the real app and the states missing from the prototype's placeholder secondary views.

### Changes

- Home now follows the reference composition, including the wide-screen heading, compact source controls, four creation tools, recent-project grid/list controls, and channel automation panel. Repurpose and Dubbing open a recent-project picker and reach the corresponding real project tab.
- Shell spacing, sidebar groups, account placement, workspace selector, search trigger, and section labels match the reference more closely. Mobile creation tools use two columns.
- Project headings, clip typography, preview size, clip index, selection treatment, reasoning disclosure, and action placement were revised. Existing render, export, publishing, trim, and editing handlers remain wired.
- Import uses a contained near-black source chooser with aligned icon tiles. Processing, upload progress, validation, and recovery surfaces follow the same panel language.
- Calendar now displays an empty month/week grid and supports previous/next period and Today navigation while retaining filters. The empty list offers a scheduling entry point.
- Exports, autopilot rules, social connections, publication rows, dubbing results, generated content, billing plans, workspace/profile settings, brand forms, and reusable scenes use rounded neutral surfaces. Caption-library samples are compact; caption placement remains available in the editor.
- Shared status pills, icon buttons, segmented controls, empty states, and destination-shaped loading layouts provide consistency across routes. Auth/onboarding surfaces and Studio's error panel were also refined.
- `/prototype/ui-kit` includes empty, status, library-loading, project-loading, import-loading, and settings-loading examples using production components.

### Follow-up verification

- Compared reference Home, Projects, clip results, source/configuration dialogs, processing, empty/loading states, and the secondary-view placeholder pattern with the real implementation.
- Chrome reviewed the updated real Home, clip results, Dubbing, source chooser, exports, calendar month/week, brand library, workspace settings, and shared UI kit.
- Confirmed the Dubbing project picker reaches the selected project's Dubbing tab. Verified next-month navigation and switching to a week in that selected period.
- At 390px, Home, the project picker, Dubbing, and import fit the viewport. An invalid import link leaves Continue disabled. Viewport emulation was cleared afterward.
- `bun run lint`, `bun run typecheck` (12 tasks), `bun run test` (7 tasks), Chakra typegen, optimized web build, and `git diff --check` passed.

The follow-up did not create or mutate media, posts, subscriptions, brand assets, or connected accounts. Populated dubbing/publication states and failure/retry branches were styled through source review; they were not all triggered live. The existing desktop requirement for Studio remains. The prototype's secondary placeholders were used as visual guidance, not copied over real features.

## Second visual review

The next review found layout and interaction issues that the color migration had left behind:

- Project details and brand controls occupied two separate rows before the clips. They now share a header disclosure, with deletion inside the details section. On the reviewed desktop viewport, the first clip moved upward by about 110px and its actions became visible without scrolling.
- Collapsed transcript previews showed only the first utterance. They now use the complete clip transcript, with the same line limit and full expansion control.
- The clip index could highlight a newly intersecting row instead of the current row. It now derives the active clip from the displayed order and viewport position. Jumping to clip 3 was checked in Chrome and correctly selected clip 3.
- Project filters now use separate search/sort and status rows. Fresh mobile grid/list views fit 390px without page overflow. Mobile list rows retain status badges.
- Project card title areas align, score indicators have descriptive accessible labels, and desktop delete overlays appear on hover or keyboard focus. Touch controls remain visible.
- Short desktop sidebars have less wasted vertical space. Settings navigation is a compact horizontal strip on mobile, and shared page headers stack actions below titles on narrow screens.
- Export date fields have visible From/To labels and responsive widths. Filtered empty results offer Clear filters. The calendar marks Today using the workspace timezone.

Validation: lint without warnings, typecheck, all seven fast test tasks, the optimized web build, and whitespace checks passed. Browser checks used existing data and did not submit deletion, publishing, billing, or generation actions.

## Button and filter consistency

Standard app actions and single-line filters now use one shared 36px height, 13px text size, and 12px corner radius. The theme defines the compact, standard, medium, and large size scale for buttons, inputs, selects, native selects, number inputs, dates, and segmented controls. Shared defaults use the standard size; dense Studio tools retain their explicit compact sizes. The home submit control also uses the standard button size.

Removed the Select wrapper's private height map and page-specific toolbar height compensation. Normal app actions no longer alternate between extra-small, small, and medium sizing. Project status filters use the same selected outline treatment as exports and calendar filters. Export filter labels now match the date labels.

Browser measurement on Exports confirmed 36px / 13px / 12px for search, dropdowns, dates, Apply, status filters, view controls, downloads, and Open. The page fits at 390px. A resolved-recipe regression test checks matching geometry and typography across control types, including Chakra's inherited styles. Lint, typecheck, the fast test suite, and the optimized web build passed.
