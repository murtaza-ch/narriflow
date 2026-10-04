# 07 - Assistant card design

**What to build:** Purpose-specific upload, clip review, progress and exact-post confirmation cards with Narriflow's visual language and host theme support.

**Blocked by:** [04 - Apps and upload delivery](04-apps-upload.md).

**Status:** done

**Owner:** root

- [x] Replace generic response dumps with explicit product layouts; hide signed URLs and internal IDs.
- [x] Keep preview, score summary and Studio action compact; give upload a clear picker, selection and transfer states.
- [x] Respect host light/dark theme, keyboard focus and narrow card widths.
- [x] Preserve Upload Session and exact-publication decision behavior; verify real bridge rendering and publish a new resource version.

## Design

Use Narriflow's waveform mark and ultramarine action color. Light tokens are white #FFFFFF, panel #F7F8F9, ink #191919, muted #585E69, border #E2E4E9, accent #2438E8. Dark tokens follow the host with #191919 panels and #8EAEEC accent. Use the host sans face with a system fallback, 22px titles, 14px body and 12px supporting text. Footage supplies color; no decorative gradients or external assets.

Clip review places the preview and hook beside six labeled score meters, then keeps optional reasoning below a disclosure. Upload centers one file-selection area, shows generation settings as a short band, and keeps the primary transfer action in a stable footer. Progress uses one status meter and domain facts; confirmation groups destination, time, reviewed output and caption before its exact decision buttons.

Review against the brief: remove the generic field list and duplicate navigation, limit preview height, use sentence-case labels and a distinct layout for each task. Host theme integration avoids the white block visible in the user's dark Codex screenshots. Resource v2 prevents immutable v1 templates being reused after deployment.

## Comments

Claimed after the user reported poor organization in the live Codex clip/upload cards. Authentication, upload storage contracts and publication intent remain authoritative and unchanged.

Implemented purpose-specific projections in `mcp-apps/v2/views.ts` and a static themed document. The standard bridge applies the host theme/style variables on connection and subsequent context changes. No new fonts, assets, UI framework or domain scheduler are required. Old v1 source/resources are replaced, and generated bundle/build/ignore references use v2. Clip and provider text is escaped, while titles use textContent. New projection tests guard against HTML injection, private field leakage and false scheduling claims.

A temporary localhost host using the installed AppBridge and PostMessageTransport rendered the actual generated templates in Chrome. Wide 800px and narrow 390px layouts were inspected; narrow clip, upload and confirmation cards had matching client/scroll widths. Theme changes propagated from the host. A generated local fixture file enabled upload selection; a simulated failed open retained that selection and allowed retry. A simulated decline disabled further decisions. No shared-storage upload or real publication was performed. Screenshots are saved in the task's local visualization directory.

Repository lint, typecheck, fast tests and build pass. MCP integration passes 156 tests with 745 assertions. Export refresh, selected-export navigation and terminal scheduling also passed the final localhost bridge walkthrough.

Commit `658c9fe15de53587ff1756df908595544867951c` is pushed to dev. Vercel deployment `dpl_AmwFVewf7bMiLpvU8sWyq4Qep7o1` reached READY with the canonical alias assigned. All four v2 resources are readable through the actual connected Codex MCP server, with the expected MIME type and themed template. Fresh clip review and upload handoff calls succeeded. A full live file transfer and a visual observation of the new Codex card remain tracked in ticket 06; the localhost screenshots establish the implemented layout without claiming those client gates passed.

After refreshing the connection, the user confirmed that the new layout displays in Codex. The current server's resource discovery and clip template read use v2. In-card playback, button interaction and live file transfer remain separate acceptance checks in ticket 06.
