FROM oven/bun:1.3.6

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages packages

RUN bun install

COPY . .

EXPOSE 4001
CMD ["bun", "run", "apps/worker/src/index.ts"]
