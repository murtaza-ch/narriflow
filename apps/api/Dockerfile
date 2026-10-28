# Railway service @narriflow/api. Build context is the repository root:
#   docker build -f apps/api/Dockerfile .
# Repository root is /app and the API working directory is /app/apps/api, so
# `bun run --cwd apps/api smoke:native` and `bun apps/api/src/index.ts` both resolve.
FROM oven/bun:1.3.6

# ffmpeg for thumbnail extraction and visual probing; fontconfig + base fonts for
# font metadata checks; ca-certificates for TLS to Neon, R2, Clerk and providers.
# Worker-only media tooling (yt-dlp, Deno, OpenCV, the face model, the Noto bulk) is omitted.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fontconfig ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Every workspace manifest must be present for a frozen install.
COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages packages
# bun install applies the patchedDependencies listed in package.json.
COPY patches patches

# sharp, argon2 and the ffprobe binary install as platform-native optional packages.
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
WORKDIR /app/apps/api

# Fail the build, not review passcodes or thumbnails at runtime, when a native piece is broken.
RUN bun run smoke:native

EXPOSE 4000
CMD ["bun", "run", "src/index.ts"]
