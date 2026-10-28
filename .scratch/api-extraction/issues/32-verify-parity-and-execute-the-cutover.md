# 32. Verify parity and execute the cutover

**What to build:** An evidence-backed parity and cross-origin verification report covers every baseline row, followed by the coordinated matching-revision cutover.

**Blocked by:** [31 - Clean dependencies and prepare coordinated deployment](31-clean-dependencies-and-prepare-coordinated-deployment.md)

**Status:** ready-for-agent

**Suggested implementer:** Claude. The other pairing side reviews and returns findings to this owner.

Read [spec.md](../spec.md). It is the complete contract; the original brief/plan/reviews are not prerequisites. Claim this ticket before editing.

## Exact ownership

Paths are repo-relative. Every existing file below is exclusively assigned for this phase, including files that only need verification. A new `/**` directory includes its local tests/helpers, not adjacent directories. Read other files as evidence; do not edit them.

Existing files:


New files/directories or reserved skeletons handed off by a blocker:

- `apps/api/test/cutover/**`
- `apps/web/test/api-extraction/**`
- `.scratch/api-extraction/parity-report.md`
- `.scratch/api-extraction/cutover-evidence.md`

This ticket owns cross-domain verification tests/reports only. Existing functional source belongs to its owner. Failures reopen the owning ticket; this ticket does not patch arbitrary source. Deployed settings/provider actions require task authorization at execution time; prepare all concrete changes before any required owner approval.

- `apps/web/test/api-extraction/README.md`

## Endpoints, actions, pages and refresh sites

Rows retain their section/ordinal or exact source-line identifier from the independent inventory. Abbreviated table filenames are accompanied by the literal ownership manifest and exact source occurrences below. All action/page/fetch/refresh rows in owned files are in scope, including no-refresh callers and media navigation. Baseline observations do not override the spec's selected origins, route style, guest Bearer or new endpoints.

No direct UI/domain rows. This ticket supplies the shared contracts or final gates described above.

## Acceptance criteria

- [ ] All baseline rows have exactly one final disposition and owner; all required test/build/DB commands pass with recorded output/skip distinctions.
- [ ] Browser at web origin exercises real separate-origin sign-in/selection/invite/billing/upload/generation/Studio/export/brand/schedule/review/MCP flows.
- [ ] Adversarial roles/membership/scope/origin/token/body/limiter/idempotency/webhook/SSE cases in spec pass with controlled fixtures.
- [ ] Stop automatic deployments and coordinate API/web/worker/provider revisions; verify registered four providers and reconnect clients; record hostname/region/checks without secrets.
- [ ] Record known-compatible coordinated recovery; do not mark cutover done for preparation alone or deploy mixed versions.
- [ ] No unowned files changed; paired review findings and verification evidence recorded under Comments.

## Verification

Run these from the repository root after dependencies are installed. A command naming a new package script is implemented by the owning setup ticket, not silently skipped. PostgreSQL gates need a disposable schema; a skipped DB suite does not satisfy its gate. During the undeployed integration sequence, record any unrelated transitional compile failure with its owning blocker; this ticket's behavior tests must pass and the final integrated gates cannot be waived.

```sh
bun run lint
bun run typecheck
bun run test
bun run env:check
bun run --cwd apps/api test:inventory
bun test apps/api/test/cutover
bun run test:workflow:db
bun run test:upload-session:db
bun run test:processing-usage:db
bun run test:workspace-billing:db
bun run test:social-publication:db
bun run test:clip-editor-persistence:db
bun run test:authenticated-request-policy:db
bun run test:brand-profiles:db
bun run test:vizard-expansion:db
bun run test:integration-api:db
bun run test:library-search:db
bun run --cwd apps/api build
bun run --cwd apps/web build
```

Browser scenarios and adversarial cases are enumerated in spec.md and the criteria above. Record exact final commit/image revisions, actual origins and provider registration outcomes. Use injected providers for failure tests and controlled fixtures for real flows. Do not finish merely because health is green.

## Comments

Append claim, requested seam changes, paired review and evidence here.
