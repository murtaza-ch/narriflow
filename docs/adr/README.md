# Architecture decisions

[CONTEXT.md](../../CONTEXT.md) defines the domain vocabulary. These records explain architectural decisions and their trade-offs. A glossary entry does not need an ADR merely because it names a domain concept.

Add an ADR when a decision is costly to reverse, would surprise a reader without its context, and chooses between meaningful alternatives. Otherwise, document the rule beside its owner or in [AGENTS.md](../../AGENTS.md). Update an existing decision when its constraints change.

## Decisions

- [0001: Workflow Runs own one fenced lifecycle](0001-workflow-run-lifecycle.md)
- [0002: Studio Editing Sessions own the client editing protocol](0002-studio-editing-session.md)
- [0003: Clip Render Attempts own render execution under Workflow Attempt fencing](0003-clip-render-attempt.md)
- [0004: Clip Composition Plan owns preview and render geometry policy](0004-clip-composition-plan.md)
- [0005: Upload Sessions own local-file intake before a Project exists](0005-upload-session-intake.md)
- [0006: Workspace Billing owns provider synchronization and access projection](0006-workspace-billing-synchronization.md)
- [0007: Social Publication Attempt owns provider delivery and uncertainty](0007-social-publication-attempt.md)
- [0008: Clip Editor Document Persistence owns canonical server mutation](0008-clip-editor-document-persistence.md)
- [0009: Authenticated Request Policy owns browser-session admission](0009-authenticated-request-policy.md)
- [0010: Media Cleanup owns deferred exact-key deletion](0010-media-cleanup.md)
- [0011: Worker Process Module owns subprocess and scratch lifetimes](0011-worker-process-module.md)
