# 06 — Make the Studio Editing Session authoritative for playback

**What to build:** Preserve a user's place and prevent deleted footage from appearing by making the session the sole authority for edited time and media commands across document changes and proxy/source swaps.

**Blocked by:** 05 — Own proxy and analysis eligibility in the Studio Editing Session.

**Status:** ready-for-agent

- [ ] React forwards play, pause, seek, rate, and source-fallback intent without mutating the media element or playback clock.
- [ ] A browser media adapter translates HTML media events and commands; deterministic tests use an in-memory adapter.
- [ ] The session exposes edited time while privately mapping source, proxy, and media-local time.
- [ ] Trims, cuts, undo, and redo preserve the same source frame when it remains kept.
- [ ] Removing the current frame moves playback to the next kept frame, then the last kept frame when no later frame exists.
- [ ] Continuous playback skips deleted ranges once and parks on the last kept frame at the end.
- [ ] Proxy/source swaps preserve source position, play or pause state, and playback rate.
- [ ] Readers may inspect and play without Studio Write Ownership.
- [ ] Late media events from a prior source or session generation are ignored.
- [ ] Direct React video/clock mutation and competing seek ownership are removed.
- [ ] Interface and media-adapter tests cover playback anchoring, cut skipping, end parking, source swaps, rate preservation, and stale events.
- [ ] Exactly one module owns playback coordination after cutover.
- [ ] Repository typecheck and tests pass.
