@AGENTS.md

# Claude Orchestration

## Model pattern

- Normal work: Sonnet 5 executes. Call `fable-advisor` once when ambiguity, risk, or worker disagreement warrants better judgment.
- Large or high-stakes work (billing/quota gate, auth, workflow claiming, render pipeline, migrations, architecture): Fable 5 orchestrates and delegates bounded packets to Sonnet or Codex workers; `opus-deep-reviewer` is a distinct review lens for risk areas, not a mandatory stage.
- Effort: `high` is the ceiling for standing use. Treat `xhigh`/`max` as explicit user choices, never defaults.
- Model choices are defaults, not ceilings: one higher-tier advisory or review call without asking is fine when correctness risk, ambiguity, or repeated failure justifies it. Ask before repeated escalations, premium-model parallelism (e.g. blind Opus + Codex passes), or `xhigh`/`max` runs.

## Codex — peer engineer

- Codex `gpt-5.6-sol` (effort `high`) is a peer executor and reviewer: well-spec'd implementation, UI/browser verification, and independent review — not only a downstream critic.
- State the mode explicitly in every delegation: review-only (ranked findings, no edits) or implement (scoped edits plus verification).
- Codex has no conversation context. Every handoff states Goal, Current state, Scope (including user-owned dirty files), Constraints, Done-when, and Verification commands.
- Use `--wait` for small bounded tasks, `--background` for genuinely long ones; always retrieve the result, inspect `git status` and the diff, and verify before claiming completion. Never treat dispatch as done.
- Command catalog, full handoff template, and raw CLI fallback: `.claude/skills/codex-delegation/SKILL.md`.

## Housekeeping

- Put reusable procedures in skills or `docs/agent/`, not in this file.
- Human setup and install steps live in `docs/agent/setup.md`.
