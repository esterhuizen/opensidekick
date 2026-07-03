#!/usr/bin/env bash
# Regenerate the hero demo GIF (assets/demo.gif) from a fresh, deterministic
# recording of the real extension running a task.
#
# Requires: ffmpeg on PATH, and a browser for Playwright. On a headless server,
# this script runs the capture under xvfb automatically if xvfb-run is present.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN="node test/demo.mjs"
if command -v xvfb-run >/dev/null 2>&1 && [ -z "${DISPLAY:-}" ]; then
  RUN="xvfb-run -a --server-args=-screen 0 1500x900x24 $RUN"
fi

echo "Recording the panel…"
$RUN                                   # writes assets/demo-raw/panel.webm

VID=assets/demo-raw/panel.webm
PAL="$(mktemp --suffix=.png)"
echo "Encoding GIF…"
ffmpeg -y -i "$VID" -vf "fps=15,scale=460:-1:flags=lanczos,palettegen=stats_mode=diff" "$PAL"
ffmpeg -y -i "$VID" -i "$PAL" -lavfi "fps=15,scale=460:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=3" assets/demo.gif
rm -f "$PAL"
echo "Wrote assets/demo.gif"
