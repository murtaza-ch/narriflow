#!/usr/bin/env bash
# Throwaway look proof (ticket 02): backdrop, frames and render budget.
#   bash .scratch/dynamic-captions/references/proof/render.sh [videoDir]
# Run build.ts first. Videos go to videoDir (default $TMPDIR/narriflow-proof), never into this folder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
FONTS="$ROOT/packages/caption-fonts/fonts"
OUT="${1:-${TMPDIR:-/tmp}/narriflow-proof}"
mkdir -p "$OUT"

# 1. Backdrop: the green-studio preset thumbnail frame, scaled to 1080x1920 (source is 512x910, same 9:16).
ffmpeg -hide_banner -loglevel error -y -i "$ROOT/apps/web/public/images/caption-backdrops/green-studio.webp" \
  -vf "scale=1080:1920:flags=lanczos:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -q:v 5 "$HERE/backdrop.jpg"

# 2. Frames of the first cue, rendered at exact times: onset = the first 30 fps frame after the hero's
#    0.25 s onset (8/30 s, 17 ms into its entrance; at exactly 0.25 s its opacity is still 0), +100 ms, settled.
for spec in onset:0.266667 100ms:0.35 settled:1.2; do
  name="${spec%%:*}"; at="${spec##*:}"
  ffmpeg -hide_banner -loglevel error -y -i "$HERE/backdrop.jpg" \
    -vf "settb=1/1000000,setpts=$at/TB,ass=$HERE/headline.ass:fontsdir=$FONTS" -frames:v 1 "$HERE/frame-$name.png"
done

# 3. Budget: 20 s 1080x1920 at 30 fps. "encode" uses the worker's x264 defaults (clip-render-attempt.ts:
#    veryfast, crf 21) and writes an mp4 to $OUT; "filter" stops after the ass filter (-f null) to isolate libass.
#    Prints wall and CPU (user + sys) seconds per run; runs are interleaved so load drift hits all three alike.
render() { # mode, name, filter
  local times
  if [ "$1" = encode ]; then
    times=$( { /usr/bin/time -p ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 30 -t 20 -i "$HERE/backdrop.jpg" \
      -vf "$3" -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -r 30 "$OUT/$2.mp4"; } 2>&1 )
  else
    times=$( { /usr/bin/time -p ffmpeg -hide_banner -loglevel error -y -loop 1 -framerate 30 -t 20 -i "$HERE/backdrop.jpg" -vf "$3" -f null -; } 2>&1 )
  fi
  echo "$times" | awk '/^real/ {r=$2} /^user/ {u=$2} /^sys/ {s=$2} END {printf "wall %.2f cpu %.2f", r, u + s}'
}
for mode in encode filter; do
  for run in $(seq 1 "${RUNS:-3}"); do
    for name in none boldpop headline; do
      case "$name" in
        none) filter="null" ;;
        boldpop) filter="ass=$HERE/boldpop.ass:fontsdir=$FONTS" ;;
        headline) filter="ass=$HERE/headline.ass:fontsdir=$FONTS" ;;
      esac
      echo "$mode $name run $run $(render "$mode" "$name" "$filter")"
    done
  done
done
