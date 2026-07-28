# Agent Tooling Setup (human checklist)

Local setup for the Claude Code + Codex workflow. Not agent instructions.

## Claude Code

- Target version `2.1.197+` for the full Fable 5 + Sonnet 5 workflow (Fable 5 needs `2.1.170+`, Opus 5 `2.1.154+`, Sonnet 5 `2.1.197+`).
- Project subagents live in `.claude/agents/`; project skills in `.claude/skills/`.

## Codex plugin

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

- Optional: `/codex:setup --enable-review-gate` adds a stop hook so Codex challenges Claude's output before finalizing.
- Requires the `codex` CLI installed and authenticated locally.

## Hygiene

- Do not commit personal plugin state, secrets, local paths, or machine-specific settings.
