# 08 — Move social publication and connection flows through policy

**What to build:** Move social account reads and authenticated starts, Social Post scheduling and cancellation, publication recovery, confirmation, republishing, and metrics through Authenticated Request Policy. Publishing and social-account capabilities must remain distinct, while Social Publication Attempt continues to own delivery, uncertainty, reconciliation, and manual decisions.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** done

- [x] Social account management and publication operations declare `social.manage` or `publishing.manage` according to product intent.
- [x] Authenticated connection starts and disconnects use Actor Scope. Provider callbacks that establish identity retain their separate OAuth trust model.
- [x] Social Post operations reuse one active Project admission and keep nested post and account ownership inside their domain modules.
- [x] Existing scheduling, cancellation, frozen publication state, manual recovery, confirmation, republish, metrics, and successful OAuth behavior remain unchanged.
- [x] Invalid schedules, missing accounts or posts, capability denial, publication conflicts, uncertain outcomes, provider attention, rate limits, and temporary failures remain distinct typed outcomes.
- [x] Browser panels preserve caption, schedule, settings, and manual-decision input through expected failures and never present an uncertain publication as failed or successful without evidence.
- [x] Provider tokens, callbacks, receipts, raw errors, and checkpoint details never appear in common request failures or routine browser logs.
- [x] Calendar Server Actions return expected failures as serializable values and do not catch framework redirect or revalidation behavior as ordinary errors.
- [x] Moved adapters remove direct actor resolution, duplicate capability and Project checks, message-based mappings, and redundant transport policy tests.
- [x] Focused policy, HTTP, action, browser, calendar, Social Post, and Social Publication Attempt tests prove the complete slice.
