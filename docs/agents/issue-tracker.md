# Issue tracker: local Markdown

Narriflow tracks planned work in `.scratch/`. Use local files when a skill says to publish a spec or ticket, fetch an issue, claim work, or resolve a ticket.

## Files

- One effort per directory: `.scratch/<effort>/`.
- Spec: `.scratch/<effort>/spec.md`. Additional feature notes can sit alongside it and be linked from the spec.
- Implementation tickets: `.scratch/<effort>/issues/<NN>-<slug>.md`, numbered from `01`, one file per ticket.
- Decision map for `wayfinder`: `.scratch/<effort>/map.md`, with Notes, Decisions-so-far, and Fog sections.
- Comments append under `## Comments`. Decision-ticket answers append under `## Answer` and link back from the map.

Read the referenced file and its linked spec before working. If given only a number, resolve it within the named effort. Numbers are not unique across efforts.

## Ticket fields

Keep the existing Markdown field style near the top of each ticket:

```markdown
**What to build:** Observable behavior this ticket delivers.

**Blocked by:** [01 - Establish the contract](01-establish-the-contract.md), or None.

**Status:** ready-for-agent
```

Use `ready-for-agent` for an unclaimed implementation ticket, `claimed` during work, and `done` after acceptance criteria and required verification pass. Existing tickets also use `completed`; both `done` and `completed` mean closed. Decision tickets may use `resolved` after recording their answer. Update acceptance checkboxes and keep evidence with the ticket.

## Dependency and wayfinding operations

- Blocking edges live in `**Blocked by:**`. They can be relative ticket links or numbered titles within the same effort. A ticket is unblocked only when every blocker is closed.
- The frontier contains unclaimed, unfinished tickets whose blockers are closed. Choose by ticket number when several are available; independent tickets may run concurrently.
- Claim by setting `**Status:** claimed` before starting. Each concurrent implementer owns a different ticket and worktree.
- Resolve an implementation ticket by satisfying its acceptance criteria, recording verification, and setting `**Status:** done`.
- Decision tickets also carry `**Type:** research`, `prototype`, `grilling`, or `task`. Record the answer, set `**Status:** resolved`, and append a short answer and link to Decisions-so-far in the map.

## Implementation close-out

`implement-spec` assembles completed tickets on one integration branch. This tracker closes work through ticket status, so a pull request is created when the user requests one. Mark the spec complete after its tickets and integration verification pass. Keep the repository's pre-production compatibility policy and verification requirements above generic skill guidance.

`triage` is not installed. There is no external triage queue or separate triage-label configuration. New tickets produced by `to-tickets` already use `ready-for-agent`.
