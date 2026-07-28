---
name: codex-delegation
description: Delegate implementation, review, or verification work to OpenAI Codex (gpt-5.6-sol) from Claude Code. Use whenever handing a task to Codex — /codex:rescue, /codex:review, adversarial critique, UI verification, or the raw codex CLI fallback — to build the handoff prompt correctly and manage the job lifecycle.
---

# Codex Delegation

Codex is a peer engineer with zero context from this conversation. The handoff prompt is the entire interface — its quality determines the result.

## Command catalog (official plugin first)

- `/codex:setup` — setup check; `--enable-review-gate` adds a stop hook where Codex challenges Claude's output before finalizing.
- `/codex:review` — read-only code quality review; `--base main` for branch review.
- `/codex:adversarial-review <risk focus>` — skeptical design/tradeoff pressure test; append focus text to steer.
- `/codex:rescue <task>` — implementation, debugging, or multi-file refactoring delegation.
- `/codex:status` / `/codex:result` / `/codex:cancel` — manage `--background` jobs.
- Default `--effort high` on every Codex delegation; leave `--model` unset unless explicitly requested.

Raw CLI fallback when the plugin is unavailable (same high-effort default):

- Review: `codex exec -s read-only -c model_reasoning_effort=high "<self-contained prompt>"`
- Implementation: `codex exec -c model_reasoning_effort=high "<self-contained prompt>"`

## Lifecycle rules

- `--wait` for small bounded tasks; `--background` only when overlap with other work is genuinely useful.
- For background jobs: retain the job id, poll `/codex:status`, and read `/codex:result`. Dispatch is not completion.
- After any implementation delegation: inspect `git status --short` and the diff, check for accidental files or regressions, and independently run the relevant checks.
- Reviews report findings; they do not fix. Delegate fixes as a separate scoped task.
- If verification fails, return the concrete failure with `--resume` (same repo root) when continuity helps, or `--fresh` for an independent pass.
- Never claim completion while a job is running, a result is unread, or a required check fails.

## Handoff contract

Every delegation prompt contains:

```text
Mode: implement | review-only

Goal: the observable outcome and why it matters.

Current state: relevant behavior, evidence, starting files, any known failing test.

Scope: files/areas in scope; explicitly out of scope; user-owned dirty
files that must be preserved.

Constraints: architecture and product invariants (see AGENTS.md), dependency
policy, package manager, security boundaries.

Done when: machine-checkable acceptance criteria.

Verification: exact focused commands (see the Verification section of
AGENTS.md), UI routes/viewports if applicable, and what to report if
environment blocks a check.

Stop conditions: discoveries that require reporting back instead of
broadening scope.

Return: changed files, concise diff summary, checks with results, unresolved risks.
```

## Common handoff mistakes to avoid

- "Review and fix" without picking a mode.
- Assuming Codex saw the conversation or a previous job's context.
- Prescribing the diff instead of stating outcome and boundaries.
- Omitting dirty-worktree ownership (causes collateral edits).
- "Run all tests" instead of the smallest meaningful checks.
- UI verification without a route, setup state, viewport, and expected behavior.
- No stop condition, so the executor improvises when assumptions fail.
