# 06 — Move generation, rendering, exports, and dubbing through policy

**What to build:** Move processing, Clip generation, rendering, export, preview, download, retry, sharing, and dubbing requests through Authenticated Request Policy. Each action should use its exact processing, viewing, editing, or download capability and preserve the recovery contracts owned by Workflow Run, Clip Render Attempt, Clip Export, and dubbing modules.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** ready-for-agent

- [ ] Generation, regeneration, rendering, export creation and retry, preview, download, sharing, and dubbing declare exact capabilities instead of passing through a generic edit gate.
- [ ] Viewer download access remains available where the capability matrix permits it, including restricted-Workspace owner access defined by current billing policy.
- [ ] Actor, Workspace, Project, Clip, export, and dub identifiers remain explicitly scoped through each domain call.
- [ ] Existing successful responses, redirects, revalidation, pending states, render variants, immutable exports, share behavior, and signed delivery behavior remain unchanged.
- [ ] Quota and plan-limit failures retain current usage or upgrade recovery rather than becoming generic authorization or validation errors.
- [ ] Revision conflicts, render state conflicts, missing artifacts, retryable rendering failures, unavailable storage, and permanent refusals remain typed and distinct.
- [ ] Browser controls preserve the attempted render, export, share, or dubbing intent across expected retry paths and prevent duplicate active submission as they do today.
- [ ] Unexpected FFmpeg, storage, provider, or database details never reach browser responses or routine client logs.
- [ ] Moved adapters remove repeated authentication, Project lookup, capability checks, common error translation, and obsolete shallow tests.
- [ ] Focused policy, HTTP, action, browser, Workflow Run, Clip Render Attempt, export, and dubbing tests prove the complete slice.
