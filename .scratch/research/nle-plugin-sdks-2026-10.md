# Narriflow editor plugin feasibility

Checked 2026-10-25 against official Adobe and Blackmagic sources and the local Narriflow codebase. This is a feasibility recommendation. No plugin implementation or editor runtime testing was performed. Skills applied: `research`, `unslop`.

## Recommendation

Yes, Narriflow can integrate with all three applications. Build Premiere first, Resolve Studio second, and After Effects when customer demand justifies its separate integration. This order is an engineering recommendation based on the SDK paths below.

Start with a small workflow: connect a Workspace, browse existing Projects and scored Clips, then download and import a finished clip. Next, add editable Editor Timeline and SRT import where the host supports it and compatibility tests pass. Sending selected source media or a rendered sequence/composition to Narriflow can follow. Share the Narriflow service client where practical, with separate code for each editor. Reconstructing caption animations, reframing, and arbitrary timelines as native layers requires separate host-specific work. SDK availability alone does not establish that those round trips preserve every edit or effect.

## Premiere Pro

- UXP is production-ready from Premiere 25.6. Adobe announced general availability on December 16, 2025. Use UXP for new development. CEP remains available, but Adobe now has a retirement schedule. [GA announcement](https://blog.developer.adobe.com/en/publish/2025/12/uxp-arrives-in-premiere-a-new-era-for-plugin-development), [Premiere extensibility overview](https://developer.adobe.com/premiere-pro/).
- The documented 25.6 APIs cover the essential workflow. `Project.importFiles` imports local media; `getActiveSequence` and `getSequences` identify the sequence to send. `SequenceEditor` supplies insert, overwrite, clone, and remove actions. `EncoderManager.exportSequence` exports a specified sequence immediately or through Adobe Media Encoder. Exporting a sequence is confirmed; exporting an arbitrary selection of timeline clips as one independent render needs validation. [Project](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project), [SequenceEditor](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor), [EncoderManager](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager).
- A panel can call Narriflow over HTTP, subject to manifest network permissions. UXP is not a full browser, so do not assume the existing web app can run unchanged inside it. [Networking](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/), [UXP introduction](https://developer.adobe.com/premiere-pro/uxp/introduction/).
- Distribution uses `.ccx` packages. Marketplace publication needs Adobe review; direct distribution does not. Development uses UXP Developer Tool with Premiere developer mode enabled. [Distribution](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/overview/), [Development setup](https://developer.adobe.com/premiere-pro/uxp/plugins/).

## After Effects

- Adobe supports panels, scripts, and native plugins for workflow automation and media management. For a panel shipping today, CEP HTML/CSS/JavaScript plus ExtendScript is the established path. Adobe's CEP 12 compatibility table explicitly includes After Effects 25.0, and `CSInterface.evalScript` calls the host scripting engine. A smaller utility can use a dockable ScriptUI panel with `.jsx` scripts. [After Effects overview](https://developer.adobe.com/after-effects/), [Adobe CEP cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md), [Scripts](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html).
- Do not apply Premiere's UXP support claim to After Effects. Adobe's September 2026 roadmap schedules the After Effects UXP public beta for November 2026. It does not establish a production release or minimum supported AE version. If AE work starts after that beta arrives, reassess before committing to a new CEP panel. [Adobe migration roadmap](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications).
- Composition export is feasible through documented rendering tools. Adobe documents `aerender` with a chosen project, composition, output, and frame range. ScriptUI file/network operations require the user's scripting preference. CEP extensions have a separate `.zxp` packaging/signing workflow. [Automated rendering](https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html), [Scripts](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html), [CEP cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md).

Adobe plans to remove CEP from flagship applications starting December 2029. Premiere stops accepting new CEP Marketplace submissions in December 2027; After Effects does so in December 2028. ExtendScript is unaffected by this transition. These are announced milestones, not reasons to assume AE UXP already ships. [Roadmap](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications).

## DaVinci Resolve

- The current Resolve 21.1 manual confirms Studio-only Workflow Integration plugins built as Electron applications using Resolve's JavaScript API, plus Python or Lua scripts. Plugins open through `Workspace > Workflow Integrations`. SDK details and samples ship under `Help > Documentation > Developer > Workflow Integrations`. The manual also describes an existing integration that imports media into projects. [Official manual, pages 4324-4325](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21.1_Reference_Manual.pdf#page=4324), [Studio overview](https://www.blackmagicdesign.com/products/davinciresolve/studio).
- External scripting is Studio-only. The current manual distinguishes console-only access from control by local external applications and network applications. Free should therefore not be advertised as supporting the proposed integrated Narriflow panel. Limited internal scripting is a separate capability. [Manual, page 106](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21.1_Reference_Manual.pdf#page=106).
- Blackmagic staff state that Free supports console/menu scripts, while UIManager-based scripts require Studio, enforced since 19.1. Staff also distinguish Python scripting on Linux from unavailable HTML Workflow Integrations. Those statements date to 2023-2024. Use Windows/macOS as the proposed panel scope, but mark the current platform matrix for confirmation in the shipping SDK. Do not promise the same Electron panel on Linux. [Free scripting clarification](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=205175), [UIManager clarification](https://forum.blackmagicdesign.com/viewtopic.php?f=21&start=0&t=149311), [Linux clarification](https://forum.blackmagicdesign.com/viewtopic.php?p=965054&t=184838).

## Unresolved before estimating delivery

- Resolve's current plugin minimum version, Electron/native-module architecture requirements, exact Windows/macOS/Linux matrix, and Mac App Store edition restrictions were not verified from the shipping SDK. The installed SDK was unavailable locally.
- Resolve's exact import, timeline-edit, render-job, and completion APIs need checking in that SDK. The integration model is confirmed; a complete Narriflow round trip was not tested.
- AE UXP's actual beta release, API coverage, minimum version, and eventual production date remain unverified. The November date is Adobe's announced target.
- Each editor needs a small runtime test for login, long uploads/downloads, export completion, media import, and supported codecs. Premiere sequence-range behavior and native editable-caption parity need explicit tests. No editor runtime testing occurred in this research.

These gaps affect scope and support promises. They do not change the feasibility recommendation.

## Narriflow readiness and suggested first scope

Repository inspected 2026-10-25. These are code findings, not deployed API or editor runtime verification.

- The REST API already lists Projects and Clips, including virality ordering, accepts file uploads, starts generation and exports, exposes Operation Status, and issues download URLs. See [REST routes](../../apps/web/lib/rest-api/app.ts).
- `GET /api/v1/clips/{id}/timeline?format=xmeml|fcpxml|edl` already returns a current-revision Editor Timeline, SRT text, and a 15-minute Download Grant for the original source. See [timeline service](../../packages/services/src/clip-timeline.service.ts) and [timeline generation](../../packages/services/src/clip-timeline.ts).
- Editor Timelines preserve the kept source ranges and linked original audio. They do not reproduce Scenes, overlays, music, B-roll, reframing, or burned-in captions as native layers. The SRT carries caption text and cue timing. See [editor timeline docs](../../apps/web/content/docs/editor-timelines.mdx).
- Timeline generation requires retained source media, measured source facts, and a supported frame rate. Previously ingested Projects without a source probe cannot export an Editor Timeline. See [timeline checks](../../packages/services/src/clip-timeline.ts).
- REST currently accepts Workspace API keys, not OAuth bearer tokens. The API is Business-only. A first private pilot can use a user-supplied key; broad plugin availability needs an explicit access and sign-in decision. See [authentication](../../apps/web/lib/rest-api/app.ts) and [integration admission](../../packages/services/src/integration-admission.ts).
- The existing timeline ticket records deterministic verification but explicitly says imports have not yet been opened in Premiere, Final Cut, or Resolve. Real editor testing is the first compatibility gate. See [timeline ticket](../automation/issues/10-timeline-export.md).

Recommendation, based on workflow fit rather than measured customer demand: Premiere first, Resolve Studio next, After Effects after that. Start with one useful panel workflow: connect a Workspace, browse existing Projects and scored Clips, and import a rendered clip. Next, add editable Editor Timeline and SRT import where the host supports it and compatibility tests pass. Uploading selected source media and rendering an active sequence or composition for cloud processing can follow.

Keep generation, usage admission, exports, and retries in the existing Narriflow services behind REST. Share API calls, Operation Status handling, and download logic where host runtimes permit; each editor needs its own host integration and packaging. Reproducing Narriflow caption animation and composition as native editor layers is separate work from importing a rendered clip or a cut timeline.

No product implementation, migrations, editor installation, or deployed changes were performed for this feasibility check.


## Opus validation (2026-10-25)

Second pass against the same official pages and the code. The recommendation holds. Corrections and additions:

- The Premiere GA post confirms 25.6 as the minimum version but gives no exact date; the URL places it in December 2025. The post does not mention CEP retirement. The retirement schedule comes from the September 2026 roadmap only.
- `EncoderManager.exportSequence(sequence, exportType, outputFile, presetFile, exportFull)` has no in/out or work-area parameters. `exportFull` is undocumented. Treat "export the whole active sequence" as confirmed and "export the in/out range" as unverified. `encodeFile` accepts in/out points, but for media files, not sequences.
- The UXP `Project` reference lists no XML, FCP XML, or SRT import method, and `SequenceEditor` lists no caption or marker methods. Importing a Narriflow `xmeml` timeline and SRT through `importFiles` is plausible because Premiere's normal Import accepts those files. That path needs a runtime test before we promise "editable timeline in Premiere".
- Sign-in: REST accepts only `nf_` Workspace API keys today, but the MCP surface already verifies OAuth tokens (`apps/web/lib/mcp-auth.ts`, `packages/mcp-core/src/mcp-auth.ts`). A public plugin should reuse that OAuth path for REST instead of asking editors to paste API keys. A private pilot can still use keys.
- Market check, secondary sources only: OpusClip appears to offer Premiere/Resolve XML export rather than an in-editor panel. In-Premiere AI tools such as Premiere Copilot already exist, so an in-editor panel matters as a workflow advantage rather than as a unique feature.
