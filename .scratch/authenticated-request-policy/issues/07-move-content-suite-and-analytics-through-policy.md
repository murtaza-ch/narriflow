# 07 — Move Content Suite and analytics through policy

**What to build:** Move Content Suite generation and Project analytics through Authenticated Request Policy. Read and generation requests should use different declared capabilities, reject malformed intent before domain work, and give users accurate recovery for missing Projects, generation refusal, rate limits, and temporary analysis or provider failures.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** ready-for-agent

- [ ] Content Suite reads and analytics use the exact read capability, while generation uses the exact processing or edit capability required by current product policy.
- [ ] Actor, Workspace, and active Project resolve once and are passed explicitly to the owning domain modules.
- [ ] Strict validation rejects malformed and unknown generation fields before provider or database work.
- [ ] Existing successful Content Suite and analytics payloads, generation behavior, and UI refresh behavior remain unchanged.
- [ ] Missing content, invalid generation intent, conflicts, rate limits, quota refusal, retryable provider failure, and unexpected failure map to distinct stable outcomes.
- [ ] Browser panels preserve generation input during expected correction or retry and do not turn unavailable analytics into a false empty state.
- [ ] Raw LLM, analysis, provider, and database errors never reach users.
- [ ] Moved adapters remove direct actor resolution, duplicate Project checks, handwritten validation errors, and raw exception translation.
- [ ] Focused policy, HTTP, browser, Content Suite, and analytics tests prove the complete slice.
