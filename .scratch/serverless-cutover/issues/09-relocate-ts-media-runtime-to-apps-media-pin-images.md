# 09 - Relocate TS media runtime to `apps/media`, pin images

**What to build:** Relocate TS media runtime and pin images.

**Blocked by:** 01

**Status:** claimed

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.5: move render/process/layout/preview/media modules, tests, fixtures, golden scripts, models and runtime lock to `apps/media`. Injected ports. Lean and render images. Python wrapper with signal forwarding and reaping.
- **Files:** `apps/worker/src/**` media modules → `apps/media/src/**`; `apps/worker/scripts/**`; `apps/media/{package.json,pyproject.toml,modal_app.py}`; image build definitions.
- **Accept:** no render behavior rewrite. Moved tests pass. Fixtures stay immutable. No moved module imports polling code or a DB default. Startup validates binaries, fonts and models. Cancellation reaps descendants.

## Evidence

Native compiler, caption, process and layout owners, immutable fixtures, runtime lock and golden scripts moved once into `apps/media`. The renderer requires domain/control/storage ports; native preview, layout, dub mux, audio extraction, normalized probe and export zip/hash functions are separated from the old control wrappers. Exact-id group execution never chooses another job or settles its parent. A pre-process unexpected failure remains uncharged, verified with a red/green seam test.

Local verification on the implementation branch:
- 238 renderer/process/layout/B-roll tests; 109 preview/layout/dub/export/language/group tests; 58 Scribe-control regressions passed.
- Full moved-media suite initially found a stale dynamic Python script path and a 5-second native fixture setup timeout. Paths now point to the moved detector owner; fixture setup uses its existing 120-second native staging budget. The 94 affected tests pass. Full suite recheck: **622 passed, 0 failed across 38 files**, 3524 assertions, 126.27 seconds.
- Media and remaining worker TypeScript checks pass.
- Six real native Bun entry bundles contain 406 input modules and no Prisma, Redis, worker source, services barrel or SQL lifecycle runtime imports.
- Nine Python tests pass under pinned Python 3.13.5, covering mirrored signing vectors, bounded process IO, detached descendants, abrupt wrapper death, deadlines and database-credential stripping.
- Normalized probe CLI smoke reports an exact one-second mono 16kHz audio fixture.
- Both Modal image definitions and CPU/memory tuple limits parse under installed SDK 1.2.6. Render/lean Dockerfiles share one pinned build recipe; native profile checks run at image build and startup.

Still open: explicit full-render FFmpeg thread caps with Linux parity proof; authenticated Modal image builds/startup fingerprints and Linux process/parity evidence; production bridge/control wiring from ticket 06; remaining renderer/control-adapter tests must move with their service/control owners before deleting the old wrappers in ticket 23. No media deployment occurred. Ticket remains claimed and the cutover stays blocked on the integrated gates.
