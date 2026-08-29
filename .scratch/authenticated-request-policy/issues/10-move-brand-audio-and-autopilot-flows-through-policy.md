# 10 — Move Brand, audio, and Autopilot flows through policy

**What to build:** Move Brand Template, logo, audio asset, Workspace media, and Autopilot operations through Authenticated Request Policy. Brand, content, and automation actions should use the exact current capability, strict media and intent validation, actor-safe rate limits, and stable domain errors without changing asset ownership or Autopilot behavior.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** done

- [x] Brand Template, logo, audio asset, Workspace media, and Autopilot operations declare the exact capability from the current Workspace matrix.
- [x] Actor, Workspace, template, asset, and rule identifiers are explicit and nested ownership remains inside the owning domain module.
- [x] Media type, size, identifier, and automation intent validation occurs before storage, provider, or domain work.
- [x] Rate limits use actor or Workspace identity according to abuse scope and provide bounded retry timing.
- [x] Existing successful template, default, duplicate, logo, audio upload, playback, favorite, delete, rule CRUD, and run-now behavior remains unchanged.
- [x] Missing assets or rules, capability denial, invalid media, unsafe input, conflicts, rate limits, and temporary storage or provider failures remain distinct typed outcomes.
- [x] Browser forms preserve selected files and entered rule or template values where safe and realistic after expected failures.
- [x] Signed URLs, storage keys, provider data, and raw exception messages never leak through common failure handling.
- [x] Moved adapters remove direct actor resolution, repeated capability and validation responses, message-based errors, and redundant shallow tests.
- [x] Focused policy, HTTP, action, browser, Brand Template, audio asset, Workspace media, and Autopilot tests prove the complete slice.
