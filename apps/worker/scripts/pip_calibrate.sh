#!/usr/bin/env bash
# H1 (adversarial review): calibrates pip_detect.py's `movingPxFrac` signal
# through the SAME 360p CRF-30 ultrafast proxy production actually analyzes,
# not just against raw source files.
#
# The spike's/landing-note's threshold-validation numbers were measured on
# RAW source files. But every real render calls `detectPipPath` against
# `extractFaceDetectionSegment`'s output, and that function re-encodes to a
# local proxy (`-vf scale=-2:360 -c:v libx264 -preset ultrafast -crf 30 -an`)
# whenever the clip's source is an HTTP(S) presigned URL — the common case
# in production; it only skips the proxy for an already-local file, which a
# real render essentially never has. A CRF-30/360p re-encode measurably
# changes fine-grained per-pixel motion (compression smooths high-frequency
# detail, downscale changes the pixel grid `MOVING_NOISE_FLOOR` is measured
# against), so `movingPxFrac` measured on the raw file is NOT necessarily
# representative of what `classifyScreencast` actually sees at render time.
#
# This script runs `pip_detect.py` on BOTH the raw input and the exact same
# proxy `extractFaceDetectionSegment` would produce, for one or more input
# videos, and prints a raw-vs-proxy table.
#
# Usage:
#   apps/worker/scripts/pip_calibrate.sh video1.mp4 [video2.mp4 ...]
#
# Env overrides:
#   PYTHON    - interpreter with opencv-python-headless + numpy installed
#               (default: python3)
#   DURATION  - seconds analyzed per video, from t=0 (default: 100000, i.e.
#               effectively "the whole file" — capped to each file's own
#               duration via ffprobe so every file is measured over its full
#               length by default; override for a shorter, uniform window)
#
# Requires ffmpeg/ffprobe on PATH.

set -euo pipefail

PYTHON="${PYTHON:-python3}"
DURATION_CAP="${DURATION:-100000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIP_DETECT="$SCRIPT_DIR/pip_detect.py"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 video1.mp4 [video2.mp4 ...]" >&2
  echo "  env: PYTHON=<interpreter> DURATION=<seconds, default: full file>" >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg/ffprobe not found on PATH" >&2
  exit 3
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

extract_field() {
  # $1 = json blob, $2 = field name -> prints the field's value, or "n/a"
  # if it's null/absent. Kept as a tiny inline python helper (not jq —
  # jq isn't guaranteed to be on PATH the way python already is here).
  "$PYTHON" -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print("error")
    raise SystemExit
v = d.get(sys.argv[2])
print("n/a" if v is None else v)
' "$1" "$2"
}

printf '%-38s %12s %12s %8s  %s\n' "file" "raw" "proxy" "ratio" "notes"
printf '%-38s %12s %12s %8s  %s\n' "----" "---" "-----" "-----" "-----"

for video in "$@"; do
  name="$(basename "$video")"

  full_dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")"
  dur="$DURATION_CAP"
  if awk -v a="$full_dur" -v b="$dur" 'BEGIN { exit !(a < b) }'; then
    dur="$full_dur"
  fi

  raw_json="$("$PYTHON" "$PIP_DETECT" "$video" 0 "$dur")"
  raw_frac="$(extract_field "$raw_json" movingPxFrac)"
  raw_insufficient="$(extract_field "$raw_json" insufficientSamples)"

  proxy_path="$TMP/${name%.*}-proxy.mp4"
  # Exactly extractFaceDetectionSegment's own ffmpeg invocation
  # (render-clips.ts), minus the HTTP-source-specific reconnect input flags
  # (irrelevant here — these are local files).
  ffmpeg -y -ss 0 -t "$dur" -i "$video" \
    -map 0:v:0 -vf scale=-2:360 \
    -c:v libx264 -preset ultrafast -crf 30 -an \
    "$proxy_path" >/dev/null 2>&1

  proxy_json="$("$PYTHON" "$PIP_DETECT" "$proxy_path" 0 "$dur")"
  proxy_frac="$(extract_field "$proxy_json" movingPxFrac)"
  proxy_insufficient="$(extract_field "$proxy_json" insufficientSamples)"

  ratio="n/a"
  notes=""
  if [ "$raw_insufficient" = "True" ] || [ "$proxy_insufficient" = "True" ]; then
    notes="insufficientSamples raw=$raw_insufficient proxy=$proxy_insufficient"
  elif [ "$raw_frac" != "n/a" ] && [ "$proxy_frac" != "n/a" ]; then
    ratio="$(awk -v r="$raw_frac" -v p="$proxy_frac" 'BEGIN { if (r == 0) print "n/a"; else printf "%.2f", p/r }')"
  fi

  printf '%-38s %12s %12s %8s  %s (window %.1fs)\n' "$name" "$raw_frac" "$proxy_frac" "$ratio" "$notes" "$dur"
done
