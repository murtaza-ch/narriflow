#!/usr/bin/env bash
# Throwaway look proof (ticket 02): backdrop, frames, contact sheet and render budget.
#   bash .scratch/dynamic-captions/references/proof/render.sh [videoDir]
# Run build.ts first. Videos and intermediate PNGs go to videoDir (default $TMPDIR/narriflow-proof),
# never into this folder. Frames are stored as JPEG quality 85 (sips). BUDGET=0 skips the timing runs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
FONTS="$ROOT/packages/caption-fonts/fonts"
OUT="${1:-${TMPDIR:-/tmp}/narriflow-proof}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="${PORT:-8765}"
mkdir -p "$OUT"
jpeg() { sips -s format jpeg -s formatOptions 85 "$1" --out "$2" >/dev/null; }

# 1. Backdrop: the green-studio preset thumbnail frame, scaled to 1080x1920 (source is 512x910, same 9:16).
ffmpeg -hide_banner -loglevel error -y -i "$ROOT/apps/web/public/images/caption-backdrops/green-studio.webp" \
  -vf "scale=1080:1920:flags=lanczos:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -q:v 5 "$HERE/backdrop.jpg"

# libass frame of headline.ass at an exact time.
ass_frame() { # time, png
  ffmpeg -hide_banner -loglevel error -y -i "$HERE/backdrop.jpg" \
    -vf "settb=1/1000000,setpts=$1/TB,ass=$HERE/headline.ass:fontsdir=$FONTS" -frames:v 1 "$2"
}

# 2. Frames of the first cue: onset = the first 30 fps frame after the hero's 0.25 s onset (8/30 s, 17 ms
#    into its entrance; at exactly 0.25 s its opacity is still 0), +100 ms, settled. libass, then the HTML
#    page in headless Chrome at the same playhead.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1
for spec in onset:0.266667 100ms:0.35 settled:1.2; do
  name="${spec%%:*}"; at="${spec##*:}"
  ass_frame "$at" "$OUT/frame-$name.png"
  jpeg "$OUT/frame-$name.png" "$HERE/frame-$name.jpg"
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1080,1920 \
    --virtual-time-budget=4000 --screenshot="$OUT/html-frame-$name.png" \
    "http://127.0.0.1:$PORT/.scratch/dynamic-captions/references/proof/headline.html?shot&t=$at" 2>/dev/null
  jpeg "$OUT/html-frame-$name.png" "$HERE/html-frame-$name.jpg"
done

# 3. Contact sheet: every cue settled (cue start + 1.5 s), cropped to the union of the blocks' bounds,
#    scaled to a third, tiled 4x3.
read -r CUES CROP_Y CROP_H < <(bun -e '
  const { cues } = await Bun.file(process.argv[1]).json();
  const tops = cues.flatMap((cue) => cue.words.map((word) => word.baselineY - word.inkTop));
  const bottoms = cues.flatMap((cue) => cue.words.map((word) => word.baselineY + word.inkBottom));
  const y = 6 * Math.floor((Math.min(...tops) - 140) / 6);
  const h = 6 * Math.ceil((Math.max(...bottoms) + 140 - y) / 6);
  console.log(cues.length, y, h);' "$HERE/cues.json")
for index in $(seq 0 $((CUES - 1))); do
  ass_frame "$(echo "$index * 1.65 + 1.5" | bc)" "$OUT/cue-$(printf %02d "$index").png"
done
ffmpeg -hide_banner -loglevel error -y -framerate 1 -i "$OUT/cue-%02d.png" \
  -vf "crop=1080:$CROP_H:0:$CROP_Y,scale=360:-2:flags=lanczos,tile=4x3" -frames:v 1 "$OUT/cues-settled.png"
jpeg "$OUT/cues-settled.png" "$HERE/cues-settled.jpg"

[ "${BUDGET:-1}" = 0 ] && exit 0

# 4. Budget: 20 s 1080x1920 at 30 fps. "encode" uses the worker's x264 defaults (clip-render-attempt.ts:
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
