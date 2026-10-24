# 07 - Zapier integration and an events-driven n8n template

**What to build:** A Zapier Platform app for Narriflow that triggers on Workspace Events and can submit videos, generate clips, export, and propose posts, ready for the owner to push as a private integration. Plus a second n8n template that posts finished Autopilot clips to Slack.

**Blocked by:** [02](02-workspace-event-feed.md), [04](04-finishing.md), [05](05-publishing-queue.md).

**Status:** done

**Map:** [Automation and integrations map](../map.md), Zapier and n8n verdicts.

## Behavior

- `integrations/zapier/` is a Zapier Platform CLI app in TypeScript. It is a standalone npm project outside the Bun workspaces, like `tools/videos`, and is excluded from the repo's Biome and Turborepo runs the same way.
- Auth: custom API key (Workspace API key as Bearer). The connection test calls `GET /api/v1/workspace`, and the connection label shows the Workspace name.
- Triggers poll `GET /api/v1/events` filtered by type and return items with `id` so Zapier deduplicates:
  - Clips Ready (`operation.finished`, generation `completed` or `partial`)
  - Export Finished
  - Finishing Ready
  - Autopilot Episode Imported
  - Post Published (`social_post.finished` with `posted`)
  - Post Needs Attention
- Each trigger hydrates the subject with one read call so Zaps get useful fields (project title, clip titles, export IDs).
- Actions:
  - Submit Video Link (`POST /projects`)
  - Generate Clips
  - Export Clip
  - Propose Social Post
- Searches:
  - Find Project
  - Get Export Download, which issues fresh Download Grants and says they expire after 15 minutes.
- Idempotency keys derive from the Zap step's stable inputs, never randomly per retry.
- Tests use `zapier-platform-core`'s app tester with HTTP mocks.
- A README covers `zapier register`, `zapier push`, and inviting users (owner steps), plus the public-listing requirements as a later step.
- n8n: `docs/integrations/n8n/autopilot-to-slack.json` polls `/events` every five minutes from a cursor kept in workflow static data. On `finishing.finished` it fetches Download Grants and posts the clip titles and links to a Slack channel. Update `docs/integrations/n8n/README.md`.
- Docs: a page in `apps/web/content/docs` for Zapier (setup through an invite link) and the new n8n template, listed in navigation.

## Acceptance criteria

- [x] `npm test` in `integrations/zapier` passes; `zapier validate` passes if the CLI is available offline, otherwise the schema check the CLI package provides.
- [x] The n8n JSON imports cleanly (valid n8n workflow schema) and contains no secrets.
- [x] Repo-wide `bun run lint` and `bun run typecheck` unaffected.

## Comments

2026-10-24: implemented in a worktree, Opus-reviewed. Review led to a Workspace Events API addition (`order=desc` newest-first reads; 403 when every requested type is hidden) so each Zapier poll is one call with deferred hydration; creates gained an optional Run Key so deliberate re-runs aren't permanent replays; 401/429/403 map to Zapier's error types; the n8n template can't wedge on a deleted export and starts from the newest event. Zapier tests run in a new CI job. Merged; verified: biome, typecheck, `bun run test`, `npm test` (74) and offline validate in `integrations/zapier`. Owner steps: `zapier register`/`push`/invite, then a live run with a real Business key; recorded n8n runs.
