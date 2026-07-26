# Plan 020: Fix streaming-SSR hydration mismatches, OAuth-start error UX, and missing favicon

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before the next step. Touch only in-scope
> files. On any STOP condition, stop and report — do not improvise.
>
> **Drift check**: excerpts from disk 2026-07-07 (uncommitted tree). The dev
> server may be running with HMR — that's fine, don't restart it.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (provider change affects every page's styling pipeline)
- **Depends on**: none
- **Category**: bug / ux
- **Planned at**: commit `05d273d` (working tree, 2026-07-07)

## Why this matters

Three user-visible defects found while running the app:

1. **Hydration mismatch on streamed pages.** React reports "Hydration failed…
   server rendered HTML didn't match the client" on authenticated pages (seen
   on `/settings/social` at `SectionHeader`), with the diff showing a server
   `<style data-emotion="css 44c6y4">` where the client expects
   `<div class="chakra-stack css-44c6y4">`. Root cause (verified): Emotion
   (under Chakra v3) emits inline `<style data-emotion>` tags in the HTML body
   during streaming SSR (`curl localhost:3000/ | grep -o '<style data-emotion'`
   → many). On the client, Emotion relocates those tags **once at cache
   creation**; tags arriving in **later Suspense chunks** (pages streaming
   behind `loading.tsx`) stay inline and break hydration, blowing away client
   state and spamming the console. The canonical fix is the Next.js App Router
   Emotion registry: a custom cache with `compat = true` whose styles are
   injected per-flush via `useServerInsertedHTML`, so no inline body style tags
   are emitted at all.
2. **OAuth connect renders raw JSON.** "Connect" on `/settings/social`
   full-page-navigates to `GET /api/social/oauth/start/:platform`; when it
   fails (e.g. `GOOGLE_CLIENT_ID` unset → `social_oauth_env_missing`), the
   handler returns 400 JSON and the user lands on a raw JSON page. The OAuth
   *callback* handler already does the right thing: redirect back to
   `/settings/social?error=<code>`, which `SocialAccountsPanel` renders as a
   friendly alert.
3. **No favicon.** Every page logs a 404 for `/favicon.ico`; there is no
   `apps/web/app/icon.*` or favicon anywhere — an unpolished detail on every
   browser tab.

## Current state

- `packages/ui/src/provider.tsx` (14 lines, "use client"):
  ```tsx
  export function Provider({ children }: { children: React.ReactNode }) {
    return (
      <ColorModeProvider>
        <ChakraProvider value={system}>{children}</ChakraProvider>
      </ColorModeProvider>
    )
  }
  ```
  Used by `apps/web/app/layout.tsx:20` wrapping `<ClerkProvider>{children}</ClerkProvider>`.
- `packages/ui/package.json` — has `@emotion/react` (resolves 11.x); does NOT
  declare `@emotion/cache` (present transitively; must be added as a direct dep).
- Emotion css-prop (which Chakra v3 uses) respects `@emotion/react`'s
  `CacheProvider` context, so wrapping the app in a custom cache provider
  redirects all Chakra style insertion through it.
- OAuth start handler `apps/web/app/api/[[...route]]/route.ts:1149-1178`:
  ```ts
  app.get("/social/oauth/start/:platform", async (c) => {
    ...
    try {
      const url = await socialOAuthService.createAuthorizationUrl({ ... });
      return c.redirect(url, 302);
    } catch (error) {
      return c.json(
        { error: error instanceof SocialOAuthError ? error.code : "social_oauth_start_failed",
          message: errorMessage(error) },
        400,
      );
    }
  });
  ```
  The callback handler directly below shows the redirect-with-error pattern to
  copy: `redirect.searchParams.set("error", ...); return c.redirect(redirect.toString(), 302);`
  and builds `new URL("/settings/social", origin)` via `getRequestOrigin(c.req.url)`.
- `packages/validators/src/error-messages.ts` — friendly code→message map,
  `userErrorMessage(code)` returns null for unknown codes. No `social_oauth_*`
  entries exist. The panel (`social-accounts-panel.tsx:100-111`) renders
  `userErrorMessage(errorCode) ?? "Social connection failed. Please try connecting again."`.
- No `apps/web/app/icon.svg` / `favicon.ico` exists (`GET /favicon.ico` → 404).
  Next 16 App Router convention: a file at `app/icon.svg` is served
  automatically as the site icon.
- Conventions: Chakra v3 semantic tokens; tests via `bun test`; structured
  code style enforced by Biome.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0, 10/10 |
| Tests | `bun run test` | all pass |
| Lint | `bunx @biomejs/biome check .` | exit 0 |
| Icon serves | `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/icon.svg` | 200 (dev server already running) |
| No inline styles | `curl -s http://localhost:3000/ \| grep -c '<style data-emotion'` | 0 inline occurrences in body chunks (allow the single registry-injected block; see Step 1 verify) |

## Scope

**In scope**:
- `packages/ui/src/emotion-cache-provider.tsx` (create)
- `packages/ui/src/provider.tsx` (wrap with the new provider)
- `packages/ui/package.json` (+ `@emotion/cache` dependency; then `bun install` to update `bun.lock`)
- `apps/web/app/api/[[...route]]/route.ts` (ONLY the oauth start catch block)
- `packages/validators/src/error-messages.ts` + its test (two `social_oauth_*` entries)
- `apps/web/app/icon.svg` (create)

**Out of scope**:
- ChakraProvider/theme/system config; ColorModeProvider; anything in the studio.
- Other route handlers; the OAuth callback (already correct).
- The `React.Children.only` console error (separate investigation — do NOT
  attempt drive-by fixes for it).

## Git workflow

Do NOT commit, branch, stash, or push. Edit the working tree directly; leave
changes uncommitted. `bun install` (to record the new dependency in `bun.lock`)
is allowed.

## Steps

### Step 1: Emotion cache registry provider

Create `packages/ui/src/emotion-cache-provider.tsx` ("use client") with the
canonical App Router Emotion registry (as used in the Next.js emotion example /
MUI's AppRouterCacheProvider):

```tsx
"use client"

import createCache from "@emotion/cache"
import { CacheProvider } from "@emotion/react"
import { useServerInsertedHTML } from "next/navigation"
import { useState } from "react"

export function EmotionCacheProvider({ children }: { children: React.ReactNode }) {
  const [registry] = useState(() => {
    const cache = createCache({ key: "css" })
    cache.compat = true
    const prevInsert = cache.insert
    let inserted: string[] = []
    cache.insert = (...args) => {
      const serialized = args[1]
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name)
      }
      return prevInsert(...args)
    }
    const flush = () => {
      const prev = inserted
      inserted = []
      return prev
    }
    return { cache, flush }
  })

  useServerInsertedHTML(() => {
    const names = registry.flush()
    if (names.length === 0) return null
    let styles = ""
    for (const name of names) {
      styles += registry.cache.inserted[name]
    }
    return (
      <style
        data-emotion={`${registry.cache.key} ${names.join(" ")}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    )
  })

  return <CacheProvider value={registry.cache}>{children}</CacheProvider>
}
```

Keep `key: "css"` (matches Emotion's default so client-side rehydration of the
registry-emitted blocks works). Adjust types as needed to satisfy the repo's
TS config (e.g. type the `insert` args via `Parameters<typeof prevInsert>`) —
do NOT `// @ts-ignore`; if `noExplicitAny` complains, type properly.

Then in `packages/ui/src/provider.tsx`, wrap the existing tree:

```tsx
return (
  <EmotionCacheProvider>
    <ColorModeProvider>
      <ChakraProvider value={system}>{children}</ChakraProvider>
    </ColorModeProvider>
  </EmotionCacheProvider>
)
```

Add `"@emotion/cache": "latest"` (match the style used for `@emotion/react` in
the same file) to `packages/ui/package.json` dependencies and run `bun install`.

**Verify**: `bun run typecheck` → exit 0. Then
`curl -s http://localhost:3000/ | grep -o '<style data-emotion="css [^"]*"' | head` —
the inline per-component tags in the body should be replaced by one-or-few
registry blocks; crucially
`curl -s http://localhost:3000/ | python3 -c "import sys; html=sys.stdin.read(); import re; print(len(re.findall(r'<style data-emotion', html)))"`
should drop dramatically vs. before (was ~dozens; expect a small handful of
consolidated blocks). If the count doesn't change at all, the cache isn't being
picked up — STOP.

### Step 2: OAuth start failure redirects with an error code

In the `app.get("/social/oauth/start/:platform", ...)` catch block
(route.ts ~line 1166), replace the `c.json(..., 400)` with the callback
handler's redirect pattern:

```ts
} catch (error) {
  const code =
    error instanceof SocialOAuthError ? error.code : "social_oauth_start_failed";
  const redirect = new URL(
    sanitizeRedirectPath(c.req.query("redirect")) ?? "/settings/social",
    getRequestOrigin(c.req.url),
  );
  redirect.searchParams.set("error", code);
  return c.redirect(redirect.toString(), 302);
}
```

Check how `sanitizeRedirectPath` behaves with undefined (read its definition in
the same file) and mirror its use in the try block; the fallback must be
`/settings/social`.

**Verify**: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "http://localhost:3000/api/social/oauth/start/linkedin?redirect=/settings/social"` →
`302` with a redirect_url containing `/settings/social?error=` **if** the dev
session cookie isn't required — this endpoint requires auth, so unauthenticated
curl returns 401; in that case verify by code-reading + typecheck and note it.
`bun run typecheck` → exit 0.

### Step 3: Friendly messages for the OAuth codes

In `packages/validators/src/error-messages.ts` add (match existing style):
- `social_oauth_env_missing` → "This platform's connection isn't configured on this server yet. Add the provider API credentials and try again."
- `social_oauth_start_failed` → "We couldn't start the connection flow. Please try again."

Extend `packages/validators/src/error-messages.test.ts` with the two codes
(model on the existing cases).

**Verify**: `bun run test` → all pass including the extended test.

### Step 4: App icon

Create `apps/web/app/icon.svg` — a simple, professional mark: rounded-square
dark background (`#0b0d10`), a bold "N" or a stylized play-cut glyph in the
accent color used by the app (check `packages/ui/src/theme.ts` for the accent
solid hex; if it's a token chain, use its resolved hex). Hand-write minimal
SVG (viewBox 0 0 32 32, no external fonts — use a `<path>` or simple shapes,
not `<text>` with a custom font).

**Verify**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/icon.svg` → 200 (Next serves app/icon.svg; give the dev server a moment to pick it up).

## Test plan

- Extended error-messages test (Step 3) is the only unit-test change.
- Full gate: `bun run typecheck` && `bun run test` && `bunx @biomejs/biome check .` all exit 0.
- Manual: load `http://localhost:3000/` and `/pricing` — no hydration errors in
  the terminal dev logs; styling fully intact (buttons, colors, layout — if the
  page renders unstyled, the cache wiring is wrong: STOP and report).

## Done criteria

- [ ] `bun run typecheck`, `bun run test`, `bunx @biomejs/biome check .` all exit 0
- [ ] `packages/ui/src/emotion-cache-provider.tsx` exists; `provider.tsx` wraps with it
- [ ] Inline `<style data-emotion` count in `curl -s localhost:3000/` output is consolidated (small handful, not dozens)
- [ ] Landing page renders with styling intact (visual check via curl for `css-` classes still present on elements)
- [ ] OAuth start catch block redirects (302) with `?error=<code>` instead of returning JSON
- [ ] Both new error codes return messages via `userErrorMessage`
- [ ] `GET /icon.svg` → 200
- [ ] Only in-scope files (+ `bun.lock`) modified

## STOP conditions

- After Step 1 the landing page loses styling (css classes present but no
  styles) — the registry is intercepting but not re-emitting; report.
- `useServerInsertedHTML` is unavailable from `next/navigation` in the ui
  package (peer dep issue) — report; do not move the provider into apps/web
  without flagging it.
- The inline style-tag count doesn't change after Step 1.
- `sanitizeRedirectPath` doesn't exist or behaves differently than the callback
  handler suggests.

## Maintenance notes

- The registry pattern makes Emotion streaming-safe app-wide; if Chakra ships
  first-class React 19.2 streaming support later, the provider can be removed
  in one place.
- The `React.Children.only` console error seen in dev logs is NOT addressed
  here — if it persists after this lands, capture the full stack from the
  browser console (the terminal truncates it) to locate the thrower.
- If a real brand icon is designed later, replace `app/icon.svg` (and add
  `apple-icon.png` sizes) — the convention handles the rest.
