# Narriflow implementation re-verification — 2026-07-10

## Verdict

Narriflow's current implementation is substantially more complete than the
repository `HEAD` suggests, and its static release gates are healthy. The live
working tree passes fresh lint, typecheck, unit tests, dependency audit, build,
and configured-database migration checks. The public marketing, pricing,
authentication, and responsive navigation surfaces are visually coherent.

It is **not yet production ready**. The remaining blockers are mostly
state-machine, release-artifact, data-lifecycle, and provider-reconciliation
problems that unit tests and a successful Next.js build cannot prove. The most
urgent newly confirmed defect is that the worker Docker build has no
`.dockerignore` and copies the whole repository, including local environment
files and host build artifacts, into the image context/runtime layer.

No source code was changed during this pass. This report and the implementation
plans are the only edits.

## Scope and method

This pass reconciled:

- the current dirty working tree (the actual product) against completed and
  TODO plans;
- the linked Narriflow Notion brief, competitor analysis, master feature hub,
  priority matrix, learning-loop notes, and July market pack;
- current first-party provider/framework documentation;
- current first-party competitor pages plus clearly labelled anecdotal user
  feedback;
- fresh static/build gates and current-run public-route browser captures.

The authenticated editor/project workflow was inspected in source and tests but
was not fully browser-exercised in this run because no signed-in acceptance
session was available. It remains a required launch gate.

## Fresh verification results

| Gate | Result | What it proves |
|---|---|---|
| `bun run lint:biome` | PASS, 343 files | Current configured lint baseline is clean |
| `bunx turbo run typecheck --force` | PASS, 10/10, zero cache | Every workspace typechecks from source |
| `bunx turbo run test --force` | PASS, 233/233, zero cache | 41 validator, 81 service, 72 web, and 39 worker tests pass |
| `bun run audit:production` | PASS | No current high/critical production dependency advisory |
| `bunx turbo run build --force` | PASS, 10/10, zero cache | Current Next 16.2.10 production build and package builds succeed |
| Prisma migration status | PASS, 24 migrations | The configured Neon database is currently up to date |
| Public desktop/mobile browser smoke | PARTIAL | Home, pricing, sign-up shell, and mobile navigation render coherently; authenticated acceptance is blocked by mismatched local Clerk instance keys |

These are necessary gates, not a substitute for database concurrency,
provider-contract, container, migration-rollout, and authenticated E2E tests.

## Confirmed launch blockers

| ID | Priority | Confirmed gap | Evidence | Plan |
|---|---|---|---|---|
| REL-01 | P0 | Worker image can include local secrets, `.git`, host `node_modules`, `.next`, and caches; host artifacts can also overwrite Linux-installed dependencies | `apps/worker/Dockerfile:42-48`; no `.dockerignore`; CI does not build the image at `.github/workflows/ci.yml:19-35` | 038 |
| RATE-01 | P1 | Configured Redis rate limiting always fails open: the first command is sent while a lazy client has its offline queue disabled, then the client is reset and the sequence repeats | `packages/services/src/rate-limit.ts:29-36,68-76`; direct local ioredis probe reproduced the rejection | 037 reopened |
| INGEST-01 | P1 | YouTube metadata/download subprocesses have no timeout, process kill, output bound, single-item flag, pre-download byte bound, or maximum-duration enforcement | `apps/worker/src/tasks/ingest.ts:69-103,155-169,202-245` | 023 reopened |
| FLOW-01 | P1 | Workflow admission, ownership, events, and finalization are not leased/atomic; late work and telemetry failure can corrupt lifecycle truth | `packages/services/src/project.service.ts:1125-1169,1869-1949`; `packages/services/src/workflow.service.ts:82-133`; `packages/db/prisma/schema.prisma:255-269` | 027 |
| TEST-01 | P1 | Green unit gates do not exercise real Postgres constraints, shuffled webhooks, worker-image boot, concurrent claims, or ambiguous provider outcomes | `packages/db/package.json:24`; `.github/workflows/ci.yml:19-35` | 041 |
| UPLOAD-01 | P1 | Client-supplied file size and part count are independent; expected size/MIME are not stored and completed object size is not compared with the authorized 5 GB limit | `packages/validators/src/upload.ts:21-29`; `packages/services/src/project.service.ts:1391-1400,1476-1495`; `packages/db/prisma/schema.prisma:293-305` | 039 |
| TOKEN-01 | P1 | Any non-empty social-token passphrase is silently SHA-256-derived into an encryption key, and ciphertext has no key ID/rotation path | `packages/services/src/social-oauth.service.ts:92-126`; `packages/db/prisma/schema.prisma:485-500` | 040 |
| BILL-01 | P1 | Stripe webhook snapshots directly overwrite tier although Stripe delivery can be duplicated/reordered; there is no subscription/event reconciliation record | `packages/services/src/billing.service.ts:171-245`; `packages/db/prisma/schema.prisma:346-359` | 029 |
| DELETE-01 | P1 | Public privacy copy promises removal, but Clerk deletion only soft-deletes the user while workers/rules/tokens/media can remain active | `apps/web/app/(marketing)/privacy/page.tsx:23-24`; `packages/auth/src/index.ts:298-365`; worker claim paths cited in plan 030 | 030 |
| SOCIAL-01 | P1 | Provider-accepted posts can later be marked failed; stale publishing is reaped without authoritative lookup, enabling unsafe duplicate retries | `packages/services/src/social.service.ts:309-383`; `apps/worker/src/tasks/social-publisher.ts:963-997` | 031 |
| DUB-01 | P1 trust | Pricing markets “Voiceover dubbing,” while current output is one translation/TTS blob muxed over an already rendered video with `-shortest`; it can truncate audio/video and retain wrong-language burned captions | `packages/validators/src/pricing.ts:110-115`; `apps/worker/src/tasks/dubbing.ts:114-137,330-355,427-473` | 026 |

## Important but lower-severity production gaps

- The worker's HTTP server binds normally and exposes unauthenticated
  `POST /poll-once` (`apps/worker/src/index.ts:192-225`). Remove it from the
  production surface or authenticate it; a public operational trigger should
  not exist accidentally.
- Several manifests still use mutable `"latest"` declarations, despite the
  documented Chakra split-instance outage, and compatible ranges are not
  automatically reviewed. Frozen CI protects CI, but a normal install can still
  drift the working lockfile. Plan 038 makes dependency/runtime artifact policy
  explicit.
- The plan index and root roadmap contain stale operational statements. The
  configured database is up to date, Redis now has database-backed live-state
  fallback, and Stripe ordering is a real P1 rather than a harmless replay
  detail. Documentation must be updated from verified release truth.
- Durable SSE replay is unbounded for an old cursor
  (`packages/services/src/workflow.service.ts:82-104`). Plan 027 already owns the
  bounded replay/outbox fix.
- The local acceptance environment reports a Clerk session-refresh redirect loop
  because its publishable/secret keys do not belong to the same development
  instance. No key values were inspected. This is not evidence of a source-code
  auth defect, but it prevents trustworthy signed-in browser verification and
  must be corrected before launch acceptance testing.
- Fresh multipart initialization has no stable client idempotency key. The
  server creates project → provider upload → session before returning URLs, but
  the browser stores resume IDs only after a valid response
  (`project.service.ts:1365-1423`; `upload-shell.tsx:544-632`). Response loss can
  create duplicate pending projects/uploads. Plan 039 now owns this path.
- Plan 024's core provider registry is correct, but four integration gaps remain:
  Autopilot accepts arbitrary language strings then silently falls back to Auto;
  caption-only projects expose hardcoded English “Why this clip” analysis;
  long content excerpts can split UTF-16/grapheme boundaries; and critical
  manual/Auto request/prompt orchestration lacks direct tests. Plan 024 is
  reopened.
- The shared meter component forwards names correctly, but upload progress calls
  it without any name (`upload-shell.tsx:219-228`). Plan 022 is reopened for the
  caller and a focused accessibility test.

## Multilingual implementation verdict

The provider foundation is implemented correctly:

- `universal-3-5-pro` followed by `universal-2` is the current AssemblyAI model
  chain.
- The repository's 102 submitted-language codes match the current API enum.
- The direct U3.5 language subset and automatic U2 fallback are represented
  truthfully.
- Manual versus automatic source-language controls no longer accept ignored
  post-transcription edits.

The remaining gaps are product-quality gaps, not a wrong model identifier:

1. Automatic detection returns `language_confidence`, but normalization/schema
   preserve only `language_code` (`packages/services/src/transcript.service.ts:25-45,263-273`;
   `packages/db/prisma/schema.prisma:271-290`). Low-confidence language therefore
   cannot gate review or downstream generation.
2. Vocabulary is deployment-wide environment configuration
   (`apps/worker/src/tasks/transcribe.ts:152-166`), not a user-managed,
   versioned workspace/project contract.
3. Source locale, preferred spellings, pronunciation, do-not-translate terms,
   tone/register, script/caption rules, and target-locale choices are not one
   shared source of truth across transcript, clips, content assets, metadata,
   captions, and dubs.
4. Dubbing is not timed, speaker-aware, caption-correct, segment-retryable, or
   rendered from a clean intermediate.
5. Autopilot's validator is not the shared provider enum and invalid manual
   codes silently become Auto at generation time.
6. Caption-only review metadata and long-transcript excerpting still have
   English/Unicode edge cases even though normal prompt paths preserve source
   language.

Plan 042 establishes language/terminology truth. Plan 026 then consumes its
versioned snapshot to ship publication-grade dubbing for a deliberately small,
eval-backed launch locale matrix. The current `gpt-4o-mini-tts` alias remains a
documented model alias; the older dated snapshot is deprecated. Provider/model
selection still needs a fresh quality, latency, consent, and unit-economics eval
when Plan 026 executes.

## Framework/provider documentation verdict

- **Next.js 16.2.10**: forced production build passes. Inspected route/layout
  params, `headers()` and auth usage are awaited; no stale async-request-API or
  obvious Server/Client Component boundary defect was confirmed. Cache
  Components are not enabled, so do not apply `use cache`/PPR advice as if they
  were current runtime semantics.
- **Clerk 6.39.5**: proxy/layout/server-action authorization patterns are
  coherent in source. Clerk 7/Core 3 is a separate major migration with breaking
  changes, not a launch hotfix. The immediate blocker is local development-key
  parity for browser acceptance, not a speculative major upgrade.
- **OpenAI**: `gpt-5.4-mini` is a current structured-output-capable model for the
  configured text paths. The `gpt-4o-mini-tts` alias is current while an older
  dated snapshot is deprecated; re-evaluate/pin at Plan 026 execution.
- **AssemblyAI**: model chain/enum are current. Add confidence/profile/timed dub
  quality rather than changing a correct identifier.
- **Prisma/Postgres**: schema validates/builds and configured migrations are up
  to date, but real-database concurrency/migration upgrade tests remain absent.
- **Dependency maintenance**: current high/critical audit is clean. Patch/minor
  updates and major Clerk migration should flow through Plan 038's managed
  update policy and full gates, not broad ad-hoc upgrades.

## Current UX flow audit

Current-run evidence was captured at desktop and 390 px mobile widths.

1. **Marketing discovery — Healthy.** The desktop and mobile hierarchy,
   typography, contrast, CTA prominence, and responsive layout are coherent.
   The mobile navigation opens as a focused drawer with the underlying page
   unavailable to the browser accessibility snapshot.
2. **Pricing and capability trust — Needs work.** The page is visually clear
   and responsive, but the Pro “Voiceover dubbing” benefit reads as a finished
   publishing capability while the implementation is an experimental draft
   pipeline. Until Plan 026 passes media gates, label it “AI voiceover draft
   (beta)” or remove it from the sellable entitlement list.
3. **Sign-up shell — Visually healthy; functional auth not verified.** The
   mobile Clerk UI is clean, controls have accessible names, and no horizontal
   overflow was observed. The current local Clerk publishable/secret key
   mismatch causes a session-refresh redirect loop, so successful account/session
   creation was not accepted as verified.
4. **Authenticated creation/project/Studio — Blocked in this run by local auth
   configuration.** Source, unit tests, previous authenticated plan evidence,
   and responsive public shells were reviewed, but a real signed-in create →
   transcribe → review → edit → render → publish session remains mandatory after
   the Clerk development keys are reconciled.
5. **Mobile Studio — Known decision gap.** For the recommended podcast-team
   ICP, ship Plan 035's honest larger-screen guard and instrument mobile entry/
   abandonment. Fund a touch-first editor only after demand evidence.

This is not a full WCAG conformance claim. It is a current-flow design,
responsive, keyboard/accessibility-name, and failure-state audit of the states
that were available.

## Market conclusion

The original strategy remains correct and is now sharper:

> Target podcast and recurring long-form content teams; win on editorial
> throughput—fewer usable candidates, faster source-linked correction and pro
> handoff, consistent brand/language truth, and safe recurring automation.

Current competitors make raw clipping, captions, reframing, B-roll, scheduling,
and generic scoring increasingly commodity. The strongest unmet needs are:

1. usable clip yield and lower review time;
2. fast correction with exact source context;
3. reliable recurring automation with pause/reconcile/recovery semantics;
4. one brand/terminology/locale truth across outputs;
5. publication-grade localization rather than a language-count claim;
6. cross-project review/calendar operations for teams;
7. a performance learning loop only after explicit review signals are reliable.

Community reports about reviewing many generated clips to publish only a few
are anecdotal and hypothesis-generating, not a representative survey. They are
consistent with product gaps visible in current first-party competitor
positioning: OpusClip sells prompt/reprompt and professional XML handoff,
Descript/Opus/Submagic sell vocabulary controls, and Repurpose's recent releases
emphasize connection/publishing safeguards rather than another generation
effect.

## Prioritized implementation sequence

### Wave 0 — stop unsafe release artifacts

1. Reopened Plan 037: connect before Redis limiter commands and add healthy/
   failing/concurrent tests.
2. Reopened Plan 023: bound/single-item `yt-dlp` processes, bytes and duration.
3. Plan 038: secure/reproducible worker image, production endpoint surface,
   dependency policy, and CI image smoke/secret scan.
4. Temporarily qualify the pricing dubbing claim as beta/draft until Plan 026.

### Wave 1 — create production-shaped proof

5. Plan 041: ephemeral Postgres, migration, concurrency, reordered-webhook,
   provider-adapter, and worker-image gates.
6. Plan 039: authoritative multipart metadata/limit/idempotency binding and abandoned
   session lifecycle.
7. Plan 040: versioned high-entropy social-token keyring and rotation.
8. Reopened Plan 022 upload-meter name and Plan 024 multilingual integration
   follow-ups can run in parallel.

### Wave 2 — make existing irreversible flows trustworthy

9. Plan 027: leased/atomic workflows and outbox.
10. Plans 029, 030, and 031: billing reconciliation, deprovisioning, and social
   publication reconciliation. These can proceed in parallel after 027's
   ownership/outbox primitives stabilize.

### Wave 3 — build the product wedge

11. Plan 042: versioned language/terminology profiles and confidence review.
12. Plan 025: editorial intent, transcript-first review, measurable usable yield,
   and source-linked correction.
13. Plan 026: timed/caption-correct dubbing for an approved launch locale set.
14. Plan 043: source-linked professional handoff package; validate a simple
    manifest first, then FCPXML against real Premiere/Resolve fixtures.
15. Plan 028 Phase 1–2: owner-only operations inbox/calendar. Delay agency RBAC
    and client portals until paid demand and workspace ownership are explicit.

## Explicit non-goals for this sequence

- Do not build a Riverside-style recording/hosting suite.
- Do not expand into avatars, digital twins, influencer discovery, or a general
  social-media manager.
- Do not prioritize more caption presets, 4K, or generative B-roll as the wedge.
- Do not ship lip sync/voice cloning before timed basic dubbing and consent/data
  controls are reliable.
- Do not auto-publish solely from a virality score.
- Do not build a native mobile app before mobile editing demand is proven.
- Do not broaden the public API/editor-embed surface before Plan 027.

## Current sources

Product context:

- Narriflow brief: <https://app.notion.com/p/2e0606538ae381ea924fd0c6d0da92e6>
- Competitor analysis: <https://app.notion.com/p/2e0606538ae3810da751e1c49d34943d>
- Current market pack: <https://app.notion.com/p/2fc606538ae381a6a506eac43dc6caf9>

Current competitor/provider sources:

- OpusClip pricing/features: <https://www.opus.pro/pricing>
- OpusClip brand vocabulary: <https://help.opus.pro/docs/article/brand-vocabulary>
- Vizard pricing: <https://vizard.ai/pricing/>
- Quso features: <https://quso.ai/features>
- Repurpose release notes: <https://support.repurpose.io/en/article/release-notes-whats-new-at-repurpose-1y1nxx5/>
- Descript do-not-translate glossary: <https://help.descript.com/hc/en-us/articles/37973459800589-Manage-your-do-not-translate-list>
- Captions dubbing: <https://captions.ai/features/ai-dubbing>
- Submagic pricing/features: <https://www.submagic.co/pricing>
- AssemblyAI Universal-3.5 Pro: <https://www.assemblyai.com/docs/pre-recorded-audio/universal-3-5-pro>
- AssemblyAI submit API: <https://www.assemblyai.com/docs/api-reference/transcripts/submit>
- OpenAI GPT-4o mini TTS model page: <https://developers.openai.com/api/docs/models/gpt-4o-mini-tts>
- OpenAI GPT-5.4 mini model page: <https://developers.openai.com/api/docs/models/gpt-5.4-mini>
- Next.js Cache Components reference: <https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents>
- Clerk Core 3 upgrade guide: <https://clerk.com/docs/guides/development/upgrading/upgrade-guides/core-3>
- ioredis connection/offline-queue behavior: <https://github.com/redis/ioredis#connection-events>
- yt-dlp selection/download limits: <https://github.com/yt-dlp/yt-dlp#video-selection>
- Stripe webhook ordering guidance: <https://docs.stripe.com/webhooks?lang=node>
- Docker build context/best practices: <https://docs.docker.com/build/concepts/context/> and <https://docs.docker.com/build/building/best-practices/>

## False positives rejected in this pass

- The AssemblyAI `universal-3-5-pro` identifier is current, not stale.
- The 102-code submitted-language enum matches the current API reference; the
  supported-language prose mentions Swiss German, but the submit enum exposes
  no additional Swiss-German code.
- The current OpenAI TTS alias is not the deprecated dated snapshot.
- The configured database migration is not pending; repository release docs are
  stale.
- Redis degradation no longer removes live state entirely; Plan 037's database
  polling fallback is present. The rate-limiter connection path is separately
  broken and the plan is reopened.
- Multipart completion part-set validation is implemented; the unresolved issue
  is authoritative byte/MIME/fingerprint binding.
- Atomic social claim prevents two workers claiming the same scheduled row; the
  unresolved defect is provider-outcome ambiguity after the external call.
