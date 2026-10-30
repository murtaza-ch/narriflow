# Follow-ups after API extraction + render hardening (owner, 2026-10-30)

Owner: "fix these issues according to best UI/UX per industry standards; it should
not be overwhelming for users."

UX rules for every track:
- Calm and quiet: inline, contextual hints at the point of use; a single short
  sentence + one clear action; tooltips/popovers for detail. No modal dialogs,
  no toasts stacking, no alarming red for non-blocking information (use the
  neutral/info roles; red only for real failures needing action).
- Follow the existing design language: no borders, soft fills, `accent` for
  interactive state, existing components (see `packages/ui`, memory "Narriflow
  UI taste"). Reuse existing notice/badge/tooltip components; don't invent new
  visual styles. Copy: plain, specific, no jargon, no blame.
- Every message offers the next step when one exists (no dead ends).
- Verify visually: run the relevant web tests; for UI, add a browser check note.

Engineering rules: AGENTS.md conventions; follow
`.scratch/api-extraction/implementer-brief.md` (no commits, no env edits, DB
gates only via `.scratch/api-extraction/db-gate.sh`, never kill processes you
didn't start); render changes must pass the parity gate
`bun apps/worker/scripts/render-golden.ts verify --baseline /tmp/narriflow-golden/baseline --suite all --out <dir>`
with normal cases identical (intentional changes recorded as expected-change
files, as tickets 03/09b did). Additive migrations only, noting whether safe
while current code runs (the Railway worker applies migrations on deploy).
