# 09 - Relocate TS media runtime to `apps/media`, pin images

**What to build:** Relocate TS media runtime and pin images.

**Blocked by:** 01

**Status:** ready-for-agent

**Spec:** [Serverless cutover](../spec.md)

- **Build:** §4.5: move render/process/layout/preview/media modules, tests, fixtures, golden scripts, models and runtime lock to `apps/media`. Injected ports. Lean and render images. Python wrapper with signal forwarding and reaping.
- **Files:** `apps/worker/src/**` media modules → `apps/media/src/**`; `apps/worker/scripts/**`; `apps/media/{package.json,pyproject.toml,modal_app.py}`; image build definitions.
- **Accept:** no render behavior rewrite. Moved tests pass. Fixtures stay immutable. No moved module imports polling code or a DB default. Startup validates binaries, fonts and models. Cancellation reaps descendants.

## Evidence

Pending implementation and verification.
