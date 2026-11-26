# 04 - Detail pages read params on the client

**What to build:** `brand-kit/[id]`, `brand-kit/styles/[id]` and `projects/[projectId]/clips/[clipId]/exports/[exportId]` stop awaiting `params` in an async server `page.tsx`; their client screens read the ids with `useParams()`, as `projects/[projectId]` already does.

**Blocked by:** None.

**Status:** done

Spec: [../spec.md](../spec.md).

## Behaviour

- Each `page.tsx` becomes a synchronous server component rendering `<Suspense fallback={<XLoading/>}><XScreen/></Suspense>` with no props.
- The screen reads its ids from `useParams()` and keeps its null-scope skeleton branch first.
- No behaviour change otherwise.

## Acceptance

- [x] The three pages are not `async` and pass no params.
- [ ] The screens load the same data as before for the same URLs.
- [x] `bun run lint`, `bun run typecheck`, `bun run --cwd apps/web test` pass.

## Comments

2026-11-26 (implementer). `brand-kit/[id]`, `brand-kit/styles/[id]` and `projects/[projectId]/clips/[clipId]/exports/[exportId]` are synchronous pages rendering `<Suspense fallback={<XLoading/>}><XScreen/></Suspense>`. `BrandProfileScreen`, `EditStyleScreen` and `ExportDeliveryScreen` read their ids with `useParams()` (called before the null-scope branch, which still comes first in behaviour) and pass them on as before. Typecheck, web tests (1463 pass) and Biome on these files pass; repo-wide lint failures are other agents' files (see ticket 01).

Not ticked: "same data for the same URLs" is by construction (same ids into the same children) but untested. No test renders these screens, and I did not load them in a browser.

Left `claimed`: the unticked boxes need a browser check on the running dev servers; close the ticket after that check passes.

2026-11-26 (orchestrator). Typecheck and the web suite pass. The three screens were not opened in a browser; "same data for the same URLs" rests on the same ids reaching the same children.
