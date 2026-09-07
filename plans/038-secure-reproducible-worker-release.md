# Plan 038: Make the worker release artifact secure and reproducible

> **P0 release blocker**: Do not build, push, or deploy the current worker image
> from a developer checkout until the deny-by-default build context is in place.
> If any current image or remote build cache was produced from a checkout that
> contained real `.env` files, inventory that artifact and rotate the affected
> credentials before treating it as safe.
>
> **Drift check**:
> `git diff --stat 05d273d..HEAD -- apps/worker/Dockerfile apps/worker/src/index.ts package.json apps/web/package.json apps/worker/package.json packages .github/workflows README.md ROADMAP.md bun.lock .dockerignore`

## Status

- **Priority**: P0 release blocker
- **Effort**: M
- **Risk**: MED
- **Confidence**: HIGH
- **Depends on**: none
- **Category**: security, supply chain, operations, CI
- **Planned at**: commit `05d273d`, 2026-07-10, live working tree

## Why this matters

`apps/worker/Dockerfile:42-48` copies `packages/`, installs dependencies, and
then executes `COPY . .` in a single runtime stage. The repository has no
`.dockerignore`. A normal build context therefore includes local environment
files, `.git`, host `node_modules`, `.next`, caches, test artifacts, and every
unrelated workspace. The final copy can also overwrite Linux-installed
dependencies with macOS host artifacts. CI never builds or scans this image.

The worker also exposes unauthenticated `POST /poll-once`
(`apps/worker/src/index.ts:192-225`) on the same listener as health. Even though
the in-process polling guard prevents simultaneous execution, an operational
trigger must not be unintentionally internet-accessible.

The root/app manifests still contain mutable `"latest"` versions and broadly
independent framework/runtime ranges. CI's `bun ci` freezes the checked-in
lockfile, but a routine developer install can still re-resolve these declarations.
That has already caused a split Chakra runtime and app-wide 500s.

Official guidance:

- <https://docs.docker.com/build/concepts/context/>
- <https://docs.docker.com/build/building/best-practices/>

## Target invariants

1. No secret, VCS metadata, host dependency tree, build output, cache, or local
   test artifact can enter the Docker build context.
2. The final image contains only the worker's runtime closure, generated Prisma
   client/schema/migrations required at runtime, and explicitly licensed media
   assets.
3. Dependency installation is frozen and platform-native in the build stage;
   host files cannot overwrite it.
4. Every remote asset is version-pinned and integrity-checked; an unavailable
   required asset fails the build instead of silently changing output.
5. CI builds and starts the exact release image, checks health/readiness, scans
   its file list/history for forbidden paths and secret patterns, and records an
   immutable image digest/SBOM.
6. Production exposes health/readiness only; manual polling is removed or
   strongly authenticated on a private control plane.

## Scope

Expected files:

- `.dockerignore`
- `apps/worker/Dockerfile`
- `apps/worker/src/index.ts` and focused tests/helpers
- root/workspace package manifests and `bun.lock`
- `.github/workflows/ci.yml` plus a small release-image verification script
- `README.md`, `ROADMAP.md`, and `.env.example` files for verified deployment
  truth

Do not rotate or print credentials in source. Do not push an image from this
plan without separate deployment authorization.

## Phase 1: Deny the build context by default

Add a root `.dockerignore` that excludes at minimum:

- `.git`, `.github` unless one specifically required workflow file is copied;
- every `.env*` except explicit `.env.example` documentation if needed;
- `node_modules`, `.next`, `dist`, `coverage`, Turbo/Bun caches, logs, temporary
  media, screenshots, editor files, and local plans/evidence;
- unrelated apps/packages not in the worker's transitive runtime closure.

Prefer an allowlist strategy where practical. Add an automated context test
that creates representative forbidden sentinel files and proves none appear in
the final image or build inputs. Never inspect or echo real secret values.

## Phase 2: Multi-stage, frozen, least-content image

1. Pin the Bun base image by version and immutable digest after verifying the
   supported platform.
2. Use a dependency/build stage with `bun ci`, not `bun install`.
3. Copy package manifests first for cache stability, generate Prisma artifacts,
   compile/typecheck as required, and then copy only explicit worker/runtime
   source plus needed package outputs into a non-root runtime stage.
4. Do not `COPY . .`. Do not retain compilers, curl, pip caches, source maps,
   test fixtures, or package-manager caches in the final stage unless a measured
   runtime need exists.
5. Pin the YuNet model and font assets to immutable versions/commits and verify
   SHA-256 checksums. Remove the current best-effort font download behavior for
   required caption fonts: either include a verified asset or fail clearly.
6. Set a non-root user, read-only root filesystem where the platform supports
   it, a writable temporary/media work directory, explicit signal handling, and
   a documented FFmpeg/yt-dlp update policy.

Measure final image contents and size. Size reduction is secondary to an
auditable runtime closure, but an unexplained multi-gigabyte image is a failure.

## Phase 3: Close the accidental control surface

- Remove `/poll-once` from production builds, bind it to loopback/private admin
  infrastructure, or require a timing-safe authenticated request with replay
  protection. Prefer removal: the worker already polls on its own schedule.
- Split liveness from readiness. Liveness proves the process event loop is
  alive; readiness must become false when configuration is invalid or the queue
  poller has exceeded a bounded degraded threshold.
- Never include raw provider/database error text in health responses.
- Add request method/path tests and a production configuration test proving the
  manual trigger is unavailable to an unauthenticated caller.

## Phase 4: Freeze dependency policy and automate review

1. Replace all direct `"latest"` declarations with explicit compatible ranges
   or exact versions according to a documented policy. Align shared framework,
   React, Clerk, Prisma, Stripe, Zod, and type-package ranges across workspaces.
2. Preserve the intentional exact Chakra/Emotion pins and prove only one Chakra
   runtime resolves.
3. Add a scheduled dependency update workflow (Dependabot/Renovate or a small
   equivalent) that opens reviewable, grouped updates and runs every release
   gate. Major framework/auth/database upgrades remain separate migrations.
4. Make a frozen install and a no-lockfile-diff check mandatory locally/CI.

## Phase 5: CI release-artifact gates

Add a separate image job after source gates:

- build with BuildKit and no secret build args;
- fail if forbidden files/path names are present in any final layer;
- run a secret scanner on the build context and final image without printing
  findings' secret values;
- start the image with test-only configuration and verify liveness/readiness;
- verify FFmpeg, ffprobe, yt-dlp, fontconfig, required fonts, OpenCV, Prisma, and
  the worker entrypoint are available;
- run a tiny synthetic caption/font and media probe fixture;
- generate an SBOM and vulnerability report; fail on approved severity policy;
- publish only from an authorized release workflow and record digest/provenance.

## Documentation reconciliation

Update deployment docs from observed state in the same change:

- remove the stale “pending native social OAuth migration” claim after a fresh
  non-mutating status check;
- describe Redis database fallback accurately;
- identify Plans 027 and 029–031 as unresolved release blockers;
- document exact worker health/readiness expectations and image-build command;
- label current dubbing as beta/draft until Plan 026 is complete.

## Test plan

- Unit: worker health/readiness state and manual-trigger authentication/removal.
- Container: forbidden sentinel context, non-root user, read-only runtime,
  dependency/native-platform check, asset checksum failure, signal shutdown.
- Media smoke: one short audio/video probe and representative Latin/RTL/CJK/Indic
  font discovery/render check without a live provider call.
- Supply chain: frozen install, one Chakra copy, SBOM generation, no secret or
  forbidden path in image history/filesystem.
- Full gates: Biome, forced typecheck/test/build, production audit, image build
  and boot.

## Done criteria

- [ ] No `.env`, `.git`, host dependency/build directory, cache, or local media
  can enter the worker build context or final layers.
- [ ] `COPY . .` and mutable dependency install are absent.
- [ ] Required downloaded assets are immutable and checksum-verified.
- [ ] Final container runs non-root and starts/stops cleanly.
- [ ] Unauthenticated `/poll-once` is unavailable in production.
- [ ] CI builds, boots, scans, and inventories the exact release image.
- [ ] Direct `"latest"` declarations are gone and shared runtime versions align.
- [ ] Release documentation matches verified database/live-state/blocker truth.

## STOP conditions

- A required runtime file cannot be identified without copying the repository.
- A remote asset has no stable license/version/checksum provenance.
- The image or build cache was already pushed with real local `.env` files and
  credential rotation/inventory is not authorized.
- A scanner requires printing secret values into CI logs.
- Multi-architecture native dependencies cannot be validated on the deployment
  target.
- The change attempts a Clerk/Prisma/Next major upgrade inside this plan.
