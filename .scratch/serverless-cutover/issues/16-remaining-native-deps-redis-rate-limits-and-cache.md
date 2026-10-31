# 16 - Remaining native deps, Redis rate limits and cache

**What to build:** Remaining native deps, Redis rate limits and cache.

**Blocked by:** 03, 06, 09

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.4 replacements: RateLimiter DO (fail-closed), Pexels cache, PBKDF2 passcodes, Modal-backed font/asset/thumbnail validation, Workers-safe storage/crypto exports.
- **Accept:** the Worker bundle can't reach Argon2, Sharp, FFmpeg, the font filesystem code or Redis. Passcode hashing is measured under workerd. Assets become usable only after validation.

## Evidence

Pending implementation and verification.
