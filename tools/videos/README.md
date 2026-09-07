# Narriflow marketing videos

This Remotion project produces the looping product demos used by the landing pages. It is outside the root Bun workspaces and has its own npm lockfile.

## Local preview

From the repository root:

```bash
cd tools/videos
npm ci
npm run dev
```

The compositions are registered in [src/Root.tsx](src/Root.tsx). Shared colors and typography live in [src/theme.ts](src/theme.ts).

| Composition ID | Output size | Frame rate |
| --- | --- | --- |
| `moment-detect` | 1600 × 1000 | 30 fps |
| `caption-loop` | 1080 × 1920 | 30 fps |
| `repurpose-burst` | 1200 × 1200 | 30 fps |

## Render

Run inside `tools/videos`:

```bash
npx remotion render moment-detect out/moment-detect.mp4
npx remotion render caption-loop out/caption-loop.mp4
npx remotion render repurpose-burst out/repurpose-burst.mp4
```

Preview the result before copying an updated asset to [apps/web/public/videos](../../apps/web/public/videos). Keep filenames aligned with the landing-page references.

## Verification

```bash
npm run lint
npm run build
```

These checks are separate from the root Turborepo commands.
