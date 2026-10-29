# Every input below is pinned by apps/worker/runtime-lock.json (render golden
# parity, ticket 01). The values recover what was deployed on 2026-10-24; they
# are not an upgrade. Change them only together with the lock, a new golden
# baseline, and a reviewed reason. check-render-environment.ts enforces the lock
# at build time and at start.
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0-deno@sha256:a0b8b3a2926016ef15d9ff06b9b3f63b5f2785e63395be987114cee44ae66ac1 AS youtube_tokens
FROM oven/bun:1.3.6@sha256:f20d9cf365ab35529384f1717687c739c92e6f39157a35a95ef06f4049a10e4a

# The provider image pins Deno 2.9.5 and its npm dependencies. Keep the
# Python plugin on the same version as this server. It listens only on loopback.
COPY --from=youtube_tokens /usr/bin/deno /usr/local/bin/deno
COPY --from=youtube_tokens /app /opt/youtube-tokens
ENV YTDLP_POT_SERVER_HOME=/opt/youtube-tokens
ENV DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1

# The lock and its checker are copied before anything else so each install step
# below fails the build on drift instead of surfacing it as different pixels.
COPY apps/worker/runtime-lock.json apps/worker/scripts/check-render-environment.ts /opt/narriflow-runtime/

# ffmpeg for media processing; fontconfig + base fonts for caption
# burn-in; Noto core/extra cover representative Arabic, Hebrew and Indic
# scripts, while Noto CJK covers Chinese, Japanese and Korean glyphs. These
# packages provide glyph coverage only; script-aware cue behavior is separate.
# Caption display faces are vendored in packages/caption-fonts below.
# Packages come from the dated Debian snapshot the deployed image was built
# from; direct packages are version-pinned and every installed package is
# verified against the lock afterwards.
RUN set -eux; \
    rm -f /etc/apt/sources.list; \
    printf '%s\n' \
      'Types: deb' \
      'URIs: http://snapshot.debian.org/archive/debian/20261024T172700Z/' \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      '' \
      'Types: deb' \
      'URIs: http://snapshot.debian.org/archive/debian-security/20261024T172700Z/' \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=5 update; \
    apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
      ffmpeg=7:7.1.5-0+deb13u1 fontconfig=2.15.0-2.3 curl=8.14.1-2+deb13u7 \
      ca-certificates=20250419+deb13u1 python3=3.13.5-1 python3-pip=25.1.1+dfsg-1 \
      fonts-dejavu-core=2.37-8 fonts-liberation=1:2.1.5-3 fonts-noto-core=20201225-2 \
      fonts-noto-cjk=1:20240730+repack1-1 fonts-noto-extra=20201225-2 \
      fonts-noto-color-emoji=2.051-0+deb13u1; \
    rm -rf /var/lib/apt/lists/*

# Distribution packages lag YouTube extractor changes by months. Pin the
# upstream release that removed the broken android_vr default client and added
# working fallback clients for the August 2026 HTTP 403 regression. Auto-reframe:
# OpenCV YuNet face detector (CPU-only, MIT, ~232 KB) and numpy. Every wheel is
# pinned by version and SHA-256 in the lock; pip refuses anything else.
RUN bun /opt/narriflow-runtime/check-render-environment.ts --emit-pip-requirements > /tmp/requirements.lock \
  && pip3 install --no-cache-dir --break-system-packages --require-hashes --no-deps -r /tmp/requirements.lock \
  && rm /tmp/requirements.lock \
  && deno --version && yt-dlp --version

# Bake the tiny model into the image rather than fetching it at runtime, from an
# immutable upstream commit, and refuse any other bytes.
RUN mkdir -p /usr/local/share/narriflow \
  && curl -fsSL --retry 3 -o /usr/local/share/narriflow/face_yunet.onnx \
      "https://github.com/opencv/opencv_zoo/raw/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx" \
  && echo "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  /usr/local/share/narriflow/face_yunet.onnx" | sha256sum -c -
ENV REFRAME_MODEL_PATH=/usr/local/share/narriflow/face_yunet.onnx

# Fail the build, not renders, when the toolchain differs from the lock.
RUN bun /opt/narriflow-runtime/check-render-environment.ts --enforce --stage build

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages packages
# bun install applies the patchedDependencies listed in package.json.
COPY patches patches

RUN bun install --frozen-lockfile

COPY . .

# Fail the build, not YouTube intake at runtime, when the token provider cannot
# start from the files this image ships. This runs the worker's own launch code.
RUN bun apps/worker/scripts/check-youtube-token-server.ts
RUN bun apps/worker/scripts/check-render-environment.ts --enforce --stage image

EXPOSE 4001
# Railway sets its own start command (bun run apps/worker/src/index.ts), which
# replaces this CMD; ticket 17 calls assertRenderEnvironment() from the worker
# so the check holds there as well.
CMD ["sh", "-c", "bun apps/worker/scripts/check-render-environment.ts --enforce --stage start && exec bun run apps/worker/src/index.ts"]
