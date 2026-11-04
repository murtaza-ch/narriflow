# 06 Providers

**What to build:** Provider blips do not disconnect accounts or lose work, and every provider call is bounded.

**Blocked by:** None

**Status:** done

Owns: `packages/services/src/social-oauth.service.ts`, `social-token-refresh.ts`, `zoom-token-refresh.ts`, `content-suite.service.ts`, `scribe-errors.ts`, `transcription-*.ts`, `clip-selection-provider.ts`, `social-publication-tiktok-webhook.ts`, `apps/media/src/publication-platforms.ts`, `publication-cli.ts`, `packages/validators/src/social-provider-capabilities.ts`, `.dev.vars.example` files. `clip.service.ts` is shared with ticket 02; only touch its title-suggestion call.

Provider behaviour was not exercised. Where a claim rests on provider docs, check the current docs with web search or context7 first.

## Must fix
1. **Instagram publishing likely fails on every connected account (high).** `social-oauth.service.ts:1079`. Scopes come from `shortToken.scope`, which Meta's code exchange does not return, so `requireScopes(account, ["instagram_content_publish"])` fails. Read scopes through `/me/permissions` and `grantedFacebookScopes`, as the Facebook path does (~1146), and add a test.
2. **One provider blip permanently expires a social account (high).** `social-token-refresh.ts:124-147`. Any failed exchange sets `expired`, including timeouts, 429, 5xx. A metrics sync can disconnect an account (`publication-observations.ts:432,624`). `exchange` must report whether a token could have rotated. Google never rotates, and an HTTP response rejecting the exchange proves nothing rotated: clear the marker and let the caller retry. Keep `expired` only for unknown outcomes on rotating providers. Review `zoom-token-refresh.ts`.
3. **Token can expire mid-publication (medium).** `social-oauth.service.ts:34`, `apps/media/src/publication-cli.ts:79`. Use a publish-path refresh window of about 6 minutes.
4. **LLM calls unbounded (medium).** `content-suite.service.ts:262`, `clip.service.ts:1066`. Add `AbortSignal.timeout`, `max_output_tokens`, handle `status:"incomplete"`, wrap the fetch, map 429 separately. Build one OpenAI Responses helper and use it for the 5 copies of text extraction: `clip-selection-policy.ts:821`, `content-suite.service.ts:164`, `clip.service.ts:711`, `openai-assisted-copy-provider.ts`, `apps/media/src/dubbing-provider.ts`. Do not change clip selection behaviour, and `reasoning.effort` stays medium.
5. **11 OAuth calls have no timeout (medium).** `social-oauth.service.ts:883,959,1012,1032,1045,1107,1126,1145,1161,1236,1322`. Default `AbortSignal.timeout(15_000)` inside `fetchSocialProvider`.
6. **Meta Page lists not paginated (medium).** `social-oauth.service.ts:1046,1162`. `limit=100`, bounded paging.
7. **Instagram long-lived exchange failure is swallowed (medium).** `social-oauth.service.ts:1041` `.catch(() => shortToken)`. Remove the catch. Check Page token `expiresAt`.
8. **Required settings undocumented (medium).** `clip-selection-runtime.ts:23`. `OPENAI_SELECTION_MAX_IN_FLIGHT_REQUESTS`, `OPENAI_SELECTION_MAX_ESTIMATED_TOKENS`, `SOCIAL_PUBLICATION_CHECKPOINT_KEY` are missing from `.dev.vars.example`, wrangler vars docs and `env-check.ts`; a fresh environment gets NaN. Add them, and fail with a named error.
9. **X caption length wrong for CJK, emoji, URLs (medium).** `publication-platforms.ts:3085`, `social-provider-capabilities.ts:29`. Weighted counting at scheduling time and in the composer. Treat definite 400/403/422 from `POST /tweets` as definite non-publication.
10. **LinkedIn commentary unescaped (medium).** `publication-platforms.ts:2392`. Escape little-text reserved characters in one helper, keeping intended hashtags. Contract test.
11. **Unconfirmed Scribe submission can be paid twice (low-medium).** `transcription-control.ts:114`, `workflow-run-lifecycle.ts:2165`. Wait up to the 2h result deadline when the outcome is unconfirmed, or accept the metadata-matched webhook until then.
12. **Scribe 429 ignores Retry-After (low).** `scribe-errors.ts:38`, `transcription-provider.ts:72`. One shared parser replacing the copies in `clip-selection-provider.ts`, `publication-platforms.ts:488`, `performance-providers.ts`.
13. **TikTok failure handling differs by arrival path (low).** `social-publication-tiktok-webhook.ts:245`, `publication-platforms.ts:2106`. One shared reason map.
14. **TikTok chunk count above 64 MiB (plausible).** `publication-platforms.ts:1954`. Check the current guide, follow it, test.
15. **False comment (low).** `scribe-errors.ts:81` claims the next attempt uploads extracted audio. Correct the comment or the retry.

## Reuse
- `social-token-refresh.ts` and `zoom-token-refresh.ts` share one state machine.
- One sealed-value cipher: `social-oauth.service.ts`, `completion-callback.ts`.
- Move `createDeterministicPublicationPlatform` out of production code (`social-publication-platform.ts`).

## Verification
`test:social-publication:db`, targeted unit tests.

## Comments

Implemented by the ticket-06 agent. Sources checked: Meta Facebook Login manual flow (code exchange returns access_token, token_type, expires_in, no scope) and long-lived token guide (Page tokens from a long-lived user token have no expiry date); TikTok Content Posting media transfer guide (total_chunk_count = video_size / chunk_size rounded down, last chunk up to 128 MB, chunks 5-64 MB); LinkedIn little text format (reserved `| { } @ [ ] ( ) < > # \ * _ ~`, hashtag element `#word`); X counting characters (CJK and emoji 2, links 23, 280 weighted).

**Fixed**
1. Instagram scopes now come from `/me/permissions` (new `social_instagram_permissions_missing` when `instagram_content_publish` or `pages_show_list` is not granted). Confirmed against Meta docs. Page-token `expiresAt` is now null for Instagram and Facebook Pages (the 60-day user-token expiry was being applied to non-expiring Page tokens and blocked scheduling past it).
2. `refreshSocialAccountToken` and `refreshZoomConnectionToken`: an exchange throwing `TokenExchangeRejected` (new `token-exchange-rejected.ts`) releases the claim, keeps the account active and rethrows the cause. Social: every Google failure, and any 4xx except 408 from TikTok/LinkedIn/X, is a rejection; 5xx, timeouts and unreadable answers on rotating providers still end `expired`/unconfirmed. Zoom: `ZoomRefusal` (4xx or 429 from the OAuth endpoint). The `SocialAccount_token_refresh_fence` trigger refuses to clear a started marker without a credential write, so a rejection re-seals the same tokens under a fresh IV rather than needing a migration. A migration allowing the clear would be cleaner (ticket 02 only).
3. Publish-path refresh window 60 s -> 6 min (`TOKEN_REFRESH_WINDOW_MS`).
4. New `openai-responses.ts` (`requestOpenAiText`, `openAiResponseText`). Content suite (120 s, 16k tokens) and clip titles (45 s, 4k tokens) use it: timeout, `max_output_tokens`, wrapped fetch, `incomplete` -> bad output, 429 -> new `openai_rate_limited` code (both failure catalogs + error-messages). The 4 other text-extraction copies now use `openAiResponseText` (policy, assisted copy, dubbing via `@narriflow/services/openai-responses`; selection provider keeps its own request and already had timeout/max tokens/incomplete handling). Clip selection behaviour and `reasoning.effort` untouched.
5. `fetchSocialProvider` bounds every request at 15 s unless the caller passes a signal.
6. `readMetaPages`: `limit=100`, follows `paging.next` (origin-checked by `fetchSocialProvider`), at most 10 requests. `eligibleFacebookPages` now caps at 100 after filtering.
7. Instagram long-lived exchange failure is no longer swallowed.
8. The three settings are in `apps/api/.dev.vars.example` and `scripts/env-check.ts` (presence, positive integer, key >= 32 chars); `clip-selection-runtime.ts` throws `<NAME> must be set to a positive integer`. `SOCIAL_PUBLICATION_CHECKPOINT_KEY` already failed with a named error in `social-publication-config.ts`.
9. `xWeightedLength` / `socialCaptionLength` in `social-provider-capabilities.ts`, used at the media adapter, `social.ts` schema, publishing queue, assisted copy, composer count and composer validation. Links are recognised by scheme only (a bare long domain counts by length, which over-counts). The media adapter no longer `truncate`s the text. A 400/403/422 from `POST /tweets` is now a permanent failure with `safeToRepublishAfterSubmission: true`; 5xx stays unknown.
10. `escapeLinkedInCommentary` (exported, contract-tested), keeps word-initial `#tag`.
12. `parseRetryAfterMs` (`retry-after.ts`) replaces the copies in clip-selection-provider, performance-providers and publication-platforms. Scribe 429 now carries Retry-After on `WorkflowFailure.retryAfterMs`; `retryBackoffMs` uses `max(backoff, min(retryAfter, 15 min))` (two-line edit in `workflow-run-lifecycle.ts` and `workflow-attempt-contract.ts`).
13. `tiktok-failure-reasons.ts` is the one reason -> code map for the status poll and the webhook (poll previously lacked `spam_risk_text` and the audit-privacy code).
14. Docs say floor, not ceil, with trailing bytes in the last chunk (up to 128 MB). Fixed `total_chunk_count` and the last chunk's range; test fails before, passes after.
15. Comment corrected: the retry hands Scribe a fresh grant for the same Source Audio; nothing uploads extracted audio.
Reuse: `sealed-value-cipher.ts` is the one v1 AES-GCM cipher for social tokens and completion callbacks (same keys, ciphertexts unchanged). `createDeterministicPublicationPlatform` moved to `social-publication-platform-test-support.ts`.

**Skipped / rejected**
- 11 (unconfirmed Scribe submission can be paid twice): not changed. The wait is bound to the `provider_submission` deadline dispatch obligation created with the intent, and `lockProviderAttempt` stales any webhook past the submission deadline. Extending it means re-timing execution-ledger obligations in `workflow-run-lifecycle.ts` (ticket 03 area). Recommended design: on `ScribeSubmissionUnconfirmed`, move `providerSubmissionDeadlineAt` and its deadline dispatch to submittedAt + 2 h, and let the webhook accept until then.
- Reuse "one state machine for social and zoom refresh": not merged. They differ in locking, columns and uncertainty representation (status `expired` vs `refreshOutcomeUnknown` flag); a shared core needs an adapter larger than both. Only the rejection contract is shared.
- Other `Retry-After` copies (`publication-webhook.ts`, `openai-image-provider.ts`, `pexels.service.ts`) are outside the ticket's list; left.
- TikTok webhook failures stay permanent even for rate limit (the poll path retries after 1 h); only the code map is shared.

**Verification** (local test DB, schema kept per run): `test:social-publication:db` 137 pass / 0 fail (was 132 / 5 fail during development; includes 11 new tests in `social-oauth-refresh.db.test.ts`). Execution-gate files `zoom-refresh`, `social-token-refresh` 11 pass; `targeted-workflow-execution` 15 pass (new Retry-After test). `bun test packages/services packages/validators apps/media/src scripts`: 3004 pass, 4 fail, none mine (workspace removal policy, progress/ws CLI, `targeted-execution.db.test.ts` syntax error). `tsc` for services, validators, media and web shows no errors in touched files; Biome clean on touched files.

**Needs one real connect or post per platform**: Instagram connect (permissions read, Page paging, publish scope), Facebook Page connect (null expiry), TikTok upload above 64 MiB (chunk count) and a real fail_reason, a real X post with CJK/emoji/link text and a refused post (403/422), a LinkedIn post whose caption contains parentheses and hashtags, a real TikTok/X/Google refresh refusal path, a Zoom refresh refusal, a Scribe 429.

**Item 11 follow-up (second pass; supersedes the "not changed" note above).** Confirmed in code: the 10 minute `providerSubmissionDeadlineAt` is the only gate for a webhook before `providerJobId` is stored (`classifyProviderAttempt`, `provider_deadline_expired`), and on `ScribeSubmissionUnconfirmed` the control returned `wait` at that deadline, after which `expireProviderDeadline` failed the attempt with `elevenlabs_submission_unconfirmed` and the retry paid for a second POST. The webhook already matches the attempt through its metadata (run id, attempt id, epoch, source revision, audio id), so only the deadline needed to move. Smallest design: new `WorkflowRunLifecycle.extendUnconfirmedSubmission(key)`, called by `transcription-control.ts` instead of returning the stale deadline. Under the same row locks it moves `providerSubmissionDeadlineAt` and the run's `nextPollAt` to `providerSubmittedAt + 2 h` (the result window) and appends a `provider_submission` deadline dispatch for that time. Only while the attempt is waiting with no `providerJobId`; idempotent; after a recorded acceptance it is `stale: submission_confirmed`. The old 10 minute deadline wake now finds a different deadline and is `stale`, so no retry fires. Fencing is unchanged: a webhook for any other attempt/epoch/source is still stale, and a missing webhook fails at the extended deadline into the normal retry. No schema change. Cost: a POST that truly never arrived now waits up to 2 h before retrying (was 10 min).

Tests: 3 new DB tests in `workflow-run-lifecycle.db.test.ts` (late webhook completes the same attempt after the original deadline passed; retry only at the extended deadline; accepted submission not re-timed) failed first (`extendUnconfirmedSubmission is not a function`). `transcription-control.test.ts` updated (6 pass). `test:workflow:db` 171 pass / 0 fail, `test:execution:db` all suites pass (2, 5, 65, 8, 11), UTC, local test DB. `tsc` clean for packages/services.
