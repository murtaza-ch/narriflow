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

Remaining: connect the real Modal/work-package runtime and thumbnail domain, move arbitrary outbound transport, clear the final native audit, and run deployed/resource gates. This ticket remains claimed.
