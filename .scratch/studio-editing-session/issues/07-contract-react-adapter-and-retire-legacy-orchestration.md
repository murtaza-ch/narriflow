# 07 — Contract the React adapter and retire legacy orchestration

**What to build:** Leave React responsible only for presentation by completing selector-based integration, deleting migrated sequencing code, and proving the deep Studio Editing Session is the one interface callers and behavior tests use.

**Blocked by:** 06 — Make the Studio Editing Session authoritative for playback.

**Status:** ready-for-agent

- [ ] React selector hooks subscribe to focused session snapshot projections without top-level playback rerender churn.
- [ ] Open tools, dialogs, zoom, responsive layout, export options, and visual selection remain presentation state.
- [ ] All document, durability, ownership, cloud, proxy, analysis, and playback sequencing has one session owner.
- [ ] The temporary compatibility adapter contains no protocol logic and is removed or reduced to rendering translation only.
- [ ] Migrated refs, effects, direct browser calls, and shallow helper interfaces are removed.
- [ ] Shallow orchestration tests are deleted only where equivalent session-interface tests cover their observable behavior.
- [ ] Independent Editor Document, timeline math, caption, and renderer-alignment tests remain.
- [ ] A real-browser checklist covers recovery, cooperative and forced takeover, disabled storage/coordination, offline sync, proxy replacement, and source-anchored playback.
- [ ] Structured diagnostics include identifiers and typed outcomes without document contents.
- [ ] No Workflow Run, Ingest Job, server persistence architecture, export lifecycle, route contract, or Postgres schema change appears in the final diff.
- [ ] The repository typecheck and full test suite pass.
