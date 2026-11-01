# Explicit moov and GOP seek gate

This four-case gate supplements the frozen 36-case golden suite. It does not
change that suite's manifest, reference capture, checker or renderer behavior.

Run from the committed repository root in the pinned render Linux image:

```sh
PYTHONPATH="$PWD/apps/media/python:$PWD" \
  python -m apps.media.python.gates.render_seek_matrix > /tmp/render-seek-matrix.json
```

The default verifies the locked render runtime before executing any case. For a
local diagnostic, append `--host`; its report has `pinnedRuntimeVerified: false`
and is not deployed-image acceptance. Both modes use only generated local media
and loopback conditional source/control servers. No DB, R2 or provider is used.

The matrix is head/tail `moov` crossed with closed 15/120-frame GOPs at 30 fps.
Each eight-second source contains a central per-frame luma clock and one timed
AAC burst. A textured outer field keeps the source larger than initial read-ahead.
The gate parses actual atom extents, checks `moov`/`mdat` ordering, checks every
decoded frame timestamp and keyframe index, and requires the tail index to lie
beyond the first 64 KiB. It never infers these facts from FFmpeg arguments alone.

Every case asks the actual native renderer for source frames 69–158, a three-second
edited caption-only window starting at 2.3 seconds, off-keyframe for both GOPs.
The test seam uses `run_render_group` and `ScopedSourceServer`, requires actual
process start, and checks exact ETag and bounded ranges, including a later range.
It validates the assembled uploaded artifact rather than an intermediate file.
Full decode must succeed, all 90 video frames must exist, both stream durations
must be three seconds within one video frame, and both stream clocks must start
at zero within that same tolerance.

The central 96×96 clock region remains source content after the square center
crop. Its middle 16×16 excludes texture, borders, captions and the corner watermark.
The first three decoded output luma means must match decoded source frames 69–71
within two 8-bit luma levels. Adjacent source frames differ by seven levels; each
fixture also proves that both a one-frame slip and a seek snapped to its preceding
keyframe exceed the tolerance. This admits small encoder rounding without hiding
a frame shift. Five-ms RMS blocks locate the actual decoded AAC burst; output
onset must equal source onset minus 2.3 seconds within one video frame. The oracle
unit tests reject frame/GOP shifts, audio shifts and mislabeled moov/GOP facts.

## Existing four-target proof

No new four-target fixture is needed. The exact baked `b7fdecf3` render-image
qualification ran the frozen `treatments-720p-watermark-1080p` case. Its four
targets all have encoder exit 0, successful full decode, accepted output validation
with no diagnostic codes, 120 decoded video frames, and four-second video/AAC
stream durations:

| Target | Output dimensions | Bytes |
| --- | --- | ---: |
| `v720wm` | 720×1280 | 816,591 |
| `s1080` | 1080×1080 | 1,563,186 |
| `l1080` | 1920×1080 | 2,143,392 |
| `l720wm` | 1280×720 | 1,149,378 |

Evidence is in `render/golden-capture.json`, under
`cases["treatments-720p-watermark-1080p"].targets`, from
`/tmp/narriflow-native-exact-b7fdecf3`. Its SHA-256 is
`88fc76cfcbc1b5e14b4240ecd9e4da72753f807ff5df9b571a86861c28d68dfd`.
The matching report SHA-256 is
`415cd6637b67d40f383139441bc562408d286548dd63fda47a36c9a8305c4172`.
The qualification and raw hashes are recorded in
`.scratch/serverless-cutover/evidence/exact-deployed-images-native-golden-b7fdecf3-20261101.json`.
This is controlled native golden evidence, not a live product pipeline claim.
