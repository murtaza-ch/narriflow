# Preview docs API origin cache regression

Verified on 2026-11-01 in isolated worktree `/tmp/narriflow-preview-docs-origin-cache`, branch `codex/preview-docs-origin-cache`, based on `4092951013b16582f0ba039b9926b1a58a0cd30f`. No cloud changes, browser use, credentials, dependency installation, or root source/cache writes were involved.

## Cause and fix

`source.config.ts` replaces API-origin placeholders while the Fumadocs webpack loader compiles MDX. The loader declares the generated config file as a dependency, but its contents do not change when `NEXT_PUBLIC_API_URL` changes. The environment read is therefore invisible to webpack's filesystem cache. A restored compiled module can retain the previous API base URL and OpenAPI link while newly evaluated response headers use the new origin.

The web webpack hook now appends the normalized API origin to the existing filesystem cache version. It preserves Next.js's version and cache settings. The same-origin warm build still hits the cache.

Webpack documents [`cache.version`](https://webpack.js.org/configuration/cache/#cacheversion) for invalidating incompatible cached output. Its [persistent caching guide](https://github.com/webpack/changelog-v5/blob/master/guides/persistent-caching.md#version) explicitly covers environment variables. Context7 returned no webpack library, so these official primary sources were used.

## Deterministic red and green

Run from the repository root with Bun 1.3.6:

```sh
bun test apps/web/docs-origin-cache.test.ts
```

The fixture invokes the installed Next.js webpack and the actual MDX rule/options produced by `next.config.ts`, compiling the unchanged real `content/docs/api/introduction.mdx`. It omits unrelated application compilation. Each build uses a fresh process. A single filesystem cache directory survives the origin A, origin B, and warm origin B builds; cleanup happens after the sequence.

Before the fix, the test failed in 1.04 seconds:

```text
expected href: https://origin-b.example.test/api/v1/openapi.json
actual href:   https://origin-a.example.test/api/v1/openapi.json
expected hasBaseUrl: true
actual hasBaseUrl:   false
0 pass, 1 fail
```

The initial probe also recorded webpack module `built: false, cached: true` on the failing B build. After the fix, the regression passed in 3.01 seconds. It checks the B base URL/link, preservation of the existing cache-version prefix, and a real filesystem cache hit for the final B build. Focused docs/CSP verification passed 7 tests; the complete web suite passed 1,025 tests and 3,716 assertions in 44.07 seconds.

## Production webpack verification

Used the pinned Bun executable `/tmp/narriflow-serverless-gates/bun-1.3.6/bun-darwin-aarch64/bun` and Node `/opt/homebrew/bin/node`. From `apps/web`, the build command was:

```sh
NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL=https://origin-a.example.test NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk bun run build --webpack
```

That publishable key is a public mock, not an account credential. Repeated the command with `NEXT_PUBLIC_API_URL=https://origin-b.example.test`, preserving `.next/cache` between builds and changing no source. Both builds passed compilation, TypeScript, and prerendering. Generated `/docs/api/introduction` HTML contained each build's matching base URL and OpenAPI link. Build B contained no origin A. Each build's routes manifest CSP admitted its matching HTTPS and WSS origins.

Generated HTML SHA-256:

| Build | SHA-256 |
| --- | --- |
| A | `e56ef672f979719a242547e238bfa8acd7c11e85afd91c93aae16c4f3c5c29f7` |
| B | `d9203eac0b1a22af2221f2e95c52f5f024e452384407276bd4ddea2f2d8c6e7e` |

The unpatched full builds did not reproduce stale server HTML locally: Fumadocs macro temporary-file build-dependency warnings prevented saving the server cache pack with this shared dependency installation. Those warnings existed before and after the fix. The narrow real-loader regression persisted its cache and reproduced the exact stale content, so it supplies the red/green evidence rather than claiming the full build reproduced it.

A production server on isolated loopback port 43871 returned HTTP 500 because Clerk middleware required its absent `secretKey`. No credential was loaded or requested. Thus runtime HTTP verification is limited; the generated HTML and routes-manifest checks passed. The isolated server was stopped afterward.

`bun run lint` exited 0 with 11 existing warnings and one informational diagnostic. Changed-file Biome verification was clean. `bun run check:web-split -- --bundle` passed. An initial lint invocation included disposable compiled probe output; that output was removed and lint rerun. No debug instrumentation remains.

## Local raw evidence

Raw logs and artifact summaries are under `/tmp/narriflow-preview-docs-origin-cache-evidence/` and are intentionally not committed:

| File | SHA-256 |
| --- | --- |
| `regression-red.log` | `f967e2aec092b93a5e41916116a4c93552865c5222f4f906c4306cef2fc994e1` |
| `regression-green.log` | `e4e63481c2cb0f101ec03baa25a9878f73e69f4baba217e2b2723d8195cda105` |
| `web-tests.log` | `943de5c3120630e41dc036e5d6f6a996d9047503be67b72ea537f2f0d54d5854` |
| `build-a-green-artifact.json` | `d15d11846a68d30451c9293311a98ecd5e6893aa660a43dc9e78938c0663f93c` |
| `build-b-green-artifact.json` | `f6daa4f6201d72a5a95204df190e0a263dd72a2420e3ea052fbb4af65af23f16` |

The MDX input remained SHA-256 `d67bc2cc62d3ac61b90e6a7b196babfddc470944e79f159ae7ec34eb42899447`. Root remained at the base commit with only the user's dirty `apps/api/scripts/dev.ts`, SHA-256 `e954c73b6d002318e16e9848645f34e821217649b2944968776f5266b6c73637`.
