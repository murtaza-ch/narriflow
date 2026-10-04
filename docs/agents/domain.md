# Domain docs

Narriflow uses one shared domain glossary across the monorepo:

- `GLOSSARY.md` at the repository root defines domain vocabulary.
- `docs/adr/README.md` indexes architectural decisions. Read the ADRs relevant to the work before proposing or changing a design.

Use the glossary's terms in proposals, ticket titles, tests, interfaces, and user-facing explanations. Respect its Avoid entries rather than introducing synonyms for an existing concept.

When a discussion resolves a new term or sharpens an existing one, `domain-modeling` updates the glossary inline. Put architectural decisions and their reasons in ADRs, and implementation plans in specs and tickets.

When a proposal conflicts with an ADR, name the conflict and explain the evidence for reopening the decision. Do not silently override it or repeatedly propose a previously rejected design without new evidence.

The current layout is single-context. A separate glossary per package is unnecessary while the packages share this vocabulary. If documentation is absent in another checkout, continue with the available code and create domain docs only when there is a resolved term or decision to record.
