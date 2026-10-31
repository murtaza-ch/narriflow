# 16 - Remaining native deps, Redis rate limits and cache

**What to build:** Remaining native deps, Redis rate limits and cache.

**Blocked by:** 03, 06, 09

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.4 replacements: RateLimiter DO (fail-closed), Pexels cache, PBKDF2 passcodes, Modal-backed font/asset/thumbnail validation, Workers-safe storage/crypto exports.
- **Accept:** the Worker bundle can't reach Argon2, Sharp, FFmpeg, the font filesystem code or Redis. Passcode hashing is measured under workerd. Assets become usable only after validation.

## Evidence

Passcode slice implemented with fixed PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte salt and 32-byte output. Native Workers WebCrypto and node:crypto both rejected 600,000 iterations in a deployed probe. The pure JavaScript @noble/hashes 2.4.0 implementation passed the same independent Python hashlib vector on deployed Workers. [Raw evidence](../evidence/platform-crypto-20261031.json). Fifteen passcode/review tests pass, including refusal before KDF on exhausted/unavailable rate admission.

RateLimiter DO and Cache API replacement are implemented, including local workerd concurrency/expiry gates.

Font and visual finalization now return pending jobs. Native parsing/probing runs in the owned media CLI. The fenced domain publishes an asset only after the assigned binary and probe metadata are both sealed. Font reads use persisted face metrics, and null metrics cannot be selected. Storage control no longer imports filesystem transfer code. [Validation foundation evidence](../evidence/native-validation-20261031.json).

Thumbnail requests now use a targeted fenced domain and the same owned media CLI. The native polling path is removed. Its metadata-first publication and replay gates pass on isolated PostgreSQL. [Thumbnail evidence](../evidence/thumbnail-validation-20261031.json).

RSS preview/import now use a frozen OutboundProbe and private sealed result. The native owner performs pinned DNS/HTTP and bounded parsing; browser commands await pending status without holding SQL. Fresh-schema publication/member-revocation gates, native transport tests and the actual Next upload screen pass. [Outbound RSS evidence](../evidence/outbound-rss-20261031.json).

Generated image publication now stages an immutable private source and parks its parent on native validation. Validated asset adoption, the parent terminal result and generation usage finalization commit together. Lost upload acknowledgments recover the exact source, and cancellation prevents late publication. The dry bundle has no forbidden packages; URL-guard native transport is its remaining service import blocker. [Generated-image evidence](../evidence/generated-image-validation-20261031.json).

Drive token and metadata calls now use fixed-origin Worker fetch, refuse redirects and keep bounded responses. Actual Drive downloads retain the native pinned transport. [Drive boundary evidence](../evidence/drive-worker-boundary-20261031.json).

Remaining: connect signed HTTP/Workflow/Modal runtime and durable provider/maintenance commands, move callback delivery off service-native URL-guard, clear the final import audit, and run deployed/resource gates. This ticket remains claimed.
