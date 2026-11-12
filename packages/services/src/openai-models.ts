/**
 * The OpenAI text model every generation job uses unless an environment
 * override names another: clip selection, titles, social copy, the content
 * suite and dubbing translation. Owner decision 2026-11-13: gpt-6-luna
 * ($0.10 / $0.50 per 1M tokens) replaces gpt-5.4-mini ($0.75 / $4.50).
 *
 * gpt-6-luna defaults to medium reasoning, gpt-5.4-mini defaulted to none
 * (measured 2026-11-13), so jobs that relied on that default send
 * `OPENAI_TEXT_REASONING` explicitly to keep their output budgets.
 * Other models worth testing per job: docs/ai-model-options.md.
 */
export const OPENAI_TEXT_MODEL = "gpt-6-luna";
export const OPENAI_TEXT_REASONING = { effort: "none" } as const;
