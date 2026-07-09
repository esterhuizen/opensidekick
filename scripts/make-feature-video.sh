#!/usr/bin/env bash
# Assembles assets/feature-tour.mp4 from the raw material recorded by
# test/feature-video.mjs:  title card → side-by-side action scene (article page
# + side panel, aligned at their common end) → model card → end card.
#
# Usage:  [FFMPEG=/path/to/ffmpeg] scripts/make-feature-video.sh
set -euo pipefail
cd "$(dirname "$0")/.."

FFMPEG="${FFMPEG:-ffmpeg}"
RAW=assets/video-raw
OUT=assets/feature-tour.mp4
[ -f "$RAW/page.webm" ] || { echo "run: xvfb-run -a node test/feature-video.mjs first"; exit 1; }

# ffmpeg -i with no output exits 1 by design — don't let pipefail kill us.
dur() { ("$FFMPEG" -i "$1" 2>&1 || true) | grep -oE "Duration: [0-9:.]+" | sed -E 's/Duration: //; s/^0?0:0?0://' ; }
DP=$(dur "$RAW/page.webm"); DN=$(dur "$RAW/panel.webm")
# Align the two recordings at their shared END (they close together); take the
# common tail of both.
D=$(python3 -c "print(f'{min($DP,$DN)-0.15:.2f}')")
echo "page=${DP}s panel=${DN}s → common tail ${D}s"

"$FFMPEG" -y \
  -loop 1 -t 3.0 -i "$RAW/card-title.png" \
  -sseof -"$D" -i "$RAW/page.webm" \
  -sseof -"$D" -i "$RAW/panel.webm" \
  -loop 1 -t 3.5 -i "$RAW/card-model.png" \
  -loop 1 -t 3.5 -i "$RAW/card-end.png" \
  -filter_complex "\
[0:v]scale=1280:720,fps=25,format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4[c0];\
[1:v]fps=25[pg];\
[2:v]fps=25[pn];\
[pg][pn]hstack=inputs=2,format=yuv420p,setsar=1[sc];\
[3:v]scale=1280:720,fps=25,format=yuv420p,setsar=1[c1];\
[4:v]scale=1280:720,fps=25,format=yuv420p,setsar=1,fade=t=out:st=3.0:d=0.5[c2];\
[c0][sc][c1][c2]concat=n=4:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 20 -preset medium -movflags +faststart "$OUT" 2>/dev/null

("$FFMPEG" -i "$OUT" 2>&1 || true) | grep -E "Duration|Stream" | head -2
ls -lh "$OUT"
