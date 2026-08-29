# 09 — Move Workspace administration and billing through policy

**What to build:** Move Workspace settings, membership, invitations, API keys, billing, app-shell admissions, and authenticated integration pages through Authenticated Request Policy. Exact management capabilities and Workspace status must drive access, with owner-specific billing recovery and serializable expected Server Action failures.

**Blocked by:** 03 — Recover Workspace and Project admission.

**Status:** ready-for-agent

- [ ] Workspace, membership, invitation, API-key, billing, and integration operations declare their exact management capability.
- [ ] App-shell and settings admissions use one Actor Scope and current Workspace membership without trusting a stale cookie.
- [ ] Pending-payment and restricted Workspaces preserve the exact owner capabilities defined by current Workspace Billing policy.
- [ ] Owners receive actionable billing recovery. Non-owners receive role-appropriate guidance without provider or subscription internals.
- [ ] Existing billing Checkout, return observation, portal, reconciliation, polling, seat behavior, successful settings changes, invitations, membership changes, and API-key behavior remain unchanged.
- [ ] Expected Server Action failures return stable serializable codes and safe messages while preserving submitted values. Unexpected exceptions reach the error boundary.
- [ ] Framework redirects, not-found handling, and revalidation are not converted into generic action errors.
- [ ] Known Workspace Billing failures retain their typed domain mapping and `Retry-After` behavior through the common adapter.
- [ ] Secrets, API keys, Checkout and portal URLs, provider bodies, and raw exception text never appear in common diagnostics or failure payloads.
- [ ] Moved adapters remove direct actor resolution, raw message returns, repeated capability checks, and duplicated common error tests.
- [ ] Focused policy, HTTP, action, page, browser, Workspace, membership, API-key, and Workspace Billing tests prove the complete slice.
