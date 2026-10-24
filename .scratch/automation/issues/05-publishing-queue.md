# 05 - Publishing Queue

**What to build:** Each Social Account can have weekly posting slots. Finishing, REST, MCP, and people can propose posts. A person accepts a proposal (one, or all), and it freezes into the account's next free slot. Proposals never publish on their own.

**Blocked by:** [04 - Finishing](04-finishing.md).

**Status:** done

**Map:** [Automation and integrations map](../map.md), "Publishing Queue" under New concepts.

## Behavior

- Posting schedule per Social Account: weekly slots (weekday and `HH:MM`) in the Workspace time zone (`Workspace.timezone`), validated in `packages/validators`. Store it on the account (JSON) unless a separate table is clearly simpler. Editable by members with `publishing.manage`.
- A proposal is a Social Post in the existing unused `draft` status: Workspace, Project, clip, a finished export variant, the destination account, a draft caption (from an assisted copy variant when one exists), who or what proposed it (person, integration, finishing), and no `scheduledFor`. It takes no slot. Check what the `draft` status and `social-publication-recovery.ts` already assume about it, and keep recovery from touching proposals.
- Accept (browser only, `publishing.manage`):
  - Run the existing prepare-and-schedule path with `scheduledFor` set to the next free slot. A slot is free when no other active Social Post for that account is scheduled at that exact time.
  - Lock the Social Account row while choosing and writing the slot, so concurrent accepts can't take the same slot.
  - The Brand Profile approval gate applies unchanged.
  - TikTok proposals need the creator's per-post choices at acceptance (`social-publication-scheduling.ts` TikTok checks), so the accept form collects them. "Accept all" skips TikTok proposals and says so.
- Reject cancels the proposal. Editing the caption before accepting is allowed.
- Bulk scheduling: when the account has a posting schedule, offer "Use posting schedule" so a batch fills the next free slots instead of a window. Window mode stays, and it also skips occupied exact slots.
- Proposals from outside:
  - REST `POST /api/v1/social-posts/proposals` with `{ clipId, exportId, socialAccountId, caption? }` and an Idempotency-Key.
  - A `GET /api/v1/social-accounts` route if REST lacks one.
  - MCP `narriflow_propose_social_post`.
  - Add a `propose_social_post` command with `publishing.manage` and `publishing:write`. Proposing is not approval, so it skips the MCP confirm flow; acceptance stays in Narriflow.
- Finishing: extend `finishingSettingsSchema.delivery` with `"propose_to_queue"` plus `queueAccountIds` (validated against the Workspace's active accounts at save and again at run). After copy is ready, finishing proposes each picked clip to each account, using that platform's copy variant.
- Events: append `social_post.proposed` (`{ socialPostId, projectId, clipId, socialAccountId, platform }`) when a proposal is created.
- UI (calendar area, `apps/web/app/(app)/calendar`):
  - A posting-schedule editor per account.
  - A proposals inbox with accept, edit caption, reject, and accept all.
  - Accepted posts appear on the calendar in their slots.
  - Follow the app's design language.
- Docs for the queue, the REST route, and the MCP tool.

## Acceptance criteria

- [x] Proposals never publish and are invisible to the scheduler and recovery (DB test).
- [x] Two concurrent accepts for one account get two different slots (DB test).
- [x] Next-free-slot respects the Workspace time zone across a DST change (unit test).
- [x] Approval gate still blocks acceptance for an `approval_required` brand without an approved round.
- [x] REST, MCP, and finishing proposals work; finishing with `propose_to_queue` creates one proposal per clip and account.
- [x] UI for schedule, inbox, and acceptance (browser check).
- [x] `bun run lint`, `bun run typecheck`, `bun run test`, `test:social-publication:db`, `test:integration-api:db`, `test:workflow:db` pass on the local Postgres.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed (no path publishes a proposal without a person's browser acceptance; fixes: per-account finishing outcomes, accept converts the draft in place so proposal ids stay valid, non-UUID accept key, queue delivery requires `publishing.manage` and `publishing:write`, caption edits during accept conflict, skipped-local-time resolution correct for 30- and 60-minute shifts, browser "Propose to queue", accept-all in pages of 25). ADR 0015. Merged; verified in the main checkout: biome, typecheck, `bun run test`, all ten DB gates (social-publication 81). Accept, reject, and TikTok options not clicked end to end in a real browser.
