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

## Worker env flags

- `WORKER_SPLIT=0` disables the "split" (2-up) framing mode's per-output render path; clips using it fall back to whole-clip single-speaker framing (auto-reframe or a static center crop).
- `WORKER_SCREEN_LAYOUT=0` disables the "screen" (screen-share + facecam) framing mode's per-output render path the same way, falling back to whole-clip single-speaker framing.
- Both default to enabled (unset, or any value other than `"0"`).

## Worker email notifications

- Set `WORKER_APP_BASE_URL` in `apps/worker/.env` to the public web-app origin used in project links (for example, `https://app.narriflow.com`). Production workers skip notification sends when this value is missing, invalid, or points to localhost.
- Set `RESEND_API_KEY` in `apps/worker/.env` to enable delivery through Resend. When unset, notifications are recorded as skipped.
- Set `NARRIFLOW_EMAIL_FROM` in `apps/worker/.env` to the verified sender identity (for example, `Narriflow <notifications@narriflow.com>`).
