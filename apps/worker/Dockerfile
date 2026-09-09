FROM brainicism/bgutil-ytdlp-pot-provider:2.0.0-deno AS youtube_tokens
FROM oven/bun:1.3.6

# The provider image pins Deno 2.9.5 and its npm dependencies. Keep the
# Python plugin on the same version as this server. It listens only on loopback.
COPY --from=youtube_tokens /usr/bin/deno /usr/local/bin/deno
COPY --from=youtube_tokens /app /opt/youtube-tokens
ENV YTDLP_POT_SERVER_HOME=/opt/youtube-tokens
ENV DENO_NO_UPDATE_CHECK=1 DENO_NO_PROMPT=1

# ffmpeg for media processing; fontconfig + base fonts for caption
# burn-in; Noto core/extra cover representative Arabic, Hebrew and Indic
# scripts, while Noto CJK covers Chinese, Japanese and Korean glyphs. These
# packages provide glyph coverage only; script-aware cue behavior is separate.
# curl/ca-certificates fetch the Latin display fonts used by caption presets.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fontconfig curl ca-certificates python3 python3-pip \
    fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-cjk \
    fonts-noto-extra fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Distribution packages lag YouTube extractor changes by months. Pin the
# upstream release that removed the broken android_vr default client and added
# working fallback clients for the August 2026 HTTP 403 regression.
RUN pip3 install --no-cache-dir --break-system-packages \
      "yt-dlp[default]==2026.8.19" "bgutil-ytdlp-pot-provider==2.0.0" \
  && deno --version && yt-dlp --version

# Auto-reframe: OpenCV YuNet face detector (CPU-only, MIT, ~232 KB). Bake the
# tiny model into the image rather than fetching it at runtime.
RUN pip3 install --no-cache-dir --break-system-packages \
      opencv-python-headless numpy \
  && mkdir -p /usr/local/share/narriflow \
  && curl -fsSL --retry 3 -o /usr/local/share/narriflow/face_yunet.onnx \
      "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
ENV REFRAME_MODEL_PATH=/usr/local/share/narriflow/face_yunet.onnx

# Bundle the caption preset fonts so libass renders them instead of silently
# substituting a default. Best-effort: a font that fails to download falls back
# to fontconfig, but the build still succeeds.
RUN mkdir -p /usr/share/fonts/truetype/narriflow \
  && cd /usr/share/fonts/truetype/narriflow \
  && base="https://github.com/google/fonts/raw/main" \
  && for url in \
       "$base/ofl/bebasneue/BebasNeue-Regular.ttf" \
       "$base/ofl/anton/Anton-Regular.ttf" \
       "$base/ofl/oswald/Oswald%5Bwght%5D.ttf" \
       "$base/ofl/montserrat/Montserrat%5Bwght%5D.ttf" \
       "$base/ofl/roboto/Roboto%5Bwdth,wght%5D.ttf" \
       "$base/ofl/opensans/OpenSans%5Bwdth,wght%5D.ttf" ; do \
       curl -fsSL --retry 3 -O "$url" || echo "warn: font download failed for $url" ; \
     done \
  && fc-cache -f

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY packages packages

RUN bun install --frozen-lockfile

COPY . .

EXPOSE 4001
CMD ["bun", "run", "apps/worker/src/index.ts"]
